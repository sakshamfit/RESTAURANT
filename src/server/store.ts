import { Client, ClientConfig, Pool, PoolConfig } from 'pg';
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
// DATA_DIR can be overridden (Vercel sets it to /tmp/restaurant-data, which is
// the only writable location on serverless instances). If the filesystem is
// read-only the store falls back to in-memory so the app never crashes.
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

// ── Direct Postgres persistence (optional) ──────────────────────────────────
// When DATABASE_URL is present the app talks to the database directly (pg driver,
// JSONB document tables from db/schema.sql). If the database is unreachable the
// app falls back to the local JSON file so it always boots and login always works.
const pgUrl = process.env.DATABASE_URL || '';
const pgDirectUrl = process.env.DIRECT_URL || pgUrl;
export const postgresConfigured = Boolean(pgUrl);

const PG_FAMILY = 4;
const PG_TIMEOUT_MS = Number(process.env.PG_CONNECT_TIMEOUT_MS || 15000);

let pgPool: Pool | null = null;
let pgSslResolved: 'tls' | 'none' | null = null;

async function resolvePgSsl(): Promise<'tls' | 'none'> {
  if (pgSslResolved) return pgSslResolved;
  try {
    const probe = new Client(pgClientOptions({ ssl: { rejectUnauthorized: false } }) as unknown as ClientConfig);
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

// node-postgres creates its socket without options, so a `family` setting in the
// client config is silently ignored. We pass a socket factory that forces IPv4.
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

function pgPoolOptions(): PoolConfig {
  return pgClientOptions({ max: 10 }) as unknown as PoolConfig;
}

async function getPool(): Promise<Pool> {
  if (!pgPool) {
    await resolvePgSsl();
    pgPool = new Pool(pgPoolOptions());
    pgPool.on('error', (error) => {
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
  /** True when the filesystem is not writable and we keep everything in memory. */
  private ephemeral = false;

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
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DataFile>;
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
    } catch {
      return this.createDataFile();
    }
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
    fs.writeFileSync(`${DATA_FILE}.tmp`, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(`${DATA_FILE}.tmp`, DATA_FILE);
  }

  private async persist() {
    if (this.ephemeral) return;
    try {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      const tmpPath = `${DATA_FILE}.tmp`;
      await fs.promises.writeFile(tmpPath, JSON.stringify(this.memory, null, 2), 'utf8');
      await fs.promises.rename(tmpPath, DATA_FILE);
    } catch (error) {
      this.ephemeral = true;
      console.warn('[store] Filesystem not writable; switched to in-memory data.', (error as Error)?.message || error);
    }
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

  /**
   * Verifies the app tables exist; on a fresh database it applies
   * db/schema.sql once over a single direct connection.
   */
  private async ensurePostgresSchema() {
    const pool = await getPool();
    const { rows } = await pool.query(
      `select to_regclass('public.app_settings') as settings, to_regclass('public.app_counters') as counters`
    );
    if (rows[0]?.settings && rows[0]?.counters) return;

    const schemaPath = path.join(process.cwd(), 'db', 'schema.sql');
    const sql = await readFile(schemaPath, 'utf8');
    await resolvePgSsl();
    const clientOptions: PgOptions = {
      connectionString: pgDirectUrl,
      family: PG_FAMILY,
      stream: ipv4SocketFactory(),
      connectionTimeoutMillis: 20000,
    };
    if (pgSslResolved === 'tls') clientOptions.ssl = { rejectUnauthorized: false };
    const client = new Client(clientOptions as unknown as ClientConfig);
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
    // No cloud storage — product images are stored with the product (data URL).
    return dataUrl;
  }
}

export const store = new RestaurantStore();

export function newId(prefix: string) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}
