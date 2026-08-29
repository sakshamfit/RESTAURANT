#!/usr/bin/env node
/**
 * Applies supabase/schema.sql to the configured Postgres database.
 *
 * Usage (from the repository root):
 *   node supabase/migrate.mjs
 *
 * Reads DIRECT_URL (falling back to DATABASE_URL) from the root .env file.
 * The schema is idempotent — safe to re-run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import net from 'node:net';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('No database URL found. Set DIRECT_URL (or DATABASE_URL) in .env first.');
  process.exit(1);
}

const sql = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');

// Negotiate TLS when the server offers it (Supabase always does), else fall back
// to a plain connection for non-TLS servers.
// node-postgres ignores a `family` config option, so wrap the socket to force IPv4.
function ipv4SocketFactory() {
  return () => {
    const socket = new net.Socket();
    const originalConnect = socket.connect.bind(socket);
    socket.connect = (port, host, callback) => originalConnect({ port, host, family: 4 }, callback);
    return socket;
  };
}
function clientOptions() {
  const base = { connectionString: url, family: 4, stream: ipv4SocketFactory(), connectionTimeoutMillis: 20000 };
  if (sslMode === 'tls') base.ssl = { rejectUnauthorized: false };
  return base;
}
let sslMode = null;
async function resolveSsl() {
  if (sslMode) return sslMode;
  const probe = new pg.Client({ connectionString: url, family: 4, stream: ipv4SocketFactory(), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  try {
    await probe.connect();
    await probe.end();
    sslMode = 'tls';
  } catch (error) {
    if (/does not support (SSL|TLS)/i.test(error.message)) sslMode = 'none';
    else throw error;
  }
  return sslMode;
}
await resolveSsl();
const client = new pg.Client(clientOptions());

try {
  await client.connect();
  console.log('Connected to Postgres.');
  console.log('Applying supabase/schema.sql ...');
  await client.query(sql);

  const tables = await client.query(
    `select table_name from information_schema.tables where table_schema = 'public' and table_name like 'app_%' order by 1`
  );
  console.log('Schema applied. Tables: ' + tables.rows.map((r) => r.table_name).join(', '));
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
