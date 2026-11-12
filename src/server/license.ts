import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { readFile } from 'fs/promises';

// ── License configuration ───────────────────────────────────────────────────
//
// The desktop / web app is distributed under two modes:
//
//   1. License NOT required (default for self-hosted / dev):
//      - No `LICENSE_REQUIRED=true` env var.
//      - No license file is enforced; the app works as it always has.
//      - A user can still optionally activate a key from the Subscription
//        page to enable their account on your billing system.
//
//   2. License REQUIRED (used for distributed builds customers pay for):
//      - `LICENSE_REQUIRED=true`.
//      - The app refuses to load the admin console until a signed license
//        file is present on disk, valid, and not expired.
//      - A heartbeat re-validates against the central license server every
//        few hours when the device is online.
//
// The signing key is derived from `LICENSE_SIGNING_SECRET`. In production
// that must be a long random string set in your env (e.g. a Vercel env var).
// A stable, per-deployment fallback is derived from the data dir + an
// app-constant so that locally-developed builds never need a real secret.

const LICENSE_REQUIRED = process.env.LICENSE_REQUIRED === 'true';
const LICENSE_API_BASE = (process.env.LICENSE_API_BASE || 'https://license.nexoraosp.com').replace(/\/+$/, '');

/**
 * RSA public key (PEM) baked into distributed builds — the customer build
 * verifies license JWTs with this key and nothing else. The matching
 * PRIVATE key lives only on the central license server (Vercel env var
 * LICENSE_PRIVATE_KEY), so a customer who extracts everything out of the
 * installer still cannot mint license tokens. When unset (self-hosted /
 * dev builds) the app falls back to HS256 with the local signing secret,
 * which is fine because those builds never gate on a remote server.
 *
 * Env values arrive in two shapes: the real PEM (with newlines, CI reads
 * the file) or a single line with literal `\n` escapes (hand-editing an
 * env var). Both are normalized here.
 */
function normalizePem(value: string | undefined): string | null {
  if (!value || !value.trim()) return null;
  let pem = value.trim();
  if (!pem.includes('\n') && pem.includes('\\n')) pem = pem.replace(/\\n/g, '\n');
  if (!/-----BEGIN PUBLIC KEY-----/.test(pem)) return null;
  return pem;
}
const LICENSE_PUBLIC_KEY = normalizePem(process.env.LICENSE_PUBLIC_KEY);

/**
 * Length of the auto-issued trial license, in days. Set via
 * `LICENSE_TRIAL_DAYS=14` in the distributed build's env. When
 * `LICENSE_REQUIRED=true` and no license file is present, the app
 * auto-mints a trial of this length on first launch — the user can
 * keep using the admin console, with a "Subscribe now" banner showing
 * the days remaining.
 *
 * Special values:
 *   - `LICENSE_TRIAL_DAYS=0` → no trial offered; the user must
 *     activate a real key immediately.
 *   - `LICENSE_TRIAL_DAYS` unset → defaults to 14 days.
 */
const LICENSE_TRIAL_DAYS = (() => {
  const raw = process.env.LICENSE_TRIAL_DAYS;
  if (raw === undefined) return 14;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 14;
})();

function loadOrCreateSigningSecret(): string {
  const envSecret = process.env.LICENSE_SIGNING_SECRET;
  if (envSecret && envSecret.length >= 16) return envSecret;

  // Self-hosted dev: derive a stable per-machine secret from the data dir
  // (so the same machine signs + verifies its own tokens, but different
  // machines cannot forge each other's tokens). NEVER use this in the
  // distributed build — set LICENSE_SIGNING_SECRET in your env.
  const devSecretFile = path.join(
    process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/restaurant-data' : path.join(process.cwd(), 'data')),
    '.license-signing-secret',
  );
  try {
    const existing = fs.readFileSync(devSecretFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // File doesn't exist yet — create one.
  }
  const generated = `dev-${crypto.randomBytes(32).toString('hex')}`;
  try {
    fs.mkdirSync(path.dirname(devSecretFile), { recursive: true });
    fs.writeFileSync(devSecretFile, generated, { mode: 0o600, encoding: 'utf8' });
  } catch {
    // Filesystem not writable — fall back to an in-process secret (tokens
    // won't survive a restart, but the app still works for the current run).
    return generated;
  }
  return generated;
}

const SIGNING_SECRET = loadOrCreateSigningSecret();

// ── Public types ────────────────────────────────────────────────────────────

/** A license token's payload (the JWT body). */
export interface LicensePayload {
  /** Stable, opaque key id — what the customer bought. */
  keyId: string;
  /** Restaurant name shown in the admin header. */
  cafeName: string;
  /** Owner email, used for account recovery and machine rebind. */
  email: string;
  /** Plan: "trial" | "monthly" | "yearly" | "lifetime". */
  plan: string;
  /** Issued-at (ms since epoch). */
  iat: number;
  /** Hard expiry (ms since epoch). null = lifetime. */
  exp: number | null;
  /** First machine this license was bound to. */
  fingerprint: string;
  /** True when the central server confirmed activation. */
  activated: boolean;
}

export type LicenseStatus =
  | { state: 'not-required' }
  | { state: 'missing' }
  | { state: 'invalid'; reason: string }
  | { state: 'expired'; reason: string; gracePeriodEndsAt: number | null }
  | { state: 'active'; payload: LicensePayload; serverCheckedAt: number | null };

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

function licenseFilePath(): string {
  return path.join(
    process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/restaurant-data' : path.join(process.cwd(), 'data')),
    'license.json',
  );
}

// ── Activation (calls the central license server) ───────────────────────────
//
// In the distributed build, the customer's desktop app POSTs the license
// key + machine fingerprint to your license server. The server checks the
// key, marks it as bound to this fingerprint, and returns a signed JWT.
//
// In the local-dev / self-hosted build, the same `activate` flow works
// against your own server, OR the user can self-issue a key from the
// Subscription page (so you don't have to set up a server to test).

export interface ActivateRequest {
  licenseKey: string;
  email: string;
  cafeName: string;
  fingerprint: string;
}

export interface ActivateResponse {
  ok: boolean;
  token?: string;
  payload?: LicensePayload;
  error?: string;
  errorCode?: 'INVALID_KEY' | 'KEY_REVOKED' | 'KEY_BOUND_TO_OTHER_MACHINE' | 'NETWORK_ERROR' | 'SERVER_ERROR';
}

export async function activateLicense(req: ActivateRequest): Promise<ActivateResponse> {
  // Try the central license server first.
  try {
    const res = await fetch(`${LICENSE_API_BASE}/api/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<ActivateResponse> & { error?: string };
    if (res.ok && data.ok && data.token) {
      await writeLicenseFile(data.token, data.payload);
      return { ok: true, token: data.token, payload: data.payload };
    }
    return {
      ok: false,
      error: data.error || `Activation failed (HTTP ${res.status})`,
      errorCode: (data.errorCode as ActivateResponse['errorCode']) || 'SERVER_ERROR',
    };
  } catch (error) {
    // Network/server unreachable. We still allow a *self-hosted* path: if
    // a local signing secret is configured AND `LICENSE_ALLOW_SELF_ISSUE=true`,
    // the app will mint its own license for testing. This is a no-op in
    // distributed builds where the secret is centrally managed.
    if (process.env.LICENSE_ALLOW_SELF_ISSUE === 'true') {
      const selfIssued = selfIssueLicense(req);
      await writeLicenseFile(selfIssued.token, selfIssued.payload);
      return { ok: true, token: selfIssued.token, payload: selfIssued.payload };
    }
    return {
      ok: false,
      error: `Could not reach the license server (${(error as Error)?.message || error}). Check the device's internet connection and try again.`,
      errorCode: 'NETWORK_ERROR',
    };
  }
}

/**
 * Mint a license locally without contacting the central server. Only used
 * in self-hosted builds where `LICENSE_ALLOW_SELF_ISSUE=true` and the
 * central server is unreachable. The issued token is signed with the same
 * secret `verifyLicense()` uses, so it's fully functional — but it's not
 * tracked anywhere centrally.
 */
function selfIssueLicense(req: ActivateRequest): { token: string; payload: LicensePayload } {
  const now = Date.now();
  const isYearly = /(year|annual|yearly)/i.test(req.licenseKey);
  const isLifetime = /(lifetime|forever|unlimited)/i.test(req.licenseKey);
  const exp = isLifetime ? null : now + (isYearly ? 365 : 30) * 24 * 60 * 60 * 1000;
  const payload: LicensePayload = {
    keyId: req.licenseKey.toUpperCase().trim(),
    cafeName: req.cafeName.trim() || 'My Café',
    email: req.email.trim().toLowerCase(),
    plan: isLifetime ? 'lifetime' : isYearly ? 'yearly' : 'monthly',
    iat: now,
    exp,
    fingerprint: req.fingerprint,
    activated: true,
  };
  const token = jwt.sign(payload, SIGNING_SECRET, { algorithm: 'HS256' });
  return { token, payload };
}

// ── License file I/O ────────────────────────────────────────────────────────

/** What's on disk in `license.json`. Exported for the /api/license/start-trial route. */
export interface StoredLicense {
  /** The signed JWT. */
  token: string;
  /** Cached decoded payload, so we can render status offline. */
  payload: LicensePayload;
  /** When we last successfully called the central server's heartbeat. */
  serverCheckedAt: number | null;
}

async function readLicenseFile(): Promise<StoredLicense | null> {
  try {
    const raw = await readFile(licenseFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as StoredLicense;
    if (!parsed.token || !parsed.payload) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeLicenseFile(token: string, payload: LicensePayload): Promise<void> {
  const stored: StoredLicense = { token, payload, serverCheckedAt: Date.now() };
  const filePath = licenseFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(stored, null, 2), 'utf8');
  await fs.promises.rename(tmpPath, filePath);
}

export async function deleteLicenseFile(): Promise<void> {
  try {
    await fs.promises.unlink(licenseFilePath());
  } catch {
    // Already gone — fine.
  }
}

// ── Verification (offline, signature + expiry) ──────────────────────────────

/**
 * Idempotently issue a trial license. Called from `verifyLicense()` when
 * no license file exists and a trial is on offer. The trial is locked to
 * the current machine (its fingerprint is whatever the caller passes, or
 * a placeholder when called server-side without a fingerprint). Once
 * written, subsequent calls are a no-op — the existing trial token is
 * preserved so a user who reopens the app doesn't get a new 14-day clock
 * each time.
 */
async function startTrial(fingerprint: string): Promise<StoredLicense | null> {
  if (!LICENSE_REQUIRED || LICENSE_TRIAL_DAYS <= 0) return null;
  const existing = await readLicenseFile();
  if (existing) return existing; // Already activated or trialing — leave it alone.

  const now = Date.now();
  const payload: LicensePayload = {
    keyId: 'TRIAL',
    cafeName: 'My Café',
    email: 'trial@local',
    plan: 'trial',
    iat: now,
    exp: now + LICENSE_TRIAL_DAYS * 24 * 60 * 60 * 1000,
    fingerprint,
    activated: false,
  };
  const token = jwt.sign(payload, SIGNING_SECRET, { algorithm: 'HS256' });
  const stored: StoredLicense = { token, payload, serverCheckedAt: null };
  await writeLicenseFile(token, payload);
  return stored;
}

export async function verifyLicense(): Promise<LicenseStatus> {
  if (!LICENSE_REQUIRED) return { state: 'not-required' };

  let stored = await readLicenseFile();
  if (!stored) {
    // No license yet — start a trial if one is offered. The fingerprint
    // here is best-effort: server-side we don't have access to the
    // desktop app's machine ID, so we record a placeholder. On the
    // next /api/license/heartbeat (after the renderer reports the real
    // fingerprint through /api/license/activate), the placeholder gets
    // updated to the real one.
    stored = await startTrial('server-' + crypto.randomBytes(4).toString('hex'));
    if (!stored) return { state: 'missing' };
  }

  let payload: LicensePayload;
  try {
    // Distributed builds verify with the baked RSA public key (the server
    // signs with its private key). Self-hosted / dev builds use the local
    // HS256 secret, which is also what startTrial()/selfIssueLicense() mint.
    payload = LICENSE_PUBLIC_KEY
      ? (jwt.verify(stored.token, LICENSE_PUBLIC_KEY, { algorithms: ['RS256'] }) as LicensePayload)
      : (jwt.verify(stored.token, SIGNING_SECRET, { algorithms: ['HS256'] }) as LicensePayload);
  } catch (error) {
    return {
      state: 'invalid',
      reason: (error as Error)?.message || 'Signature could not be verified.',
    };
  }

  // Signature valid — now check expiry.
  if (payload.exp !== null && Date.now() > payload.exp) {
    const gracePeriodEndsAt = payload.exp + GRACE_PERIOD_MS;
    const inGrace = Date.now() < gracePeriodEndsAt;
    return {
      state: 'expired',
      reason:
        payload.plan === 'trial'
          ? `Your free trial ended on ${new Date(payload.exp).toLocaleDateString()}. Activate a license to keep using the admin console.`
          : `Your ${payload.plan} subscription expired on ${new Date(payload.exp).toLocaleDateString()}.`,
      gracePeriodEndsAt: inGrace ? gracePeriodEndsAt : null,
    };
  }

  return { state: 'active', payload, serverCheckedAt: stored.serverCheckedAt };
}

// ── Heartbeat (online re-validation against the central server) ─────────────

export interface HeartbeatResult {
  changed: boolean;
  status: LicenseStatus;
}

export async function heartbeat(): Promise<HeartbeatResult> {
  if (!LICENSE_REQUIRED) return { changed: false, status: { state: 'not-required' } };

  const stored = await readLicenseFile();
  if (!stored) return { changed: false, status: { state: 'missing' } };

  // If the token is already expired, no point asking the server — the user
  // needs to renew. Return immediately.
  if (stored.payload.exp !== null && Date.now() > stored.payload.exp + GRACE_PERIOD_MS) {
    return { changed: false, status: await verifyLicense() };
  }

  try {
    const res = await fetch(`${LICENSE_API_BASE}/api/license/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyId: stored.payload.keyId, fingerprint: stored.payload.fingerprint }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      status?: 'active' | 'revoked' | 'expired';
      newToken?: string;
    };
    if (res.ok && data.ok) {
      if (data.status === 'revoked') {
        // Server says this key was revoked (refund, chargeback, etc.).
        await writeLicenseFile(stored.token, {
          ...stored.payload,
          // Mark by setting exp to a value in the past.
          exp: Date.now() - 1,
        });
        return { changed: true, status: await verifyLicense() };
      }
      if (data.newToken) {
        // Server rotated the token (e.g. extended the plan). Persist it.
        const decoded = jwt.decode(data.newToken) as LicensePayload | null;
        if (decoded) {
          await writeLicenseFile(data.newToken, decoded);
        }
      } else {
        // Just refresh the server-checked timestamp.
        await writeLicenseFile(stored.token, stored.payload);
      }
      return { changed: true, status: await verifyLicense() };
    }
    // Server said "not ok" — fall through to local verify, which is the
    // source of truth for "is the JWT itself still valid".
    return { changed: false, status: await verifyLicense() };
  } catch {
    // Network error — local verify is good enough.
    return { changed: false, status: await verifyLicense() };
  }
}

// ── Reset binding (move license to a new machine) ───────────────────────────

export interface RebindRequest {
  licenseKey: string;
  email: string;
  newFingerprint: string;
}

export async function rebindLicense(req: RebindRequest): Promise<ActivateResponse> {
  try {
    const res = await fetch(`${LICENSE_API_BASE}/api/license/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<ActivateResponse>;
    if (res.ok && data.ok && data.token) {
      await writeLicenseFile(data.token, data.payload);
      return { ok: true, token: data.token, payload: data.payload };
    }
    return {
      ok: false,
      error: data.error || `Rebind failed (HTTP ${res.status})`,
      errorCode: (data.errorCode as ActivateResponse['errorCode']) || 'SERVER_ERROR',
    };
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach the license server: ${(error as Error)?.message || error}`,
      errorCode: 'NETWORK_ERROR',
    };
  }
}

// ── Exposed status helpers used by routes ───────────────────────────────────

export function isLicenseRequired(): boolean {
  return LICENSE_REQUIRED;
}

export function getTrialDays(): number {
  return LICENSE_TRIAL_DAYS;
}

export async function getStoredPayload(): Promise<LicensePayload | null> {
  const stored = await readLicenseFile();
  return stored?.payload || null;
}

export { SIGNING_SECRET as LICENSE_SIGNING_SECRET_FOR_TESTS };
// re-export for tests only
export { licenseFilePath as _licenseFilePathForTests };
