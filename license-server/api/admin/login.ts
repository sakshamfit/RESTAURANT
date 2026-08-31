/**
 * POST /api/admin/login — exchange the shared password for a session
 * cookie. Always returns the same shape; the only failure mode is
 * 401 (wrong password) or 503 (server has no admin password set).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkAdminPassword, issueAdminSessionCookie } from '../../lib/auth';

const FAILED_LOGIN_TRACKER = new Map<string, number>();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 5;

function getClientIp(req: VercelRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  if (Array.isArray(xff) && xff.length > 0) return xff[0];
  return (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.LICENSE_ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'LICENSE_ADMIN_PASSWORD is not configured on the server.' });
  }

  const ip = getClientIp(req);
  const last = FAILED_LOGIN_TRACKER.get(ip) || 0;
  if (Date.now() - last < RATE_WINDOW_MS && (FAILED_LOGIN_TRACKER.get(ip + ':hits') || 0) >= RATE_LIMIT) {
    return res.status(429).json({ error: 'Too many failed login attempts. Try again in a minute.' });
  }

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { password?: string };
  if (!checkAdminPassword(body.password)) {
    const hits = (FAILED_LOGIN_TRACKER.get(ip + ':hits') || 0) + 1;
    FAILED_LOGIN_TRACKER.set(ip + ':hits', hits);
    FAILED_LOGIN_TRACKER.set(ip, Date.now());
    return res.status(401).json({ error: 'Wrong password.' });
  }
  FAILED_LOGIN_TRACKER.delete(ip + ':hits');

  res.setHeader('Set-Cookie', issueAdminSessionCookie());
  return res.json({ ok: true });
}
