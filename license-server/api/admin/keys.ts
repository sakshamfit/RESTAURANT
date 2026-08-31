/**
 * GET /api/admin/keys — list keys (auth required).
 * POST /api/admin/keys — issue a new key (auth required).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAdminSessionValid } from '../../lib/auth';
import { ensureSchema, insertKey, listKeys } from '../../lib/store';
import { generateLicenseKey } from '../../lib/issue';

const ALLOWED_PLANS = new Set(['monthly', 'yearly', 'lifetime', 'trial']);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAdminSessionValid(req.headers.cookie)) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  try {
    await ensureSchema();
  } catch (e) {
    return res.status(503).json({ error: 'database is not configured.', detail: (e as Error)?.message });
  }

  if (req.method === 'GET') {
    const keys = await listKeys({});
    return res.json({ keys });
  }

  if (req.method === 'POST') {
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { email?: string; plan?: string };
    const email = (body.email || '').trim().toLowerCase();
    const plan = (body.plan || '').trim().toLowerCase();
    if (!email || !plan) {
      return res.status(400).json({ error: 'email and plan are required.' });
    }
    if (!ALLOWED_PLANS.has(plan)) {
      return res.status(400).json({ error: 'plan must be one of monthly, yearly, lifetime, trial.' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'email looks invalid.' });
    }
    const keyId = generateLicenseKey();
    await insertKey({
      key_id: keyId,
      email,
      plan: plan as 'monthly' | 'yearly' | 'lifetime' | 'trial',
      status: 'active',
      fingerprint: null,
      cafe_name: null,
      activated_at: null,
      expires_at: null,
    });
    return res.json({ ok: true, keyId, email, plan });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
