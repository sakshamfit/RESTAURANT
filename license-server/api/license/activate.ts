/**
 * POST /api/license/activate — first-time key activation.
 * Verifies the key, checks the fingerprint, mints a signed JWT.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ensureSchema, findKey, recordEvent, updateKey } from '../../lib/store';
import { computeExpiresAt, mintLicenseToken } from '../../lib/jwt';

interface ActivateRequest {
  licenseKey?: string;
  email?: string;
  cafeName?: string;
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

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as ActivateRequest;
  const licenseKey = (body.licenseKey || '').trim().toUpperCase();
  const email = (body.email || '').trim().toLowerCase();
  const cafeName = (body.cafeName || '').trim();
  const fingerprint = (body.fingerprint || '').trim();

  if (!licenseKey || !email || !cafeName || !fingerprint) {
    return res.status(400).json({ error: 'licenseKey, email, cafeName and fingerprint are required.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'email looks invalid.' });
  }

  try {
    await ensureSchema();
  } catch (e) {
    return res.status(503).json({ error: 'database is not configured.', detail: (e as Error)?.message });
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
  if (row.fingerprint && row.fingerprint !== fingerprint) {
    return res.status(409).json({
      errorCode: 'KEY_BOUND_TO_OTHER_MACHINE',
      error: 'This key is already bound to a different computer. Use Settings → Subscription → Transfer to a new computer to move it.',
    });
  }

  const { exp, expiresAt } = computeExpiresAt(row.plan);
  const token = mintLicenseToken({
    keyId: row.key_id,
    cafeName,
    email,
    plan: row.plan,
    exp,
    fingerprint,
    activated: true,
  });

  const now = new Date();
  await updateKey(row.key_id, {
    fingerprint,
    cafe_name: cafeName,
    activated_at: row.activated_at || now,
    expires_at: expiresAt,
  });
  await recordEvent(row.key_id, 'activate', {
    fingerprint,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] as string | undefined,
  });

  return res.json({
    ok: true,
    token,
    payload: {
      keyId: row.key_id,
      cafeName,
      email,
      plan: row.plan,
      iat: Date.now(),
      exp,
      fingerprint,
      activated: true,
    },
  });
}
