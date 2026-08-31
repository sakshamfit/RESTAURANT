/* eslint-disable */
/**
 * One-shot migration: create the license_keys + license_events tables.
 *
 *   POSTGRES_URL=postgres://... node scripts/migrate.js
 *   # or
 *   DATABASE_URL=postgres://... node scripts/migrate.js
 *
 * Idempotent: re-running on a populated database is a no-op.
 */
const { Pool } = require('pg');

const SCHEMA_SQL = `
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
`;

async function main() {
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('Set POSTGRES_URL or DATABASE_URL before running this script.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  console.log('Connected. Creating tables (idempotent)…');
  await pool.query(SCHEMA_SQL);
  console.log('Done. Tables ready.');
  await pool.end();
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
