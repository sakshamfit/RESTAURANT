/**
 * POST /api/admin/logout — clear the session cookie.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { clearAdminSessionCookie } from '../../lib/auth';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Set-Cookie', clearAdminSessionCookie());
  return res.json({ ok: true });
}
