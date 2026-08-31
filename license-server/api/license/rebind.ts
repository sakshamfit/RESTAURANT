/**
 * POST /api/license/rebind — move a license to a new computer.
 * Verifies email ownership, updates the fingerprint, mints a fresh JWT.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ensureSchema, findKey, recordEvent, updateKey } from '../../lib/store';
import { computeExpiresAt, mintLicenseToken } from '../../lib/jwt';

interface RebindRequest {
  licenseKey?: string;
  email?: string;
  newFingerprint?: string;
}

const REBIND_WINDOW_MS = 5 * 60 * 1000; // rate limit
const rebindTracker = new Map<string, number>();

function getClientIp(req: VercelRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  if (Array.isArray(xff) && xff.length > 0) return xff[0];
  return (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as RebindRequest;
  const licenseKey = (body.licenseKey || '').trim().toUpperCase();
  const email = (body.email || '').trim().toLowerCase();
  const newFingerprint = (body.newFingerprint || '').trim();

  if (!licenseKey || !email || !newFingerprint) {
    return res.status(400).json({ error: 'licenseKey, email and newFingerprint are required.' });
  }

  // Per-key rate limit to discourage abuse.
  const last = rebindTracker.get(licenseKey) || 0;
  if (Date.now() - last < REBIND_WINDOW_MS) {
    return res.status(429).json({ error: 'Too many rebind attempts. Try again in a few minutes.' });
  }
  rebindTracker.set(licenseKey, Date.now());

  try {
    await ensureSchema();
  } catch {
    return res.status(503).json({ error: 'database is not configured.' });
  }

  const row = await findKey(licenseKey);
  if (!row) {
    return res.status(404).json({ errorCode: 'KEY_NOT_FOUND', error: 'License key does not exist.' });
  }
  if (row.status === 'revoked') {
    return res.status(403).json({ errorCode: 'KEY_REVOKED', error: 'This license key has been revoked.' });
  }
  if (row.email.toLowerCase() !== email) {
    return res.status(403).json({ errorCode: 'EMAIL_MISMATCH', error: 'This email does not match the key on file.' });
  }

  const { exp } = computeExpiresAt(row.plan, row.activated_at?.getTime() || Date.now());
  const token = mintLicenseToken({
    keyId: row.key_id,
    cafeName: row.cafe_name || 'Café',
    email: row.email,
    plan: row.plan,
    exp,
    fingerprint: newFingerprint,
    activated: true,
  });
  await updateKey(row.key_id, { fingerprint: newFingerprint });
  await recordEvent(row.key_id, 'rebind', { fingerprint: newFingerprint, ip: getClientIp(req) });

  return res.json({ ok: true, token });
}
