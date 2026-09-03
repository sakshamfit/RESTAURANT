import net from 'net';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { readFile } from 'fs/promises';
import dotenv from 'dotenv';

dotenv.config();
// Explicit .js specifiers + type-only imports where only types are used: the
// Vercel Function graph runs as native ESM, where extensionless relative
// imports fail with ERR_MODULE_NOT_FOUND.
import type { AppSnapshot } from './seed.js';
import { createMemorySnapshot, initialCategories, initialProducts, initialSettings, initialTables } from './seed.js';
import type { CafeCategory, CafeSettings, CafeTable, CustomerFeedback, Order, Product, WaiterCall } from '../types.js';

export type StoreCollection = 'categories' | 'tables' | 'products' | 'orders' | 'feedbacks' | 'waiterCalls';
export type StoreProvider = 'postgres' | 'file';

/** Which step of the Postgres bootstrap failed (surfaced via /api/health). */
export type PostgresPhase =
  | 'ssl-probe'
  | 'connect'
  | 'schema-check'
  | 'schema-apply'
  | 'seed'
  | 'counter'
  | 'unknown';

/** Non-secret diagnostics about the store, exposed by the health endpoint. */
export interface StoreDiagnostics {
  provider: StoreProvider;
  postgresConfigured: boolean;
  /** Hostname only — never credentials. */
  postgresHost: string;
  postgresStatus: 'connected' | 'unavailable' | 'not-configured';
  postgresError: {
    message: string;
    code?: string;
    phase: PostgresPhase;
    at: string;
    /** Plain-English, actionable explanation of the failure and how to fix it. */
    hint?: string;
  } | null;
  postgresRecoveryAttempts: number;
  postgresLastProbeAt: string | null;
  dataFile: string;
  ephemeral: boolean;
}

type CollectionModel = {
  categories: CafeCategory;
  tables: CafeTable;
  products: Product;
  orders: Order;
  feedbacks: CustomerFeedback;
  waiterCalls: WaiterCall;
};

type DataRow<T> = {
  id: string;
  data: T;
  created_at?: string;
  updated_at?: string;
};

const TABLES: Record<StoreCollection, string> = {
  categories: 'app_categories',
  tables: 'app_tables',
  products: 'app_products',
  orders: 'app_orders',
  feedbacks: 'app_feedbacks',
  waiterCalls: 'app_waiter_calls',
};

// ── Local JSON file persistence (default, no cloud needed) ──────────────────
const DATA_DIR =
  process.env.DATA_DIR ||
  (process.env.VERCEL ? '/tmp/restaurant-data' : path.join(process.cwd(), 'data'));
const DATA_FILE = path.join(DATA_DIR, 'restaurant.json');

type DataFile = {
  settings: CafeSettings;
  categories: CafeCategory[];
  tables: CafeTable[];
  products: Product[];
  orders: Order[];
  feedbacks: CustomerFeedback[];
  waiterCalls: WaiterCall[];
  counters: { orders: number };
};

/**
 * Errors that prove this filesystem can never hold our data. Anything else
 * (ENOENT, EAGAIN, EBUSY, EMFILE, …) is transient and MUST be retried: treating
 * those as fatal permanently switched the store to memory-only and silently
 * dropped every later order/feedback.
 */
const FATAL_PERSIST_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'ENOTDIR']);

function isFatalPersistError(error: any): boolean {
  return FATAL_PERSIST_CODES.has(String(error?.code || ''));
}

// ── Direct Postgres persistence (optional, lazy-loaded) ─────────────────────
// pg is imported dynamically only when DATABASE_URL is set, so the module
// never fails to load on platforms like Vercel where pg may not be bundled.
/**
 * DATABASE_URL as pasted into a dashboard commonly arrives with surrounding
 * quotes or stray whitespace (copying a `.env`-style line verbatim), which
 * corrupts the password and fails with a confusing 28P01. Normalize once at
 * module load so the value used everywhere is the one the provider issued.
 */
function normalizeConnectionString(name: string, rawValue: string): string {
  let value = rawValue.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
    console.warn(`[store] Removed surrounding quotes from ${name} (a common copy-paste slip when pasting .env lines into a dashboard).`);
  }
  return value;
}

const pgUrl = normalizeConnectionString('DATABASE_URL', process.env.DATABASE_URL || '');
const pgDirectUrl = normalizeConnectionString('DIRECT_URL', process.env.DIRECT_URL || '') || pgUrl;
export const postgresConfigured = Boolean(pgUrl);

/** Validates the configured URL as early as possible (cheap, no network). */
function pgUrlParseError(connectionString: string): string | null {
  try {
    const url = new URL(connectionString);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      return `DATABASE_URL must start with postgres:// or postgresql:// (found "${url.protocol}").`;
    }
    if (!url.hostname) return 'DATABASE_URL has no hostname.';
    return null;
  } catch (error) {
    return `DATABASE_URL could not be parsed as a connection string: ${(error as Error)?.message || error}. Re-copy it from your database provider dashboard.`;
  }
}

/**
 * Turns a Postgres failure into a plain-English, actionable hint, surfaced by
 * /api/health and the admin warning banner. Never includes credentials.
 * Exported so the mapping itself can be unit-tested without a live database.
 */
export function pgErrorHint(error: { code?: string; message: string }, host: string, phase: PostgresPhase): string {
  const message = error.message || '';
  const code = error.code || '';
  const provider = /supabase/i.test(host) ? 'Supabase' : /neon/i.test(host) ? 'Neon' : 'your Postgres provider';

  if (code === '28P01') {
    if (/supabase/i.test(host)) {
      return (
        `Supabase rejected the login: the password in DATABASE_URL is wrong or stale, or the username is missing its project ref ` +
        `(it must be the full \`postgres.<project-ref>\` from the connection string — not just \`postgres\`). ` +
        `Fix: Supabase → Project → Settings → Database → Connection string → copy the current Session pooler URI and paste it ` +
        `verbatim into Vercel → Settings → Environment Variables → DATABASE_URL (and DIRECT_URL if set), then redeploy.`
      );
    }
    return (
      `${provider} rejected the password in DATABASE_URL (the password is wrong or was rotated after the URL was saved). ` +
      `Copy the current connection string from your provider dashboard into Vercel → Settings → Environment Variables → DATABASE_URL, then redeploy.`
    );
  }
  if (code === 'INVALID_DATABASE_URL') {
    // The message produced by pgUrlParseError already says exactly what is wrong and what to do.
    return message;
  }
  if (code === '3D000') {
    return `The database named in DATABASE_URL does not exist (or was renamed/deleted). Check the database name in the connection string and that the project is still running.`;
  }
  if (code === '53300' || /too many clients|too many connections/i.test(message)) {
    return `The database hit its connection limit (free tiers cap total connections across all serverless instances). The backend now keeps at most 5 connections per instance and retries automatically — if this keeps happening, use your provider's pooled connection string (e.g. Supabase Session pooler, port 6543) as DATABASE_URL and redeploy.`;
  }
  if (code === '57P03' || /starting up|crash|recovery/i.test(message)) {
    return `The database is asleep or starting up (free ${provider} projects pause when idle). The backend retries automatically and will connect as soon as it wakes.`;
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return `The host in DATABASE_URL could not be resolved. Re-copy the connection string from your provider dashboard (a hand-edited hostname is usually the cause).`;
  }
  if (
    /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|network is unreachable|connect ETIMEDOUT|timeout expired|timed out|Connection terminated unexpectedly/i.test(
      message
    )
  ) {
    if (/pooler\.supabase\.com/i.test(host)) {
      const poolerPrefix = host.split('-').slice(0, 2).join('-');
      return (
        `The Supabase connection pooler at ${host} accepted no connection before the timeout. The usual cause is a stale pooler ` +
        `hostname: Supabase assigns each project a numbered pooler (e.g. aws-0-…, aws-1-…) and projects get moved between them, ` +
        `so a URL saved months ago can point at the wrong one (currently "${poolerPrefix}"). It also happens when the project is ` +
        `paused — free projects pause after ~1 week idle and refuse all connections until restored. ` +
        `Fix: open Supabase → your project (restore it if the dashboard shows "Paused") → Settings → Database → Connection string → ` +
        `Session pooler, copy the URI verbatim, paste it into Vercel → Settings → Environment Variables → DATABASE_URL, then redeploy.`
      );
    }
    return `The database host could not be reached. Check that the host/port in DATABASE_URL match the provider dashboard and that the provider allows connections from anywhere (${provider} defaults allow this).`;
  }
  if (/does not support SSL|SSL is not enabled|no pg_hba/i.test(message)) {
    return `The database server refused the SSL handshake the app requires. Use the provider's TLS-enabled host (e.g. the pooler host on port 6543 for Supabase) in DATABASE_URL.`;
  }
  if (/The connection string must start with|password is missing|missing password|no password/i.test(message)) {
    return `DATABASE_URL is not a valid Postgres connection string (missing scheme or password). Copy it verbatim from your provider dashboard — it must look like postgresql://user:password@host:5432/dbname.`;
  }
  if (/pgbouncer|cannot run|prepared statement/i.test(message)) {
    return `A pooler URL was used for an operation that needs a direct connection. Set DATABASE_URL to the pooler URI (port 6543) and DIRECT_URL to the direct URI (port 5432) from your provider dashboard.`;
  }
  if (/self-signed|self signed|unable to verify the first certificate|DEPTH_ZERO|CERT_HAS_EXPIRED/i.test(message)) {
    return `The database TLS certificate could not be verified. If the provider was recently migrated/changed regions, re-copy the connection string and redeploy.`;
  }
  if (/password authentication failed/i.test(message)) {
    // Same class as 28P01 but reported without a SQLSTATE.
    return `The database rejected the password in DATABASE_URL. Copy the current connection string from your provider dashboard and update DATABASE_URL in Vercel, then redeploy.`;
  }
  return `The database connection failed during the '${phase}' step. Check that DATABASE_URL in Vercel matches the provider dashboard exactly, then redeploy.`;
}

const PG_FAMILY = 4;
// Kept well under the serverless request budget: a single cold start may chain
// an SSL probe + a schema query, and each one waiting 15s used to blow past the
// function's maxDuration before any response was written.
const PG_TIMEOUT_MS = Number(process.env.PG_CONNECT_TIMEOUT_MS || 5000);
/**
 * Hard ceiling for one complete Postgres bootstrap attempt. Unreachable hosts
 * fail by timing out (not by refusing), so without an overall deadline the
 * chain of probe → schema check → seed can stall far longer than any single
 * connectionTimeoutMillis suggests.
 */
const PG_BOOTSTRAP_BUDGET_MS = Number(process.env.PG_BOOTSTRAP_TIMEOUT_MS || 12000);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: 'ETIMEDOUT' }));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// Lazy-loaded pg types & instances
let pgModule: typeof import('pg') | null = null;
let pgPool: any = null;
let pgSslResolved: 'tls' | 'none' | null = null;

async function loadPg(): Promise<typeof import('pg')> {
  if (!pgModule) {
    pgModule = await import('pg');
  }
  return pgModule;
}

async function resolvePgSsl(): Promise<'tls' | 'none'> {
  if (pgSslResolved) return pgSslResolved;
  const { Client } = await loadPg();
  try {
    const probe = new Client(pgClientOptions({ ssl: { rejectUnauthorized: false } }));
    await probe.connect();
    await probe.end();
    pgSslResolved = 'tls';
  } catch (error) {
    if (/does not support (SSL|TLS)/i.test((error as Error)?.message || '')) {
      pgSslResolved = 'none';
    } else {
      throw error;
    }
  }
  return pgSslResolved;
}

/**
 * Derive the non-pooled equivalent of a Neon-style pooled connection string
 * (host `ep-…-pooler.….neon.tech` → `ep-….….neon.tech`), dropping pooler-only
 * parameters. Returns null when nothing suggests a pooler, or when the URL
 * cannot be parsed.
 */
function deriveDirectPgUrl(pooledUrl: string): string | null {
  try {
    const url = new URL(pooledUrl);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;
    const looksPooled = url.hostname.includes('-pooler') || url.searchParams.has('pgbouncer');
    if (!looksPooled) return null;
    url.hostname = url.hostname.replace('-pooler', '');
    url.searchParams.delete('pgbouncer');
    url.searchParams.delete('connection_limit');
    return url.toString();
  } catch {
    return null;
  }
}

function ipv4SocketFactory() {
  return () => {
    const socket = new net.Socket();
    const originalConnect = socket.connect.bind(socket);
    socket.connect = ((port: number, host: string, callback?: () => void) =>
      originalConnect({ port, host, family: 4 }, callback)) as net.Socket['connect'];
    return socket;
  };
}

type PgOptions = Record<string, unknown>;

function pgClientOptions(extra?: PgOptions): PgOptions {
  const base: PgOptions = {
    connectionString: pgUrl,
    family: PG_FAMILY,
    stream: ipv4SocketFactory(),
    connectionTimeoutMillis: PG_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
  };
  if (pgSslResolved === 'tls') base.ssl = { rejectUnauthorized: false };
  return { ...base, ...extra };
}

function pgPoolOptions(): PgOptions {
  // max 5: every warm Vercel instance holds its own pool against the same
  // Supabase project, and free tiers cap total connections per user. Ten per
  // instance used to exhaust the provider's limit as instances scaled out,
  // which surfaced as random "sorry, too many clients already" 500s.
  // idleTimeoutMillis: aggressively drop connections this process no longer
  // needs — a serverless instance can be frozen at any moment and the provider
  // silently kills long-idle sockets anyway.
  return pgClientOptions({
    max: 5,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
  });
}

async function getPool(): Promise<any> {
  if (!pgPool) {
    await resolvePgSsl();
    const { Pool } = await loadPg();
    pgPool = new Pool(pgPoolOptions());
    pgPool.on('error', (error: any) => {
      console.warn('Postgres pool idle client error:', error.message);
    });
  }
  return pgPool;
}

/**
 * Errors that mean "the pooled socket died mid-flight or the database hiccupped",
 * not "the query is wrong". A Vercel lambda frozen mid-idle wakes up with stale
 * sockets (the provider closed them while the process was suspended), poolers
 * evict idle connections, and brief network blips happen — all of these reject
 * exactly one query and are fine a moment later. Every statement this module
 * runs is an idempotent read or upsert (and the order counter is deliberately
 * retried too: a momentarily skipped number is better than a failed order), so
 * re-running the failed statement on a fresh connection is safe.
 */
function isTransientPgError(error: any): boolean {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return (
    ['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(code) ||
    ['57P03', '53300', '08000', '08003', '08006', '08001', '08004', 'XX000'].includes(code) ||
    /connection terminated|server closed the connection|terminating connection|socket hang up|SSL SYSCALL|too many clients|connection error|database system is starting up/i.test(
      message
    )
  );
}

let lastTransientLogAt = 0;

/**
 * Runs one statement against the pool, retrying transient connection failures
 * on a fresh pooled client. Non-transient errors (bad SQL, constraint
 * violations, auth failures) propagate immediately — no wasted roundtrips.
 */
async function queryWithRetry(sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
  const pool = await getPool();
  let lastError: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (error) {
      lastError = error;
      if (attempt === 3 || !isTransientPgError(error)) break;
      const delay = 250 * 2 ** (attempt - 1); // 250ms, then 500ms
      const nowMs = Date.now();
      if (nowMs - lastTransientLogAt > 5000) {
        // Rate-limited so a flapping database doesn't flood the logs.
        lastTransientLogAt = nowMs;
        console.warn(
          `[store] Transient Postgres error (${(error as Error)?.message || error}); retrying in ${delay}ms (attempt ${attempt + 1}/3).`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function pgTableName(collection: StoreCollection) {
  return TABLES[collection];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function now() {
  return new Date().toISOString();
}

function isMissingTableError(error: any) {
  return Boolean(error?.code === '42P01' || error?.code === 'PGRST205');
}

function orderNumberValue(order: Order): number {
  const match = String(order.orderNumber || '').match(/(\d+)\s*$/);
  return match ? Number(match[1]) : 0;
}

/**
 * Persistence: either direct Postgres (DATABASE_URL), or a local JSON file at
 * data/restaurant.json. No Supabase, no Firebase, no other cloud services —
 * the app is fully self-contained and always starts.
 */
export class RestaurantStore {
  private ready: Promise<void>;
  private usePostgres = postgresConfigured;
  private memory: DataFile;
  private ephemeral = false;
  /**
   * Waiters for persist() calls whose change has not been flushed to disk yet.
   * A waiter is released only by a flush that serialized its version — or by a
   * failed flush attempt covering it (the change stays in memory and the
   * backoff retry persists it as soon as the disk recovers).
   */
  private persistWaiters: Array<{ version: number; resolve: () => void }> = [];
  /** True while the flush loop is running, so concurrent writes coalesce. */
  private flushLoopRunning = false;
  private writeSequence = 0;
  private persistFailures = 0;
  private persistRetry: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every in-memory change; compared against what is on disk. */
  private memoryVersion = 0;
  private persistedVersion = 0;
  /** Postgres bootstrap diagnostics + background recovery state. */
  private pgPhase: PostgresPhase = 'unknown';
  private pgError: StoreDiagnostics['postgresError'] = null;
  private pgRecoveryAttempts = 0;
  private pgRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private pgLastProbeAt: string | null = null;

  constructor() {
    this.memory = this.loadOrCreateDataFileSync();
    this.ready = this.initialize();
  }

  get provider(): StoreProvider {
    return this.usePostgres ? 'postgres' : 'file';
  }

  async waitUntilReady() {
    await this.ready;
  }

  private loadOrCreateDataFileSync(): DataFile {
    let raw: string;
    try {
      raw = fs.readFileSync(DATA_FILE, 'utf8');
    } catch {
      // No saved data yet (first start) — build the seeded snapshot.
      return this.createDataFile();
    }

    let parsed: Partial<DataFile>;
    try {
      parsed = JSON.parse(raw) as Partial<DataFile>;
    } catch (error) {
      // Never throw a corrupt file away silently: the next write would overwrite
      // it and the café would lose every saved order. Keep a copy to recover from.
      const backupPath = `${DATA_FILE}.corrupt-${Date.now()}`;
      try {
        fs.writeFileSync(backupPath, raw, 'utf8');
      } catch {
        console.error(`[store] ${DATA_FILE} is not valid JSON and could not be backed up — starting from the seeded menu.`);
        return this.createDataFile();
      }
      console.error(
        `[store] ${DATA_FILE} is not valid JSON (${(error as Error)?.message || error}); started from the seeded menu. Your previous file was preserved at ${backupPath}.`
      );
      return this.createDataFile();
    }

    const base = createMemorySnapshot();
    const deriveCounter = () =>
      Math.max(1040, ...(Array.isArray(parsed.orders) ? parsed.orders.map(orderNumberValue) : [0]));
    return {
      settings: { ...base.settings, ...(parsed.settings || {}) },
      categories: Array.isArray(parsed.categories) ? parsed.categories : base.categories,
      tables: Array.isArray(parsed.tables) ? parsed.tables : base.tables,
      products: Array.isArray(parsed.products) ? parsed.products : base.products,
      orders: Array.isArray(parsed.orders) ? parsed.orders : base.orders,
      feedbacks: Array.isArray(parsed.feedbacks) ? parsed.feedbacks : base.feedbacks,
      waiterCalls: Array.isArray(parsed.waiterCalls) ? parsed.waiterCalls : base.waiterCalls,
      counters: { orders: Number(parsed.counters?.orders) || deriveCounter() },
    };
  }

  private createDataFile(): DataFile {
    const base = createMemorySnapshot();
    const file: DataFile = {
      ...base,
      counters: { orders: 1040 },
    };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      this.persistSync(file);
      console.log(`[store] Created local data file ${DATA_FILE}`);
    } catch {
      this.ephemeral = true;
      console.warn('[store] Filesystem not writable; running with in-memory data (changes lost on restart).');
    }
    return file;
  }

  private persistSync(data: DataFile) {
    const tmpPath = this.nextTmpPath();
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, DATA_FILE);
  }

  /**
   * A unique temp file per write. Sharing one `restaurant.json.tmp` path meant
   * two concurrent requests raced on the same rename: the loser failed with
   * ENOENT, which used to disable disk persistence for the whole process.
   */
  private nextTmpPath() {
    this.writeSequence += 1;
    return `${DATA_FILE}.${process.pid}.${this.writeSequence}.tmp`;
  }

  /**
   * Resolves once this caller's change has actually been serialized to
   * data/restaurant.json — or a flush attempt covering it has failed (the
   * change is still safely in memory and the backoff retry will persist it).
   *
   * Previously, a mutation that landed while an OLDER flush was already in
   * flight resolved as soon as that older flush finished — i.e. before its own
   * data was on disk. A crash in that window silently dropped the last
   * order(s); awaiting put() now genuinely means "durable".
   */
  private persist(): Promise<void> {
    if (this.ephemeral) return Promise.resolve();
    this.memoryVersion += 1;
    const version = this.memoryVersion;
    return new Promise<void>((resolve) => {
      this.persistWaiters.push({ version, resolve });
      this.kickFlushLoop();
    });
  }

  /**
   * Single flush loop: at most one disk write is in flight at a time, all
   * concurrent mutations coalesce into shared flushes, and the loop keeps
   * going until the file holds the newest memory state.
   */
  private kickFlushLoop(): void {
    if (this.flushLoopRunning) return;
    this.flushLoopRunning = true;
    void (async () => {
      try {
        while (!this.ephemeral && (this.persistWaiters.length > 0 || this.memoryVersion !== this.persistedVersion)) {
          const attempt = await this.writeSnapshot();
          // Release every waiter covered by the version this attempt
          // serialized. On success their data is on disk; on failure it is
          // still in memory and schedulePersistRetry() will flush it —
          // callers are never left hanging on a broken disk.
          const covered = attempt.version;
          this.persistWaiters = this.persistWaiters.filter((waiter) => {
            if (waiter.version <= covered) {
              waiter.resolve();
              return false;
            }
            return true;
          });
          if (!attempt.wrote) break; // failed: retry with backoff, never a hot loop
        }
      } finally {
        this.flushLoopRunning = false;
      }
      // Mutations may have landed while the loop was finishing.
      if (!this.ephemeral && (this.persistWaiters.length > 0 || this.memoryVersion !== this.persistedVersion)) {
        this.kickFlushLoop();
      }
    })();
  }

  private async writeSnapshot(): Promise<{ version: number; wrote: boolean }> {
    if (this.ephemeral) return { version: this.persistedVersion, wrote: false };
    const tmpPath = this.nextTmpPath();
    // Captured before stringify: JSON.stringify is synchronous, so this is the
    // exact version of the state that ends up in the file.
    const version = this.memoryVersion;
    try {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      const payload = JSON.stringify(this.memory, null, 2);
      const handle = await fs.promises.open(tmpPath, 'w');
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync(); // durable before the rename makes it visible
      } finally {
        await handle.close();
      }
      await fs.promises.rename(tmpPath, DATA_FILE);
      this.persistedVersion = version;
      this.persistFailures = 0;
      return { version, wrote: true };
    } catch (error) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
      this.handlePersistFailure(error);
      return { version, wrote: false };
    }
  }

  private handlePersistFailure(error: unknown) {
    const message = (error as Error)?.message || String(error);
    this.persistFailures += 1;

    if (isFatalPersistError(error)) {
      this.ephemeral = true;
      // Release every pending writer: this store can never flush again, and
      // hanging each future request would take the whole café offline. The
      // data itself stays in memory.
      const waiters = this.persistWaiters;
      this.persistWaiters = [];
      waiters.forEach((waiter) => waiter.resolve());
      console.error(
        `[store] Cannot write ${DATA_FILE} (${message}). Running in memory only — changes are lost on restart. Set DATABASE_URL for durable storage.`
      );
      return;
    }

    // Transient failure: keep the data in memory and retry on the next write.
    this.schedulePersistRetry();
    if (this.persistFailures === 1 || this.persistFailures % 25 === 0) {
      console.warn(`[store] Write to ${DATA_FILE} failed (${message}); retrying on the next change.`);
    }
  }

  /**
   * Retry a failed write even when no further mutation arrives, so the last
   * change is never stranded in memory only. Backs off to at most 30s.
   */
  private schedulePersistRetry() {
    if (this.persistRetry) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.persistFailures, 6));
    this.persistRetry = setTimeout(() => {
      this.persistRetry = null;
      this.kickFlushLoop(); // flush without adding a waiter
    }, delay);
    this.persistRetry.unref?.();
  }

  private async initialize() {
    if (this.usePostgres) {
      if (await this.initPostgresOnce()) return;
    }
    console.log('[store] Persistence: local file data/restaurant.json (no cloud services).');
    // DATABASE_URL is configured but the database was not reachable on first
    // try (sleeping serverless DB, transient DNS/SSL hiccup, bad URL, …).
    // Retry in the background so the store upgrades itself to real, shared,
    // durable data the moment the database comes back — instead of silently
    // staying on per-instance /tmp files forever.
    if (postgresConfigured) this.schedulePostgresRecovery();
  }

  /**
   * One full Postgres bootstrap attempt: URL sanity check → SSL probe →
   * schema check/apply → seed → migrate local records → counter. Every
   * failure is recorded with the phase it happened in plus an actionable
   * hint, so /api/health and the admin banner can explain exactly why the
   * database is not in use and what to do about it.
   */
  private async initPostgresOnce(): Promise<boolean> {
    this.pgLastProbeAt = new Date().toISOString();
    this.pgRecoveryAttempts += 1;
    let host = '';
    try {
      host = new URL(pgUrl).hostname;
    } catch {
      host = '';
    }
    try {
      // Fail fast on a URL that can never work, before any network I/O.
      this.pgPhase = 'connect';
      const parseError = pgUrlParseError(pgUrl);
      if (parseError) throw Object.assign(new Error(parseError), { code: 'INVALID_DATABASE_URL' });
      this.pgPhase = 'ssl-probe';
      // One overall deadline for the whole bootstrap. An unreachable database
      // fails slowly (TCP timeouts), and without this cap the very first
      // request to a cold serverless instance hung until the platform killed
      // it — the visitor saw a 504 instead of the app falling back to the
      // local snapshot and rendering normally.
      await withTimeout(
        (async () => {
          await this.ensurePostgresSchema();
          this.pgPhase = 'seed';
          const settings = await this.getSettingsInternal();
          if (!settings) await this.putSettingsInternal(initialSettings);
          await this.seedMissing('categories', initialCategories);
          await this.seedMissing('tables', initialTables);
          await this.seedMissing('products', initialProducts);
          // Carry over anything recorded locally while the database was down, so
          // orders/feedback never vanish at the moment the connection heals.
          await this.migrateLocalRecordsToPostgres();
          this.pgPhase = 'counter';
          await this.ensureCounter();
          // If the store already issued order numbers from the local file, make
          // sure the database counter never hands out a duplicate.
          await this.raisePgCounterToLocalMax();
        })(),
        PG_BOOTSTRAP_BUDGET_MS,
        'Postgres bootstrap'
      );
      this.usePostgres = true;
      this.pgError = null;
      console.log('[store] Persistence: direct Postgres (DATABASE_URL).');
      return true;
    } catch (error) {
      this.usePostgres = false;
      const message = (error as Error)?.message || String(error);
      const code = (error as { code?: string })?.code;
      this.pgError = {
        message,
        code,
        phase: this.pgPhase,
        at: new Date().toISOString(),
        hint: pgErrorHint({ message, code }, host, this.pgPhase),
      };
      console.warn(
        `[store] Postgres configured but unreachable during '${this.pgPhase}'; using the local data file instead.`,
        this.pgError.message
      );
      return false;
    }
  }

  /**
   * Retry the Postgres bootstrap in the background with capped exponential
   * backoff (30s → 60s → 120s → 240s → 300s max). Each attempt is cheap
   * (one connection); this is what heals "fluctuating data" after a cold
   * start beat the database wake-up, without ever blocking requests.
   */
  private schedulePostgresRecovery() {
    if (!postgresConfigured || this.pgRecoveryTimer || this.usePostgres) return;
    const delay = Math.min(300_000, 30_000 * 2 ** Math.min(this.pgRecoveryAttempts - 1, 3));
    this.pgRecoveryTimer = setTimeout(() => {
      this.pgRecoveryTimer = null;
      void this.initPostgresOnce().then((ok) => {
        if (!ok) this.schedulePostgresRecovery();
      });
    }, delay);
    this.pgRecoveryTimer.unref?.();
  }

  /**
   * Non-secret store diagnostics for the /api/health endpoint. The Postgres
   * host is reported as a hostname only; connection strings and passwords
   * are never included.
   */
  getDiagnostics(): StoreDiagnostics {
    let postgresHost = '';
    try {
      postgresHost = new URL(pgUrl).hostname;
    } catch {
      // unparseable URL — leave host empty
    }
    return {
      provider: this.provider,
      postgresConfigured,
      postgresHost,
      postgresStatus: !postgresConfigured
        ? 'not-configured'
        : this.usePostgres
          ? 'connected'
          : 'unavailable',
      postgresError: this.pgError,
      postgresRecoveryAttempts: this.pgRecoveryAttempts,
      postgresLastProbeAt: this.pgLastProbeAt,
      dataFile: DATA_FILE,
      ephemeral: this.ephemeral,
    };
  }

  private async ensurePostgresSchema() {
    this.pgPhase = 'connect';
    const { rows } = await queryWithRetry(
      `select to_regclass('public.app_settings') as settings, to_regclass('public.app_counters') as counters`
    );
    this.pgPhase = 'schema-check';
    if (rows[0]?.settings && rows[0]?.counters) return;

    const schemaPath = path.join(process.cwd(), 'db', 'schema.sql');
    const sql = await readFile(schemaPath, 'utf8');
    await resolvePgSsl();
    const { Client } = await loadPg();
    // DDL must run on a direct (non-pooled) connection: pgbouncer/Neon pooler
    // endpoints reject multi-statement transactions and `create extension`.
    // Prefer DIRECT_URL, and derive the direct host from Neon-style
    // `…-pooler.…` URLs when only the pooled one is configured.
    const migrationUrl = pgDirectUrl || deriveDirectPgUrl(pgUrl) || pgUrl;
    if (migrationUrl !== pgDirectUrl && !process.env.DIRECT_URL) {
      console.log('[store] Using a derived direct URL for the schema migration (pooled DATABASE_URL detected).');
    }
    const clientOptions: PgOptions = {
      connectionString: migrationUrl,
      family: PG_FAMILY,
      stream: ipv4SocketFactory(),
      connectionTimeoutMillis: 20000,
    };
    if (pgSslResolved === 'tls') clientOptions.ssl = { rejectUnauthorized: false };
    const client = new Client(clientOptions);
    this.pgPhase = 'schema-apply';
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }

    const check = await queryWithRetry(`select to_regclass('public.app_settings') as settings`);
    if (!check.rows[0]?.settings) {
      throw new Error('Database schema is still missing after running db/schema.sql.');
    }
    console.log('[store] Postgres schema was not present; applied db/schema.sql automatically.');
  }

  /**
   * Bring the database order counter up to at least the highest number the
   * local file store has already handed out, so switching to Postgres never
   * issues a duplicate order number.
   */
  private async raisePgCounterToLocalMax() {
    try {
      const localMax = this.memory.counters.orders || 0;
      await queryWithRetry(
        `update app_counters set value = greatest(value, $1) where id = 'orders'`,
        [localMax]
      );
    } catch (error) {
      // Non-fatal: the counter is only a monotonicity guard.
      console.warn('[store] Could not sync the Postgres order counter:', (error as Error)?.message || error);
    }
  }

  private async seedMissing<C extends StoreCollection>(collection: C, records: CollectionModel[C][]) {
    const existing = await this.listInternal(collection);
    const existingIds = new Set(existing.map((record) => record.id));
    await Promise.all(
      records
        .filter((record) => !existingIds.has(record.id))
        .map((record) => this.putInternal(collection, record.id, record))
    );
  }

  /**
   * When the store starts on the local file (database down/bad credentials)
   * and later connects to Postgres, copy every local record that does not
   * already exist there (insert-if-absent by id). Otherwise the moment the
   * connection heals, orders, feedbacks and menu edits recorded in the
   * meantime would silently "disappear" from the UI — the exact failure the
   * storage-health banner warns about. Existing Postgres rows stay
   * authoritative; only records that exist locally and not in Postgres are
   * carried over, so this is safe to run on every (re)connect.
   */
  private async migrateLocalRecordsToPostgres() {
    const collections: StoreCollection[] = ['categories', 'tables', 'products', 'orders', 'feedbacks', 'waiterCalls'];
    let migrated = 0;
    for (const collection of collections) {
      const local = this.memory[collection] as unknown as Array<{ id: string; createdAt?: string }>;
      if (!Array.isArray(local) || local.length === 0) continue;
      const table = pgTableName(collection);
      for (const record of local) {
        if (!record || !record.id) continue;
        const timestamp = record.createdAt || now();
        try {
          await queryWithRetry(
            `insert into "${table}" (id, data, created_at, updated_at)
             values ($1, $2::jsonb, $3, $3)
             on conflict (id) do nothing`,
            [record.id, JSON.stringify(record), timestamp]
          );
          migrated += 1;
        } catch (error) {
          // One bad record must not strand the rest or abort the switch.
          console.warn(`[store] Could not migrate ${collection}/${record.id} to Postgres:`, (error as Error)?.message || error);
        }
      }
    }
    const localSettings = this.memory.settings;
    if (localSettings) {
      try {
        await queryWithRetry(
          `insert into app_settings (id, data, updated_at)
           values ('config', $1::jsonb, $2)
           on conflict (id) do nothing`,
          [JSON.stringify(localSettings), now()]
        );
      } catch (error) {
        console.warn('[store] Could not migrate local settings to Postgres:', (error as Error)?.message || error);
      }
    }
    if (migrated > 0) {
      console.log(`[store] Carried ${migrated} local record(s) over to Postgres (they were saved while the database was unreachable).`);
    }
  }

  private async ensureReady() {
    await this.ready;
  }

  private async ensureCounter() {
    if (!this.usePostgres) return;
    await queryWithRetry(
      `insert into app_counters (id, value) values ('orders', 1040) on conflict (id) do nothing`
    );
  }

  private async listInternal<C extends StoreCollection>(collection: C): Promise<CollectionModel[C][]> {
    if (this.usePostgres) {
      const { rows } = await queryWithRetry(
        `select id, data from "${pgTableName(collection)}" order by created_at desc`
      );
      return (rows as Array<{ id: string; data: CollectionModel[C] }>).map((row) => ({
        ...clone(row.data),
        id: row.id,
      }));
    }

    return clone(this.memory[collection] as unknown as CollectionModel[C][]);
  }

  private async getInternal<C extends StoreCollection>(collection: C, id: string): Promise<CollectionModel[C] | null> {
    if (this.usePostgres) {
      const { rows } = await queryWithRetry(
        `select id, data from "${pgTableName(collection)}" where id = $1 limit 1`,
        [id]
      );
      const row = rows[0] as { id: string; data: CollectionModel[C] } | undefined;
      return row ? { ...clone(row.data), id: row.id } : null;
    }

    const record = (this.memory[collection] as unknown as CollectionModel[C][]).find((item) => item.id === id);
    return record ? clone(record) : null;
  }

  private async putInternal<C extends StoreCollection>(collection: C, id: string, record: CollectionModel[C]) {
    const value = { ...clone(record), id };
    if (this.usePostgres) {
      const timestamp = now();
      await queryWithRetry(
        `insert into "${pgTableName(collection)}" (id, data, created_at, updated_at)
         values ($1, $2::jsonb, $3, $3)
         on conflict (id) do update set data = excluded.data, updated_at = excluded.updated_at`,
        [id, JSON.stringify(value), timestamp]
      );
      return value;
    }

    const records = this.memory[collection] as unknown as CollectionModel[C][];
    const index = records.findIndex((item) => item.id === id);
    if (index === -1) records.unshift(value);
    else records[index] = value;
    await this.persist();
    return value;
  }

  async list<C extends StoreCollection>(collection: C): Promise<CollectionModel[C][]> {
    await this.ensureReady();
    return this.listInternal(collection);
  }

  async get<C extends StoreCollection>(collection: C, id: string): Promise<CollectionModel[C] | null> {
    await this.ensureReady();
    return this.getInternal(collection, id);
  }

  async put<C extends StoreCollection>(collection: C, record: CollectionModel[C]): Promise<CollectionModel[C]> {
    await this.ensureReady();
    return this.putInternal(collection, record.id, record);
  }

  async remove(collection: StoreCollection, id: string) {
    await this.ensureReady();
    if (this.usePostgres) {
      await queryWithRetry(`delete from "${pgTableName(collection)}" where id = $1`, [id]);
      return;
    }
    this.memory[collection] = (this.memory[collection] as unknown as Array<{ id: string }>).filter((item) => item.id !== id) as never;
    await this.persist();
  }

  async getSettings(): Promise<CafeSettings> {
    await this.ensureReady();
    return (await this.getSettingsInternal()) || clone(initialSettings);
  }

  private async getSettingsInternal(): Promise<CafeSettings | null> {
    if (this.usePostgres) {
      const { rows } = await queryWithRetry(`select data from app_settings where id = 'config' limit 1`);
      return rows[0] ? clone(rows[0].data as CafeSettings) : null;
    }
    return clone(this.memory.settings);
  }

  private async putSettingsInternal(settings: CafeSettings): Promise<CafeSettings> {
    if (this.usePostgres) {
      const timestamp = now();
      await queryWithRetry(
        `insert into app_settings (id, data, updated_at)
         values ('config', $1::jsonb, $2)
         on conflict (id) do update set data = excluded.data, updated_at = excluded.updated_at`,
        [JSON.stringify(settings), timestamp]
      );
      return clone(settings);
    }
    this.memory.settings = clone(settings);
    await this.persist();
    return clone(settings);
  }

  async putSettings(settings: CafeSettings): Promise<CafeSettings> {
    await this.ensureReady();
    return this.putSettingsInternal(settings);
  }

  async snapshot(): Promise<AppSnapshot> {
    await this.ensureReady();
    const [settings, categories, tables, products, orders, feedbacks, waiterCalls] = await Promise.all([
      this.getSettings(),
      this.list('categories'),
      this.list('tables'),
      this.list('products'),
      this.list('orders'),
      this.list('feedbacks'),
      this.list('waiterCalls'),
    ]);
    return { settings, categories, tables, products, orders, feedbacks, waiterCalls };
  }

  async nextOrderNumber(): Promise<number> {
    await this.ensureReady();
    if (this.usePostgres) {
      try {
        const { rows } = await queryWithRetry(`select next_order_number() as value`);
        return Number(rows[0]?.value);
      } catch (error) {
        throw new Error(`Postgres order counter is unavailable. Run db/schema.sql: ${(error as Error).message}`);
      }
    }
    this.memory.counters.orders += 1;
    const next = this.memory.counters.orders;
    await this.persist();
    return next;
  }

  async uploadImage(dataUrl: string, _productId: string): Promise<string> {
    return dataUrl;
  }
}

export const store = new RestaurantStore();

export function newId(prefix: string) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}
