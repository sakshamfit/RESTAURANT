import fs from 'fs';
import path from 'path';

/**
 * Per-machine audit log for admin actions.
 *
 * Every admin API call that mutates state (order accept, product edit,
 * settings change, password change, license rebind, etc.) gets one line
 * appended to `data/audit.log`:
 *
 *   2026-01-15T10:23:45.123Z | admin@nexoraosp.com | desktop-abc123 | POST /api/admin/orders/ord-xyz/status
 *   2026-01-15T10:23:50.456Z | admin@nexoraosp.com | desktop-abc123 | PUT  /api/admin/settings
 *
 * The fingerprint is the same one used to bind the license, so a leaked
 * key can be traced back to the original buyer by grepping the file.
 *
 * The audit log is intentionally append-only and human-readable (one
 * JSON object per line). It's NOT meant for high-throughput analytics
 * (use a real database for that); it's a forensic tool for when you
 * need to answer "who did this, and from which machine".
 *
 * Disabled when LICENSE_REQUIRED is unset — no fingerprint means no
 * useful watermark.
 */

const AUDIT_ENABLED = process.env.LICENSE_REQUIRED === 'true';

function auditFilePath(): string {
  return path.join(
    process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/restaurant-data' : path.join(process.cwd(), 'data')),
    'audit.log',
  );
}

/**
 * Append one audit entry. Best-effort: if the disk is full or the file
 * can't be written, the request still goes through. The audit log
 * should never block a real customer's order.
 */
export function audit(
  adminEmail: string | undefined,
  fingerprint: string | undefined,
  method: string,
  requestPath: string,
  extra?: Record<string, unknown>,
): void {
  if (!AUDIT_ENABLED) return;
  const entry = {
    ts: new Date().toISOString(),
    admin: adminEmail || 'unknown',
    fingerprint: fingerprint || 'no-license',
    method: method.toUpperCase(),
    path: requestPath,
    ...(extra || {}),
  };
  try {
    const file = auditFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + String.fromCharCode(10), 'utf8');
  } catch (error) {
    // Don't crash on audit failure.
    console.warn('[audit] could not write entry:', (error as Error)?.message || error);
  }
}

/**
 * Express middleware that logs every admin request once it has been
 * authenticated (so we have the admin email + license fingerprint).
 * Applied after `requireAdmin` in the chain.
 */
export function auditMiddleware() {
  return function (req: any, _res: any, next: () => void) {
    // Only audit state-changing methods. GETs are too noisy and don't
    // change anything.
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const admin = req.adminUser?.email;
    const license = req.licensePayload;
    const fingerprint = license?.fingerprint;
    audit(admin, fingerprint, method, req.originalUrl || req.url);
    next();
  };
}
