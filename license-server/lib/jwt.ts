/**
 * JWT minting + verification. Same shape the desktop app expects
 * (see src/server/license.ts → LicensePayload).
 *
 * Two signing modes:
 *
 * 1. RSA (recommended): set `LICENSE_PRIVATE_KEY` to the PEM private key.
 *    The desktop installer only ever carries the matching PUBLIC key
 *    (license-keys/public.pem in the app repo), so a customer cannot mint
 *    or forge tokens even by extracting every byte out of the installer.
 *    The private key lives ONLY here, as a Vercel env var.
 *
 * 2. Legacy shared secret: `LICENSE_SIGNING_SECRET` (HS256), used by
 *    existing deployments. This key has to be baked into the desktop build
 *    too, which means it can be extracted from an installer — fine for
 *    trials and internal builds, not ideal for paid customers.
 */
import jwt from 'jsonwebtoken';

export interface LicensePayload {
  keyId: string;
  cafeName: string;
  email: string;
  plan: 'monthly' | 'yearly' | 'lifetime' | 'trial';
  iat: number;
  exp: number | null;
  fingerprint: string;
  activated: boolean;
}

/** PEM values pasted into a dashboard can arrive with literal \n escapes. */
function normalizePem(value: string | undefined): string | null {
  if (!value || !value.trim()) return null;
  let pem = value.trim();
  if (!pem.includes('\n') && pem.includes('\\n')) pem = pem.replace(/\\n/g, '\n');
  return pem;
}

const LICENSE_PRIVATE_KEY = normalizePem(process.env.LICENSE_PRIVATE_KEY);

function signingKey(): { key: string; algorithm: 'RS256' | 'HS256' } {
  if (LICENSE_PRIVATE_KEY) {
    if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(LICENSE_PRIVATE_KEY)) {
      throw new Error('LICENSE_PRIVATE_KEY does not look like a PEM private key.');
    }
    return { key: LICENSE_PRIVATE_KEY, algorithm: 'RS256' };
  }
  const secret = process.env.LICENSE_SIGNING_SECRET;
  if (!secret) {
    throw new Error('Set LICENSE_PRIVATE_KEY (RSA, recommended) or LICENSE_SIGNING_SECRET (legacy HS256).');
  }
  return { key: secret, algorithm: 'HS256' };
}

export function mintLicenseToken(payload: Omit<LicensePayload, 'iat' | 'exp'> & { exp: number | null }): string {
  const iat = Date.now();
  const full: LicensePayload = { ...payload, iat, exp: payload.exp };
  const { key, algorithm } = signingKey();
  return jwt.sign(full, key, {
    algorithm,
    noTimestamp: true,
  });
}

export function verifyLicenseToken(token: string): LicensePayload | null {
  try {
    const { key, algorithm } = signingKey();
    const decoded = jwt.verify(token, key, { algorithms: [algorithm] }) as LicensePayload;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Map a (plan, now) pair to the JWT exp. Monthly = 30 days, yearly = 365
 * days, lifetime = null (the app treats null as no expiry). The server
 * stamps expires_at on the row too, so the admin can sort by "expiring
 * soon" in the dashboard.
 */
export function computeExpiresAt(plan: 'monthly' | 'yearly' | 'lifetime' | 'trial', fromMs = Date.now()): { exp: number | null; expiresAt: Date | null } {
  if (plan === 'lifetime') return { exp: null, expiresAt: null };
  if (plan === 'monthly') {
    const ms = fromMs + 30 * 24 * 60 * 60 * 1000;
    return { exp: ms, expiresAt: new Date(ms) };
  }
  if (plan === 'yearly') {
    const ms = fromMs + 365 * 24 * 60 * 60 * 1000;
    return { exp: ms, expiresAt: new Date(ms) };
  }
  // Trial
  const ms = fromMs + 14 * 24 * 60 * 60 * 1000;
  return { exp: ms, expiresAt: new Date(ms) };
}
