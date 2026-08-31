/**
 * JWT minting + verification. Same shape the desktop app expects
 * (see src/server/license.ts → LicensePayload). The shared secret
 * is LICENSE_SIGNING_SECRET — set it in Vercel once and bake the
 * same value into the desktop build via the build env.
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

function secret(): string {
  const s = process.env.LICENSE_SIGNING_SECRET;
  if (!s) throw new Error('LICENSE_SIGNING_SECRET is not set.');
  return s;
}

export function mintLicenseToken(payload: Omit<LicensePayload, 'iat' | 'exp'> & { exp: number | null }): string {
  const iat = Date.now();
  const full: LicensePayload = { ...payload, iat, exp: payload.exp };
  return jwt.sign(full, secret(), {
    algorithm: 'HS256',
    noTimestamp: true,
  });
}

export function verifyLicenseToken(token: string): LicensePayload | null {
  try {
    const decoded = jwt.verify(token, secret(), { algorithms: ['HS256'] }) as LicensePayload;
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
