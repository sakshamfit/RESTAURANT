import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// ── Single admin account ────────────────────────────────────────────────────
// There is exactly one admin and exactly one password. Nothing cloud-based:
// credentials live in data/admin.json (scrypt-hashed), created on first start
// from ADMIN_PASSWORD (or the built-in default). It can also be changed from
// Admin → Café Settings → Update Password, which writes data/admin.json.
const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@nexoraosp.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim() || '';
// Keep the documented development default for local use. Vercel deliberately
// refuses admin logins until ADMIN_PASSWORD is configured (see below).
const DEFAULT_ADMIN_PASSWORD = ADMIN_PASSWORD || '9852120609@';
const DATA_DIR =
  process.env.DATA_DIR ||
  (process.env.VERCEL ? '/tmp/restaurant-data' : path.join(process.cwd(), 'data'));
const CREDENTIALS_FILE = path.join(DATA_DIR, 'admin.json');

type AdminCredential = {
  email: string;
  passwordHash: string;
  passwordSalt: string;
  updatedAt: string;
};

let cached: AdminCredential | null = null;
let persistent = true;

/**
 * Do not silently expose the documented local-development password on a public
 * Vercel deployment. This is intentionally an admin-only 503: customer APIs
 * can still use the file-backed store while the operator fixes the environment.
 */
export function getAdminAuthConfigurationError(): string | null {
  if (process.env.VERCEL && !ADMIN_PASSWORD) {
    return 'Admin login is unavailable because ADMIN_PASSWORD is not configured. Set ADMIN_PASSWORD in Vercel Environment Variables, then redeploy.';
  }
  return null;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function randomSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}

async function writeCredentials(credential: AdminCredential): Promise<void> {
  if (!persistent) return;
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmpPath = `${CREDENTIALS_FILE}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(credential, null, 2), 'utf8');
    await fs.promises.rename(tmpPath, CREDENTIALS_FILE);
  } catch (error) {
    persistent = false;
    console.warn('[auth] Credential file not writable; keeping password in memory.', (error as Error)?.message || error);
  }
}

/** True if the given password matches the cached (saved) hash. */
function matchesSavedPassword(password: string): boolean {
  if (!cached) return false;
  const given = Buffer.from(hashPassword(password, cached.passwordSalt), 'hex');
  const expected = Buffer.from(cached.passwordHash, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Loads (or first-time creates) the credentials. Must be called once at startup. */
export async function initAdminAuth(): Promise<void> {
  if (cached) return;
  const configurationError = getAdminAuthConfigurationError();
  if (configurationError) console.error(`[auth] ${configurationError}`);
  try {
    const raw = await fs.promises.readFile(CREDENTIALS_FILE, 'utf8');
    cached = JSON.parse(raw) as AdminCredential;
    if (!cached?.passwordHash || !cached?.passwordSalt) throw new Error('Invalid credential file.');
  } catch {
    const salt = randomSalt();
    cached = {
      email: DEFAULT_ADMIN_EMAIL,
      passwordHash: hashPassword(DEFAULT_ADMIN_PASSWORD, salt),
      passwordSalt: salt,
      updatedAt: new Date().toISOString(),
    };
    await writeCredentials(cached);
    console.log(`[auth] Created single admin account (${CREDENTIALS_FILE}).`);
  }

  // An explicitly-set ADMIN_PASSWORD is the source of truth: if the saved
  // credentials were created with a different (old/changed) password, re-save
  // from the env so the operator can never be locked out by a stale
  // data/admin.json (or a stale /tmp copy on serverless hosts).
  if (ADMIN_PASSWORD && !matchesSavedPassword(ADMIN_PASSWORD)) {
    const salt = randomSalt();
    cached = {
      email: cached.email || DEFAULT_ADMIN_EMAIL,
      passwordHash: hashPassword(ADMIN_PASSWORD, salt),
      passwordSalt: salt,
      updatedAt: new Date().toISOString(),
    };
    await writeCredentials(cached);
    console.log('[auth] ADMIN_PASSWORD from environment differs from the saved password — re-saved credentials from env.');
  }
}

export function getAdminEmail(): string {
  return cached?.email || DEFAULT_ADMIN_EMAIL;
}

export function verifyAdminPassword(password: string): boolean {
  if (!password) return false;
  return matchesSavedPassword(password);
}

export async function changeAdminPassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; message: string }> {
  if (!verifyAdminPassword(currentPassword)) {
    return { ok: false, message: 'Current password is incorrect.' };
  }
  if (!newPassword || newPassword.length < 6) {
    return { ok: false, message: 'New password must be at least 6 characters.' };
  }
  const salt = randomSalt();
  cached = {
    ...(cached as AdminCredential),
    passwordHash: hashPassword(newPassword, salt),
    passwordSalt: salt,
    updatedAt: new Date().toISOString(),
  };
  await writeCredentials(cached as AdminCredential);
  return { ok: true, message: 'Password updated.' };
}

/** Stable HMAC key for admin session tokens. Survives restarts (data/admin.json). */
export function getAdminSessionSecret(): string {
  const envSecret = process.env.ADMIN_SESSION_SECRET || '';
  if (envSecret.length >= 16) return envSecret;
  return crypto
    .createHash('sha256')
    .update(`nagori-chai-admin-session-v2:${getAdminEmail()}`)
    .digest('hex');
}
