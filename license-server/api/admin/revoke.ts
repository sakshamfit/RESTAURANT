/**
 * POST /api/admin/revoke — set a key's status to 'revoked'. Once
 * revoked, the next heartbeat from the app will set the local
 * license to expired and the customer will be forced to re-activate
 * (which will now fail with KEY_REVOKED).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAdminSessionValid } from '../../lib/auth';
import { ensureSchema, findKey, recordEvent, updateKey } from '../../lib/store';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!isAdminSessionValid(req.headers.cookie)) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { keyId?: string };
  const keyId = (body.keyId || '').trim().toUpperCase();
  if (!keyId) return res.status(400).json({ error: 'keyId is required.' });

  try {
    await ensureSchema();
  } catch {
    return res.status(503).json({ error: 'database is not configured.' });
  }

  const row = await findKey(keyId);
  if (!row) return res.status(404).json({ error: 'Key not found.' });
  if (row.status === 'revoked') {
    return res.json({ ok: true, alreadyRevoked: true });
  }

  await updateKey(keyId, { status: 'revoked' });
  await recordEvent(keyId, 'revoke');
  return res.json({ ok: true });
}
