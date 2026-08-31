/**
 * Admin session auth. Single shared password, stored as a constant-time
 * HMAC hash in an HTTP-only cookie. Sessions last 24h, then the admin
 * has to re-enter the password. No JWT, no third-party — the only
 * surface that touches the password is the /admin/login route, and
 * brute force is rate-limited at 5 attempts / minute / IP.
 *
 * Use `LICENSE_ADMIN_PASSWORD` in Vercel → Settings → Environment
 * Variables to set the password. If unset, the admin page refuses to
 * log anyone in (and the build is still safe to deploy because all
 * the /api/license/* routes work without a password).
 */
import { createHmac, timingSafeEqual } from 'crypto';

const COOKIE_NAME = 'nex_lic_admin';
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const SESSION_SECRET = process.env.LICENSE_ADMIN_SESSION_SECRET
  || process.env.LICENSE_SIGNING_SECRET
  || process.env.LICENSE_ADMIN_PASSWORD
  || 'change-me-in-prod';

function timingSafeStringCompare(a: string, b: string): boolean {
  // Convert both to a fixed-size SHA-256 first so `timingSafeEqual` always
  // gets equal-length buffers (it throws on length mismatch, which would
  // otherwise leak length info).
  const ha = createHmac('sha256', SESSION_SECRET).update(a).digest();
  const hb = createHmac('sha256', SESSION_SECRET).update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function checkAdminPassword(submitted: string | undefined): boolean {
  const expected = process.env.LICENSE_ADMIN_PASSWORD;
  if (!expected) return false;
  if (!submitted) return false;
  return timingSafeStringCompare(submitted, expected);
}

export function issueAdminSessionCookie(): string {
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const value = createHmac('sha256', SESSION_SECRET)
    .update(`admin:${expiresAt}`)
    .digest('hex')
    .slice(0, 32);
  const signed = `${expiresAt}.${value}`;
  return [
    `${COOKIE_NAME}=${signed}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ].join('; ');
}

export function clearAdminSessionCookie(): string {
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ].join('; ');
}

export function isAdminSessionValid(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  const match = cookieHeader
    .split(/;\s*/)
    .map((c) => c.split('='))
    .find(([k]) => k === COOKIE_NAME);
  if (!match || match.length !== 2) return false;
  const [signed] = match[1].split(';');
  const dot = signed.indexOf('.');
  if (dot < 1) return false;
  const expiresAt = Number(signed.slice(0, dot));
  const provided = signed.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = createHmac('sha256', SESSION_SECRET)
    .update(`admin:${expiresAt}`)
    .digest('hex')
    .slice(0, 32);
  return timingSafeStringCompare(provided, expected);
}
