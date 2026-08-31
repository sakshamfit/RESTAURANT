/**
 * Postgres-backed license store. One row per key, one row per
 * activation / heartbeat / rebind / revoke event (so we have an
 * audit trail independent of the per-tenant audit log the
 * desktop app keeps).
 *
 * Connection: Vercel Postgres sets POSTGRES_URL automatically;
 * for self-hosted Postgres, set DATABASE_URL. If neither is set,
 * the server still works for reading but writes will throw — the
 * admin page shows a clear "Postgres not configured" message.
 */
import { Pool, type PoolConfig } from 'pg';

export interface LicenseKeyRow {
  key_id: string;
  email: string;
  plan: 'monthly' | 'yearly' | 'lifetime' | 'trial';
  status: 'active' | 'revoked';
  fingerprint: string | null;
  cafe_name: string | null;
  activated_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

export type LicenseEventType = 'activate' | 'heartbeat' | 'rebind' | 'revoke' | 'issue';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const config: PoolConfig = process.env.POSTGRES_URL
    ? { connectionString: process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false } }
    : process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
      : { host: 'localhost', port: 5432, database: 'nexoraosp_licenses', user: 'postgres' };
  pool = new Pool(config);
  return pool;
}

export async function isDatabaseConfigured(): Promise<boolean> {
  if (process.env.POSTGRES_URL || process.env.DATABASE_URL) return true;
  // Try localhost too, for local dev.
  try {
    const r = await getPool().query('SELECT 1');
    return r.rowCount === 1;
  } catch {
    return false;
  }
}

export async function ensureSchema(): Promise<void> {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS license_keys (
      key_id        text PRIMARY KEY,
      email         text NOT NULL,
      plan          text NOT NULL,
      status        text NOT NULL DEFAULT 'active',
      fingerprint   text,
      cafe_name     text,
      activated_at  timestamptz,
      expires_at    timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS license_keys_email_idx ON license_keys (lower(email));
    CREATE INDEX IF NOT EXISTS license_keys_status_idx ON license_keys (status);

    CREATE TABLE IF NOT EXISTS license_events (
      id            bigserial PRIMARY KEY,
      key_id        text,
      event         text NOT NULL,
      fingerprint   text,
      ip            text,
      user_agent    text,
      at            timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS license_events_key_idx ON license_events (key_id, at DESC);
  `);
}

export async function findKey(keyId: string): Promise<LicenseKeyRow | null> {
  const r = await getPool().query<LicenseKeyRow>(
    'SELECT * FROM license_keys WHERE key_id = $1',
    [keyId],
  );
  return r.rowCount && r.rowCount > 0 ? r.rows[0] : null;
}

export async function listKeys(opts: { limit?: number; status?: string } = {}): Promise<LicenseKeyRow[]> {
  const params: unknown[] = [];
  let where = '';
  if (opts.status) {
    params.push(opts.status);
    where = `WHERE status = $${params.length}`;
  }
  params.push(opts.limit && opts.limit > 0 ? Math.min(opts.limit, 500) : 200);
  const r = await getPool().query<LicenseKeyRow>(
    `SELECT * FROM license_keys ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

export async function insertKey(row: Omit<LicenseKeyRow, 'created_at'>): Promise<void> {
  await getPool().query(
    `INSERT INTO license_keys (key_id, email, plan, status, fingerprint, cafe_name, activated_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [row.key_id, row.email, row.plan, row.status, row.fingerprint, row.cafe_name, row.activated_at, row.expires_at],
  );
}

export async function updateKey(
  keyId: string,
  patch: Partial<Omit<LicenseKeyRow, 'key_id' | 'created_at'>>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (sets.length === 0) return;
  params.push(keyId);
  await getPool().query(
    `UPDATE license_keys SET ${sets.join(', ')} WHERE key_id = $${params.length}`,
    params,
  );
}

export async function recordEvent(
  keyId: string | null,
  event: LicenseEventType,
  meta: { fingerprint?: string; ip?: string; userAgent?: string } = {},
): Promise<void> {
  await getPool().query(
    `INSERT INTO license_events (key_id, event, fingerprint, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [keyId, event, meta.fingerprint || null, meta.ip || null, meta.userAgent || null],
  );
}

export async function listEvents(opts: { keyId?: string; limit?: number } = {}): Promise<Array<{
  id: number; key_id: string | null; event: string; fingerprint: string | null; ip: string | null; at: Date;
}>> {
  const params: unknown[] = [];
  let where = '';
  if (opts.keyId) {
    params.push(opts.keyId);
    where = `WHERE key_id = $${params.length}`;
  }
  params.push(Math.min(opts.limit && opts.limit > 0 ? opts.limit : 100, 500));
  const r = await getPool().query(
    `SELECT id, key_id, event, fingerprint, ip, at FROM license_events ${where}
     ORDER BY at DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}
