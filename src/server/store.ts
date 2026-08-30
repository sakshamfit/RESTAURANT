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
  /** How this process is allowed to store data (see `storageMode`). */
  storageMode: StorageMode;
  /** True when the local JSON file is forbidden and Postgres is mandatory. */
  postgresRequired: boolean;
  /**
   * True when Postgres is required and currently unreachable: every read and
   * write is failing with 503 rather than quietly using the local file.
   */
  failingLoudly: boolean;
  /**
   * True when DATABASE_URL is set, the database is down, and the app is
   * serving data from the local file anyway (development-only fallback).
   */
  localFileFallbackActive: boolean;
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

/**
 * True when this process is a deployed/serverless instance (`VERCEL`) or is
 * explicitly running as production.
 *
 * This matters because a local JSON file is *not* a fallback on these
 * platforms, it is a data-loss bug: every serverless instance gets its own
 * private `/tmp`, so a "saved" order is visible to whichever instance happened
 * to answer the next request and is gone on the next cold start. That is
 * exactly the "my menu items and orders keep disappearing and reappearing"
 * symptom. So the default flips from "keep running on a file" to "fail loudly".
 */
export const isProductionRuntime = Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production';

/**
 * Should the app be allowed to serve data from the local JSON file?
 *
 * Default: yes for local development (where one process owns one file on a
 * real disk and the file genuinely persists), **no in production** (where it
 * silently produces divergent per-instance data).
 *
 * `ALLOW_LOCAL_FILE_FALLBACK` overrides either default. Set it to `true` to
 * restore the old always-on behaviour, or to `false` to rehearse the
 * production fail-loud behaviour locally.
 */
export const allowLocalFileFallback = (() => {
  const raw = String(process.env.ALLOW_LOCAL_FILE_FALLBACK || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return !isProductionRuntime;
})();

/**
 * How this process is allowed to store data. Decided once, at module load, and
 * never renegotiated — a store that changes its backing source mid-flight is
 * what made the admin panel's data appear and disappear.
 *
 * - `'postgres'` — Postgres is the one and only store. If it cannot be
 *   reached the app returns 503 and saves nothing. **No local file is ever
 *   read or written.** This is the production default.
 * - `'postgres-with-file-fallback'` — try Postgres; if it is unreachable, fall
 *   back to the local file, loudly (an `error`-level log plus a warning in
 *   `/api/health` and the admin banner). Local records are copied into
 *   Postgres when the connection heals. Local development default only.
 * - `'file'` — local JSON file, because no `DATABASE_URL` is configured.
 */
export type StorageMode = 'postgres' | 'postgres-with-file-fallback' | 'file';

export const storageMode: StorageMode = allowLocalFileFallback
  ? postgresConfigured
    ? 'postgres-with-file-fallback'
    : 'file'
  : 'postgres';

/**
 * True when this process must refuse to serve data rather than fall back to
 * the local file.
 */
export const postgresRequired = storageMode === 'postgres';

/**
 * Thrown when Postgres is the required store and it cannot be reached.
 *
 * Deliberately loud: it carries the actionable `hint` (bad password? wrong
 * host? sleeping project?) so the API can return it to the admin UI instead of
 * serving a phantom local menu that looks like real data.
 */
export class PostgresUnavailableError extends Error {
  readonly code = 'POSTGRES_UNAVAILABLE' as const;
  readonly phase: PostgresPhase;
  readonly pgCode: string | undefined;
  readonly hint: string | undefined;
  readonly postgresError: StoreDiagnostics['postgresError'];

  constructor(postgresError: StoreDiagnostics['postgresError']) {
    super(postgresError?.message || 'Postgres is unreachable.');
    this.name = 'PostgresUnavailableError';
    this.phase = postgresError?.phase || 'unknown';
    this.pgCode = postgresError?.code;
    this.hint = postgresError?.hint;
    this.postgresError = postgresError;
  }
}

/** Row id in `app_settings` used to remember that a database has been seeded. */
const PG_BOOTSTRAP_MARKER = 'bootstrap';
/** Cold-start bootstrap attempts before giving up (only transient errors retry). */
const PG_BOOTSTRAP_ATTEMPTS = 3;
/** A request may trigger a fresh bootstrap attempt at most this often. */
const PG_RETRY_COALESCE_MS = 10_000;

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
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|network is unreachable|connect ETIMEDOUT/i.test(message)) {
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
const PG_TIMEOUT_MS = Number(process.env.PG_CONNECT_TIMEOUT_MS || 15000);

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
 * Persistence: direct Postgres when `DATABASE_URL` is set, otherwise a local
 * JSON file. No Supabase, no Firebase, no other cloud services.
 *
 * When Postgres is configured **and** this is a production/serverless runtime,
 * Postgres is mandatory: an unreachable database makes every data route return
 * 503 with an actionable hint instead of silently serving a per-instance local
 * file. See `storageMode` for the full rules.
 */
export class RestaurantStore {
  private ready: Promise<void>;
  /** Fixed for the lifetime of the process — see `storageMode`. */
  private readonly mode: StorageMode = storageMode;
  /**
   * Whether the Postgres bootstrap has succeeded. Separate from `mode` so the
   * store can never switch backing sources behind a request's back: `mode`
   * decides *what is allowed*, this decides *what is currently reachable*.
   */
  private pgOnline = false;
  /** A bootstrap attempt already running, shared by every caller (single-flight). */
  private pgRecoveryInFlight: Promise<boolean> | null = null;
  private pgLastProbeMs = 0;
  private memory: DataFile;
  private ephemeral = false;
  /** True when the local data file already existed on disk at start-up. */
  private localFileExisted = false;
  /** Serializes disk writes: at most one write is in flight, the rest coalesce. */
  private writeQueue: Promise<void> = Promise.resolve();
  private inFlightWrite: Promise<void> | null = null;
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
    // The local file is loaded lazily, only if it is actually going to back
    // the store. Reading (or worse, creating) `restaurant.json` while Postgres
    // is the real store would give the admin panel a phantom menu to display
    // during an outage — which looks exactly like "my data disappeared".
    this.memory = { ...createMemorySnapshot(), counters: { orders: 1040 } };
    this.ready = this.initialize();
  }

  /**
   * Which store serves reads and writes right now.
   *
   * In `'postgres'` mode this is *always* true — even while the database is
   * down. That is the point: unavailability is reported as a 503, it is never
   * papered over by switching to a different data source.
   */
  private get usePostgres(): boolean {
    if (this.mode === 'postgres') return true;
    if (this.mode === 'file') return false;
    return this.pgOnline;
  }

  get provider(): StoreProvider {
    return this.usePostgres ? 'postgres' : 'file';
  }

  async waitUntilReady() {
    await this.ready;
  }

  /**
   * Reads and validates the local JSON file.
   *
   * Returns `null` when there is no file (or it is unreadable/unparseable) and
   * **never creates one**, so it is safe to call purely as a "does real local
   * data exist?" probe — which is how the Postgres bootstrap decides whether
   * there is anything worth migrating.
   */
  private readDataFileSync(): DataFile | null {
    let raw: string;
    try {
      raw = fs.readFileSync(DATA_FILE, 'utf8');
    } catch {
      return null;
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

  /** Loads the local file, creating (and seeding) it on first use. */
  private loadOrCreateDataFileSync(): DataFile {
    const existing = this.readDataFileSync();
    if (existing) {
      this.localFileExisted = true;
      return existing;
    }
    return this.createDataFile();
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
   * Serializes every disk write. Concurrent callers share a single flush of the
   * latest state instead of each racing to rewrite the file, so the file always
   * ends up holding the newest snapshot and is never left half-written.
   */
  private persist(): Promise<void> {
    if (this.ephemeral) return Promise.resolve();
    // Every call means "memory now holds something newer than the file". If a
    // write is already in flight it captured the older state, so the version
    // check below re-flushes once it settles.
    this.memoryVersion += 1;
    if (this.inFlightWrite) return this.inFlightWrite;

    const flush = this.writeQueue.then(() => this.writeSnapshot());
    // `flush` never rejects (writeSnapshot handles its own errors), so chaining
    // the next write behind the settled one keeps the queue moving.
    const settled = flush.then((wrote) => {
      this.inFlightWrite = null;
      // A mutation landed while that write was in flight: flush again, so the
      // newest state is what ends up on disk and awaiting persist() really does
      // mean "durable". Only after a *successful* write — a failed one is
      // retried by schedulePersistRetry, never in a hot loop.
      if (wrote && this.memoryVersion !== this.persistedVersion) void this.persist();
    });
    this.inFlightWrite = settled;
    this.writeQueue = settled;
    // Callers await this to know their change reached the disk.
    return flush.then(() => undefined);
  }

  private async writeSnapshot(): Promise<boolean> {
    if (this.ephemeral) return false;
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
      return true;
    } catch (error) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
      this.handlePersistFailure(error);
      return false;
    }
  }

  private handlePersistFailure(error: unknown) {
    const message = (error as Error)?.message || String(error);
    this.persistFailures += 1;

    if (isFatalPersistError(error)) {
      this.ephemeral = true;
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
      void this.persist();
    }, delay);
    this.persistRetry.unref?.();
  }

  private async initialize() {
    if (this.mode !== 'file') {
      if (await this.bootstrapPostgres()) return;
    }

    // ── Postgres is unreachable ────────────────────────────────────────────
    if (this.mode === 'postgres') {
      // FAIL LOUD. There is no local file to fall back to, by design: on a
      // serverless platform a local file gives every instance its own private
      // copy of the data, which is precisely the "orders and menu items keep
      // disappearing and reappearing" bug. Every data route now returns 503
      // with the hint below until the database answers again.
      console.error(
        `\n[store] ==================================================================\n` +
          `[store] POSTGRES UNREACHABLE — the app is refusing to serve café data.\n` +
          `[store]   host:  ${this.pgErrorHost() || '(not configured)'}\n` +
          `[store]   phase: ${this.pgError?.phase || 'unknown'}\n` +
          `[store]   error: ${this.pgError?.message || 'unknown error'}\n` +
          `[store]   fix:   ${this.pgError?.hint || 'Set DATABASE_URL correctly and redeploy.'}\n` +
          `[store] Reads and writes will fail with HTTP 503 until this is fixed. No data\n` +
          `[store] is being served from a local file — check /api/health for live state.\n` +
          `[store] ==================================================================\n`
      );
      // Keep retrying in the background so the deployment heals itself the
      // moment the database comes back, without needing a redeploy.
      this.schedulePostgresRecovery();
      return;
    }

    // ── Local JSON file ────────────────────────────────────────────────────
    this.memory = this.loadOrCreateDataFileSync();
    if (postgresConfigured) {
      // Development-only fallback (ALLOW_LOCAL_FILE_FALLBACK). Loud on purpose:
      // this used to be a single-line console.log, so an operator watching the
      // logs saw "Persistence: local file" and had no idea the database was
      // down or that their data was about to diverge.
      console.error(
        `\n[store] ==================================================================\n` +
          `[store] POSTGRES UNREACHABLE — FALLING BACK TO THE LOCAL FILE (dev only).\n` +
          `[store]   host:  ${this.pgErrorHost()}\n` +
          `[store]   error: ${this.pgError?.message || 'unknown error'}\n` +
          `[store]   fix:   ${this.pgError?.hint || 'Check DATABASE_URL.'}\n` +
          `[store] Data is being served from ${DATA_FILE}. In production this fallback\n` +
          `[store] is disabled: set ALLOW_LOCAL_FILE_FALLBACK=false to match production.\n` +
          `[store] ==================================================================\n`
      );
      this.schedulePostgresRecovery();
    } else {
      console.log(`[store] Persistence: local file ${DATA_FILE} (no DATABASE_URL configured).`);
    }
  }

  private pgErrorHost(): string {
    try {
      return new URL(pgUrl).hostname;
    } catch {
      return '';
    }
  }

  /**
   * Bootstrap Postgres, retrying *transient* failures inside the cold start.
   *
   * A paused free-tier database or a socket left stale by a frozen lambda
   * almost always connects on the second attempt, so retrying here turns a
   * whole class of "the site is broken" reports into a ~1s delay. Errors that
   * can never succeed (bad URL, wrong password, missing database) fail fast on
   * attempt 1 — retrying them would just make the outage slower to diagnose.
   */
  private async bootstrapPostgres(): Promise<boolean> {
    for (let attempt = 1; attempt <= PG_BOOTSTRAP_ATTEMPTS; attempt += 1) {
      if (await this.initPostgresOnce()) return true;
      if (attempt === PG_BOOTSTRAP_ATTEMPTS || !this.isRetryableBootstrapError()) break;
      const delay = 400 * 2 ** (attempt - 1); // 400ms, then 800ms
      console.warn(
        `[store] Postgres bootstrap attempt ${attempt}/${PG_BOOTSTRAP_ATTEMPTS} failed ` +
          `(${this.pgError?.message}); retrying in ${delay}ms.`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return false;
  }

  /**
   * A bootstrap failure is only worth retrying when the *connection* is at
   * fault. Configuration mistakes (unparseable URL, rejected password, missing
   * database) return the same error every time.
   */
  private isRetryableBootstrapError(): boolean {
    const code = this.pgError?.code || '';
    if (['INVALID_DATABASE_URL', '28P01', '3D000', '28000'].includes(code)) return false;
    return isTransientPgError({ code, message: this.pgError?.message || '' });
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
      await this.ensurePostgresSchema();
      this.pgPhase = 'seed';
      await this.seedStarterDataOnce();
      // Carry over anything recorded in the local data file, so a deployment
      // upgrading from file storage to Postgres loses nothing.
      await this.migrateLocalRecordsToPostgres();
      this.pgPhase = 'counter';
      await this.ensureCounter();
      // If the store already issued order numbers from the local file, make
      // sure the database counter never hands out a duplicate.
      await this.raisePgCounterToLocalMax();
      this.pgOnline = true;
      this.pgError = null;
      console.log(`[store] Persistence: direct Postgres (DATABASE_URL) — host ${host || '(unknown)'}.`);
      return true;
    } catch (error) {
      this.pgOnline = false;
      const message = (error as Error)?.message || String(error);
      const code = (error as { code?: string })?.code;
      this.pgError = {
        message,
        code,
        phase: this.pgPhase,
        at: new Date().toISOString(),
        hint: pgErrorHint({ message, code }, host, this.pgPhase),
      };
      // `console.error`, not `console.warn`: this is an outage, not a nit. The
      // full message is also logged by initialize() once the retries give up.
      console.error(
        `[store] Postgres bootstrap failed during the '${this.pgPhase}' step: ${this.pgError.message}` +
          (this.pgError.hint ? ` | fix: ${this.pgError.hint}` : '')
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
    // Keyed off `pgOnline`, not `usePostgres`: in `'postgres'` mode
    // `usePostgres` is permanently true, and checking it here would disable
    // recovery exactly when the app is down and needs it most.
    if (!postgresConfigured || this.pgRecoveryTimer || this.pgOnline) return;
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
      storageMode: this.mode,
      postgresRequired,
      failingLoudly: this.mode === 'postgres' && !this.pgOnline,
      localFileFallbackActive: this.mode === 'postgres-with-file-fallback' && !this.pgOnline,
      postgresConfigured,
      postgresHost,
      postgresStatus: !postgresConfigured
        ? 'not-configured'
        : this.pgOnline
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
    // Only meaningful when a real local file was in use; `this.memory` holds
    // the seed counter (1040) otherwise, and `greatest(value, 1040)` is a no-op.
    if (!this.localFileExisted) return;
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

  /**
   * Inserts the starter categories/tables/menu into a **fresh** database — once.
   *
   * This used to run on every connect (and every background recovery), which
   * is the other half of the "my data keeps reappearing" bug: deleting a menu
   * item in the admin panel only removed its row, and the very next cold start
   * re-ran the seed and silently put it back. The starter records have fixed
   * ids (`prod-samosa`, `cat-snacks`, …), so an admin could delete one as often
   * as they liked and Vercel would keep resurrecting it.
   *
   * Seeding is now guarded by a marker row in `app_settings`, so a database
   * that has ever been seeded is never seeded again.
   */
  private async seedStarterDataOnce(): Promise<void> {
    const { rows: marker } = await queryWithRetry(
      `select data from app_settings where id = $1 limit 1`,
      [PG_BOOTSTRAP_MARKER]
    );
    if (marker[0]) return;

    const settings = await this.getSettingsInternal();
    if (!settings) await this.putSettingsInternal(initialSettings);

    // A database populated by an older version of the app has no marker but
    // does have a menu. Don't re-seed it — that would resurrect deletions.
    if (await this.databaseHasAnyData()) {
      await this.markDatabaseSeeded(false);
      return;
    }

    await this.seedMissing('categories', initialCategories);
    await this.seedMissing('tables', initialTables);
    await this.seedMissing('products', initialProducts);
    await this.markDatabaseSeeded(true);
    console.log('[store] Seeded the starter menu into a fresh database (this happens once per database).');
  }

  private async markDatabaseSeeded(seeded: boolean): Promise<void> {
    await queryWithRetry(
      `insert into app_settings (id, data, updated_at)
       values ($1, $2::jsonb, $3)
       on conflict (id) do nothing`,
      [PG_BOOTSTRAP_MARKER, JSON.stringify({ seeded, at: now(), schema: 'initial' }), now()]
    );
  }

  /** Cheap "is this database already in use?" check, used to guard re-seeding. */
  private async databaseHasAnyData(): Promise<boolean> {
    const { rows } = await queryWithRetry(
      `select (select count(*) from app_categories)
            + (select count(*) from app_tables)
            + (select count(*) from app_products) as total`
    );
    return Number(rows[0]?.total || 0) > 0;
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
    // Read the file from disk rather than from `this.memory`: memory now holds
    // nothing but the seeded defaults until a file store is actually in use,
    // and seeding those defaults into a real database would be nonsense.
    const local = this.readDataFileSync();
    if (!local) return;

    const collections: StoreCollection[] = ['categories', 'tables', 'products', 'orders', 'feedbacks', 'waiterCalls'];
    let migrated = 0;
    for (const collection of collections) {
      const records = local[collection] as unknown as Array<{ id: string; createdAt?: string }>;
      if (!Array.isArray(records) || records.length === 0) continue;
      const table = pgTableName(collection);
      for (const record of records) {
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
    const localSettings = local.settings;
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

  /**
   * Gate for every data read and write.
   *
   * Waits for the one-time bootstrap, then — when Postgres is the mandatory
   * store and it is down — throws instead of letting the caller quietly read a
   * different data source. This is the single place that enforces "fail loudly,
   * never silently fall back to local files".
   */
  private async ensureReady() {
    await this.ready;
    if (this.mode !== 'postgres' || this.pgOnline) return;

    // Give a healing database a chance to be picked up by a live request
    // instead of making the caller wait for the background timer. Single-flight
    // and rate-limited, so a burst of requests cannot stampede the database.
    const stale = Date.now() - this.pgLastProbeMs > PG_RETRY_COALESCE_MS;
    if (!this.pgRecoveryInFlight && stale) {
      this.pgLastProbeMs = Date.now();
      this.pgRecoveryInFlight = this.initPostgresOnce().finally(() => {
        this.pgRecoveryInFlight = null;
      });
    }
    if (this.pgRecoveryInFlight) await this.pgRecoveryInFlight;

    if (!this.pgOnline) throw new PostgresUnavailableError(this.pgError);
  }

  private async ensureCounter() {
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
