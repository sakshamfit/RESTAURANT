/**
 * POST /api/license/heartbeat — every ~6h from the desktop app.
 * Returns a refreshed JWT if the key is still active, or revoked
 * status so the app kills its local license.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ensureSchema, findKey, recordEvent, updateKey } from '../../lib/store';
import { computeExpiresAt, mintLicenseToken } from '../../lib/jwt';

interface HeartbeatRequest {
  keyId?: string;
  fingerprint?: string;
}

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

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as HeartbeatRequest;
  const keyId = (body.keyId || '').trim().toUpperCase();
  const fingerprint = (body.fingerprint || '').trim();

  if (!keyId || !fingerprint) {
    return res.status(400).json({ ok: false, error: 'keyId and fingerprint are required.' });
  }

  try {
    await ensureSchema();
  } catch {
    return res.status(503).json({ ok: false, error: 'database is not configured.' });
  }

  const row = await findKey(keyId);
  if (!row) {
    return res.status(404).json({ ok: false, status: 'unknown' });
  }
  if (row.status === 'revoked') {
    await recordEvent(row.key_id, 'heartbeat', { fingerprint, ip: getClientIp(req) });
    return res.json({ ok: true, status: 'revoked' });
  }
  if (row.fingerprint && row.fingerprint !== fingerprint) {
    return res.json({ ok: true, status: 'wrong-machine' });
  }

  // Still active — refresh the JWT in case the plan was extended.
  const { exp, expiresAt } = computeExpiresAt(row.plan, row.activated_at?.getTime() || Date.now());
  const token = mintLicenseToken({
    keyId: row.key_id,
    cafeName: row.cafe_name || 'Café',
    email: row.email,
    plan: row.plan,
    exp,
    fingerprint,
    activated: true,
  });
  if (expiresAt && (!row.expires_at || row.expires_at.getTime() !== expiresAt.getTime())) {
    await updateKey(row.key_id, { expires_at: expiresAt });
  }
  await recordEvent(row.key_id, 'heartbeat', { fingerprint, ip: getClientIp(req) });

  return res.json({ ok: true, status: 'active', newToken: token });
}
