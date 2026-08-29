import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Client, ClientConfig, Pool, PoolConfig } from 'pg';
import net from 'net';
import crypto from 'crypto';
import path from 'path';
import { readFile } from 'fs/promises';
import dotenv from 'dotenv';

dotenv.config();
import { AppSnapshot, createMemorySnapshot, initialCategories, initialProducts, initialSettings, initialTables } from './seed';
import { CafeCategory, CafeSettings, CafeTable, CustomerFeedback, Order, Product, WaiterCall } from '../types';

export type StoreCollection = 'categories' | 'tables' | 'products' | 'orders' | 'feedbacks' | 'waiterCalls';
export type StoreProvider = 'supabase' | 'postgres' | 'memory-preview';

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

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
  const publicAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  return { url, serviceKey, publicAnonKey, configured: Boolean(url && serviceKey) };
}

const config = getSupabaseConfig();

export const supabaseConfigured = config.configured;
export const supabaseAdmin: SupabaseClient | null = config.configured
  ? createClient(config.url, config.serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

// ── Direct Postgres persistence ──────────────────────────────────────────────
// When DATABASE_URL is present the app talks to the database directly (pg driver,
// JSONB document tables from supabase/schema.sql). This is the same database the
// Supabase clients use; it is the active provider when Supabase API keys are not
// configured, or as a fallback when the Supabase API is unreachable.
const pgUrl = process.env.DATABASE_URL || '';
const pgDirectUrl = process.env.DIRECT_URL || pgUrl;
export const postgresConfigured = Boolean(pgUrl);

// Supabase pools/direct hosts are the target, so force IPv4 (the pooler path is
// IPv4-only). TLS is negotiated when the server offers it (Supabase always does);
// a probe falls back to a plain connection for non-TLS servers.
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
// client config is silently ignored. We pass a socket factory that forces IPv4
// (the Supabase pooler path is IPv4-only) and surfaces a clear error when a host
// has no IPv4 address.
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

let memory = createMemorySnapshot();
let memoryCounter = 1040;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function now() {
  return new Date().toISOString();
}

function isMissingTableError(error: any) {
  return Boolean(error?.code === '42P01' || error?.code === 'PGRST205');
}

/**
 * The application has one persistence layer, in order of preference:
 * 1. Supabase (PostgREST/Realtime/Storage) when its server credentials are set.
 * 2. Direct Postgres (DATABASE_URL) when Supabase is not configured or unreachable.
 * 3. In-memory preview — only so a fresh clone can be demoed with no database at
 *    all; it never reads or writes a local database file.
 */
export class RestaurantStore {
  private ready: Promise<void>;
  private useSupabase = Boolean(supabaseAdmin);
  private usePostgres = postgresConfigured;

  constructor() {
    this.ready = this.initialize();
  }

  get provider(): StoreProvider {
    if (this.useSupabase) return 'supabase';
    if (this.usePostgres) return 'postgres';
    return 'memory-preview';
  }

  async waitUntilReady() {
    await this.ready;
  }

  private async initialize() {
    let lastError: unknown = null;

    if (this.useSupabase && supabaseAdmin) {
      try {
        const { error } = await supabaseAdmin.from('app_settings').select('id').eq('id', 'config').maybeSingle();
        if (error) {
          if (isMissingTableError(error)) {
            const schemaError = new Error('Supabase is configured but the database schema is missing. Run supabase/schema.sql in the Supabase SQL Editor.');
            (schemaError as Error & { code?: string }).code = 'SCHEMA_MISSING';
            throw schemaError;
          }
          throw error;
        }
      } catch (error) {
        lastError = error;
        this.useSupabase = false;
        if (this.usePostgres) {
          console.warn('Supabase API is configured but unreachable from this environment; falling back to the direct Postgres connection (DATABASE_URL).', error?.message || error);
        } else if (process.env.NODE_ENV === 'production') {
          throw error;
        } else {
          console.warn('Supabase is configured but unavailable in this development preview; continuing without it.', error?.message || error);
        }
      }
    }

    if (!this.useSupabase && this.usePostgres) {
      try {
        await this.ensurePostgresSchema();
      } catch (error) {
        lastError = error;
        this.usePostgres = false;
        if (process.env.NODE_ENV === 'production' && !this.useSupabase) throw error;
        console.warn('Postgres is configured (DATABASE_URL) but unreachable from this environment; using memory-only preview data.', (error as Error)?.message || error);
      }
    }

    if (this.useSupabase || this.usePostgres) {
      try {
        // Seed only missing records. Existing menu edits and orders are never overwritten.
        const settings = await this.getSettingsInternal();
        if (!settings) await this.putSettingsInternal(initialSettings);
        await this.seedMissing('categories', initialCategories);
        await this.seedMissing('tables', initialTables);
        await this.seedMissing('products', initialProducts);
        await this.ensureCounter();
      } catch (error) {
        lastError = error;
        if (process.env.NODE_ENV === 'production') throw error;
        this.useSupabase = false;
        this.usePostgres = false;
        console.warn('Database is configured but failed to initialise in this development preview; using memory-only preview data.', (error as Error)?.message || error);
      }
    } else if (lastError && (supabaseConfigured || postgresConfigured)) {
      console.warn('No persistence backend is available in this environment; using memory-only preview data. Set Supabase keys or DATABASE_URL for real persistence.');
    }
  }

  /**
   * Verifies the app tables exist; on a fresh database it applies
   * supabase/schema.sql once over a single direct connection.
   */
  private async ensurePostgresSchema() {
    const pool = await getPool();
    const { rows } = await pool.query(
      `select to_regclass('public.app_settings') as settings, to_regclass('public.app_counters') as counters`
    );
    if (rows[0]?.settings && rows[0]?.counters) return;

    const schemaPath = path.join(process.cwd(), 'supabase', 'schema.sql');
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
      throw new Error('Database schema is still missing after running supabase/schema.sql.');
    }
    console.log('Postgres schema was not present; applied supabase/schema.sql automatically.');
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
    if (this.useSupabase && supabaseAdmin) {
      const { error } = await supabaseAdmin
        .from('app_counters')
        .upsert({ id: 'orders', value: 1040 }, { onConflict: 'id', ignoreDuplicates: true });
      if (error) throw error;
    } else if (this.usePostgres) {
      await (await getPool()).query(
        `insert into app_counters (id, value) values ('orders', 1040) on conflict (id) do nothing`
      );
    }
  }

  private async listInternal<C extends StoreCollection>(collection: C): Promise<CollectionModel[C][]> {
    if (this.useSupabase && supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from(TABLES[collection])
        .select('id,data,created_at,updated_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return ((data || []) as DataRow<CollectionModel[C]>[]).map((row) => ({
        ...clone(row.data),
        id: row.id,
      } as CollectionModel[C]));
    }

    if (this.usePostgres) {
      const { rows } = await (await getPool()).query(
        `select id, data from "${pgTableName(collection)}" order by created_at desc`
      );
      return (rows as Array<{ id: string; data: CollectionModel[C] }>).map((row) => ({
        ...clone(row.data),
        id: row.id,
      }));
    }

    return clone(memory[collection] as CollectionModel[C][]);
  }

  private async getInternal<C extends StoreCollection>(collection: C, id: string): Promise<CollectionModel[C] | null> {
    if (this.useSupabase && supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from(TABLES[collection])
        .select('id,data')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data ? ({ ...clone((data as DataRow<CollectionModel[C]>).data), id: data.id } as CollectionModel[C]) : null;
    }

    if (this.usePostgres) {
      const { rows } = await (await getPool()).query(
        `select id, data from "${pgTableName(collection)}" where id = $1 limit 1`,
        [id]
      );
      const row = rows[0] as { id: string; data: CollectionModel[C] } | undefined;
      return row ? { ...clone(row.data), id: row.id } : null;
    }

    const record = (memory[collection] as CollectionModel[C][]).find((item) => item.id === id);
    return record ? clone(record) : null;
  }

  private async putInternal<C extends StoreCollection>(collection: C, id: string, record: CollectionModel[C]) {
    const value = { ...clone(record), id };
    if (this.useSupabase && supabaseAdmin) {
      const timestamp = now();
      const { error } = await supabaseAdmin.from(TABLES[collection]).upsert(
        { id, data: value, updated_at: timestamp, created_at: timestamp },
        { onConflict: 'id' }
      );
      if (error) throw error;
      return value;
    }

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

    const records = memory[collection] as CollectionModel[C][];
    const index = records.findIndex((item) => item.id === id);
    if (index === -1) records.unshift(value);
    else records[index] = value;
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
    if (this.useSupabase && supabaseAdmin) {
      const { error } = await supabaseAdmin.from(TABLES[collection]).delete().eq('id', id);
      if (error) throw error;
      return;
    }
    if (this.usePostgres) {
      await (await getPool()).query(`delete from "${pgTableName(collection)}" where id = $1`, [id]);
      return;
    }
    memory[collection] = (memory[collection] as Array<{ id: string }>).filter((item) => item.id !== id) as never;
  }

  async getSettings(): Promise<CafeSettings> {
    await this.ensureReady();
    return (await this.getSettingsInternal()) || clone(initialSettings);
  }

  private async getSettingsInternal(): Promise<CafeSettings | null> {
    if (this.useSupabase && supabaseAdmin) {
      const { data, error } = await supabaseAdmin.from('app_settings').select('data').eq('id', 'config').maybeSingle();
      if (error) throw error;
      return data ? clone((data as DataRow<CafeSettings>).data) : null;
    }
    if (this.usePostgres) {
      const { rows } = await (await getPool()).query(`select data from app_settings where id = 'config' limit 1`);
      return rows[0] ? clone(rows[0].data as CafeSettings) : null;
    }
    return clone(memory.settings);
  }

  private async putSettingsInternal(settings: CafeSettings): Promise<CafeSettings> {
    if (this.useSupabase && supabaseAdmin) {
      const timestamp = now();
      const { error } = await supabaseAdmin
        .from('app_settings')
        .upsert({ id: 'config', data: settings, updated_at: timestamp }, { onConflict: 'id' });
      if (error) throw error;
      return clone(settings);
    }
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
    memory.settings = clone(settings);
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
    if (this.useSupabase && supabaseAdmin) {
      const { data, error } = await supabaseAdmin.rpc('next_order_number');
      if (error) throw new Error(`Supabase order counter is unavailable. Run supabase/schema.sql: ${error.message}`);
      return Number(data);
    }
    if (this.usePostgres) {
      try {
        const { rows } = await (await getPool()).query(`select next_order_number() as value`);
        return Number(rows[0]?.value);
      } catch (error) {
        throw new Error(`Postgres order counter is unavailable. Run supabase/schema.sql: ${(error as Error).message}`);
      }
    }
    memoryCounter += 1;
    return memoryCounter;
  }

  async uploadImage(dataUrl: string, productId: string): Promise<string> {
    if (!supabaseAdmin || !this.useSupabase || !dataUrl.startsWith('data:image/')) return dataUrl;
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid image data.');

    const contentType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
    const extension = contentType.split('/')[1].replace('svg+xml', 'svg');
    const objectPath = `products/${productId}-${crypto.randomBytes(5).toString('hex')}.${extension}`;
    const { error } = await supabaseAdmin.storage.from('product-images').upload(objectPath, Buffer.from(match[2], 'base64'), {
      contentType,
      cacheControl: '31536000',
      upsert: false,
    });
    if (error) throw error;
    const { data } = supabaseAdmin.storage.from('product-images').getPublicUrl(objectPath);
    return data.publicUrl;
  }
}

export const store = new RestaurantStore();

export function newId(prefix: string) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

export function getSupabasePublicConfig() {
  return {
    url: config.url,
    anonKey: config.publicAnonKey,
    configured: supabaseConfigured,
  };
}
