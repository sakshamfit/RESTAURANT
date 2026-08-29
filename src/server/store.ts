import net from 'net';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { readFile } from 'fs/promises';
import dotenv from 'dotenv';

dotenv.config();
import { AppSnapshot, createMemorySnapshot, initialCategories, initialProducts, initialSettings, initialTables } from './seed';
import { CafeCategory, CafeSettings, CafeTable, CustomerFeedback, Order, Product, WaiterCall } from '../types';

export type StoreCollection = 'categories' | 'tables' | 'products' | 'orders' | 'feedbacks' | 'waiterCalls';
export type StoreProvider = 'postgres' | 'file';

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
const pgUrl = process.env.DATABASE_URL || '';
const pgDirectUrl = process.env.DIRECT_URL || pgUrl;
export const postgresConfigured = Boolean(pgUrl);

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
  };
  if (pgSslResolved === 'tls') base.ssl = { rejectUnauthorized: false };
  return { ...base, ...extra };
}

function pgPoolOptions(): PgOptions {
  return pgClientOptions({ max: 10 });
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
  /** Serializes disk writes: at most one write is in flight, the rest coalesce. */
  private writeQueue: Promise<void> = Promise.resolve();
  private inFlightWrite: Promise<void> | null = null;
  private writeSequence = 0;
  private persistFailures = 0;
  private persistRetry: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every in-memory change; compared against what is on disk. */
  private memoryVersion = 0;
  private persistedVersion = 0;

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
    if (this.usePostgres) {
      try {
        await this.ensurePostgresSchema();
        const settings = await this.getSettingsInternal();
        if (!settings) await this.putSettingsInternal(initialSettings);
        await this.seedMissing('categories', initialCategories);
        await this.seedMissing('tables', initialTables);
        await this.seedMissing('products', initialProducts);
        await this.ensureCounter();
        console.log('[store] Persistence: direct Postgres (DATABASE_URL).');
        return;
      } catch (error) {
        this.usePostgres = false;
        console.warn('[store] Postgres configured but unreachable; using the local data file instead.', (error as Error)?.message || error);
      }
    }
    console.log('[store] Persistence: local file data/restaurant.json (no cloud services).');
  }

  private async ensurePostgresSchema() {
    const pool = await getPool();
    const { rows } = await pool.query(
      `select to_regclass('public.app_settings') as settings, to_regclass('public.app_counters') as counters`
    );
    if (rows[0]?.settings && rows[0]?.counters) return;

    const schemaPath = path.join(process.cwd(), 'db', 'schema.sql');
    const sql = await readFile(schemaPath, 'utf8');
    await resolvePgSsl();
    const { Client } = await loadPg();
    const clientOptions: PgOptions = {
      connectionString: pgDirectUrl,
      family: PG_FAMILY,
      stream: ipv4SocketFactory(),
      connectionTimeoutMillis: 20000,
    };
    if (pgSslResolved === 'tls') clientOptions.ssl = { rejectUnauthorized: false };
    const client = new Client(clientOptions);
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }

    const check = await pool.query(`select to_regclass('public.app_settings') as settings`);
    if (!check.rows[0]?.settings) {
      throw new Error('Database schema is still missing after running db/schema.sql.');
    }
    console.log('[store] Postgres schema was not present; applied db/schema.sql automatically.');
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

  private async ensureReady() {
    await this.ready;
  }

  private async ensureCounter() {
    if (!this.usePostgres) return;
    await (await getPool()).query(
      `insert into app_counters (id, value) values ('orders', 1040) on conflict (id) do nothing`
    );
  }

  private async listInternal<C extends StoreCollection>(collection: C): Promise<CollectionModel[C][]> {
    if (this.usePostgres) {
      const { rows } = await (await getPool()).query(
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
      const { rows } = await (await getPool()).query(
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
      await (await getPool()).query(
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
      await (await getPool()).query(`delete from "${pgTableName(collection)}" where id = $1`, [id]);
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
      const { rows } = await (await getPool()).query(`select data from app_settings where id = 'config' limit 1`);
      return rows[0] ? clone(rows[0].data as CafeSettings) : null;
    }
    return clone(this.memory.settings);
  }

  private async putSettingsInternal(settings: CafeSettings): Promise<CafeSettings> {
    if (this.usePostgres) {
      const timestamp = now();
      await (await getPool()).query(
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
        const { rows } = await (await getPool()).query(`select next_order_number() as value`);
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
