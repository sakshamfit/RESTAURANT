import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();
import { AppSnapshot, createMemorySnapshot, initialCategories, initialProducts, initialSettings, initialTables } from './seed';
import { CafeCategory, CafeSettings, CafeTable, CustomerFeedback, Order, Product, WaiterCall } from '../types';

export type StoreCollection = 'categories' | 'tables' | 'products' | 'orders' | 'feedbacks' | 'waiterCalls';

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
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const publicAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  const authKey = publicAnonKey || serviceKey;
  return { url, serviceKey, publicAnonKey, authKey, configured: Boolean(url && serviceKey) };
}

const config = getSupabaseConfig();

export const supabaseConfigured = config.configured;
export const supabaseAdmin: SupabaseClient | null = config.configured
  ? createClient(config.url, config.serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

// A separate, non-persisting client is used only for password sign-in. The service-role
// key never reaches the browser.
export const supabaseAuth: SupabaseClient | null = config.configured
  ? createClient(config.url, config.authKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

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
 * The application has one persistence layer. Supabase is used whenever its server
 * credentials are present. The in-memory branch exists only so a fresh clone can be
 * previewed before the owner adds Supabase secrets; it never reads or writes a local
 * database file.
 */
export class RestaurantStore {
  private ready: Promise<void>;

  constructor() {
    this.ready = this.initialize();
  }

  get provider(): 'supabase' | 'memory-preview' {
    return supabaseConfigured ? 'supabase' : 'memory-preview';
  }

  async waitUntilReady() {
    await this.ready;
  }

  private async initialize() {
    if (!supabaseAdmin) return;

    const { error } = await supabaseAdmin.from('app_settings').select('id').eq('id', 'config').maybeSingle();
    if (error) {
      if (isMissingTableError(error)) {
        throw new Error('Supabase is configured but the database schema is missing. Run supabase/schema.sql in the Supabase SQL Editor.');
      }
      throw error;
    }

    // Seed only missing records. Existing menu edits and orders are never overwritten.
    const settings = await this.getSettingsInternal();
    if (!settings) await this.putSettingsInternal(initialSettings);
    await this.seedMissing('categories', initialCategories);
    await this.seedMissing('tables', initialTables);
    await this.seedMissing('products', initialProducts);
    await this.ensureCounter();
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
    if (!supabaseAdmin) return;
    const { error } = await supabaseAdmin
      .from('app_counters')
      .upsert({ id: 'orders', value: 1040 }, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw error;
  }

  private async listInternal<C extends StoreCollection>(collection: C): Promise<CollectionModel[C][]> {
    if (!supabaseAdmin) {
      return clone(memory[collection] as CollectionModel[C][]);
    }

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

  private async getInternal<C extends StoreCollection>(collection: C, id: string): Promise<CollectionModel[C] | null> {
    if (!supabaseAdmin) {
      const record = (memory[collection] as CollectionModel[C][]).find((item) => item.id === id);
      return record ? clone(record) : null;
    }

    const { data, error } = await supabaseAdmin
      .from(TABLES[collection])
      .select('id,data')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data ? ({ ...clone((data as DataRow<CollectionModel[C]>).data), id: data.id } as CollectionModel[C]) : null;
  }

  private async putInternal<C extends StoreCollection>(collection: C, id: string, record: CollectionModel[C]) {
    const value = { ...clone(record), id };
    if (!supabaseAdmin) {
      const records = memory[collection] as CollectionModel[C][];
      const index = records.findIndex((item) => item.id === id);
      if (index === -1) records.unshift(value);
      else records[index] = value;
      return value;
    }

    const timestamp = now();
    const { error } = await supabaseAdmin.from(TABLES[collection]).upsert(
      { id, data: value, updated_at: timestamp, created_at: timestamp },
      { onConflict: 'id' }
    );
    if (error) throw error;
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
    if (!supabaseAdmin) {
      memory[collection] = (memory[collection] as Array<{ id: string }>).filter((item) => item.id !== id) as never;
      return;
    }
    const { error } = await supabaseAdmin.from(TABLES[collection]).delete().eq('id', id);
    if (error) throw error;
  }

  async getSettings(): Promise<CafeSettings> {
    await this.ensureReady();
    return (await this.getSettingsInternal()) || clone(initialSettings);
  }

  private async getSettingsInternal(): Promise<CafeSettings | null> {
    if (!supabaseAdmin) return clone(memory.settings);
    const { data, error } = await supabaseAdmin.from('app_settings').select('data').eq('id', 'config').maybeSingle();
    if (error) throw error;
    return data ? clone((data as DataRow<CafeSettings>).data) : null;
  }

  private async putSettingsInternal(settings: CafeSettings): Promise<CafeSettings> {
    if (!supabaseAdmin) {
      memory.settings = clone(settings);
      return clone(settings);
    }
    const timestamp = now();
    const { error } = await supabaseAdmin
      .from('app_settings')
      .upsert({ id: 'config', data: settings, updated_at: timestamp }, { onConflict: 'id' });
    if (error) throw error;
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
    if (!supabaseAdmin) {
      memoryCounter += 1;
      return memoryCounter;
    }
    const { data, error } = await supabaseAdmin.rpc('next_order_number');
    if (error) throw new Error(`Supabase order counter is unavailable. Run supabase/schema.sql: ${error.message}`);
    return Number(data);
  }

  async uploadImage(dataUrl: string, productId: string): Promise<string> {
    if (!supabaseAdmin || !dataUrl.startsWith('data:image/')) return dataUrl;
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
