/**
 * Payload-level integrity: which fields must never be written, how a snapshot
 * is counted and structurally validated, and the hashing utilities the format
 * and manifest share.
 *
 * The scrubbing rule is the one that protects the customer if a backup ever
 * leaves their machine: connection material belongs to the installation, not to
 * the business data, so it is removed from the payload (the key stays so the
 * restored app does not break).
 */

import type { AppSnapshot } from '../seed.js';
import crypto from 'crypto';
import { BackupError } from './errors.js';
import { BackupRecordCounts } from './types.js';
import fs from 'fs';
import path from 'path';

/**
 * Hard ceilings for anything read out of a file. An imported or downloaded
 * backup is untrusted input: without ceilings a 4 MB "backup" that gunzips to
 * 4 GB (zip bomb) or a manifest with a million records would take the till down
 * while it was being checked.
 */
export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
export const MAX_DECODED_BYTES = 768 * 1024 * 1024;
export const MAX_MANIFEST_RECORDS = 5000;

export function assertSizeLimit(bytes: number, limit: number, what: string): void {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new BackupError(`The ${what} is empty or unreadable.`, 'missing', 400);
  }
  if (bytes > limit) {
    throw new BackupError(
      `The ${what} is ${Math.round(bytes / 1024 / 1024)} MB, above the ${Math.round(limit / 1024 / 1024)} MB limit for backup files.`,
      'size',
      413,
    );
  }
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export let cachedAppVersion = '';

/** Version of the app that wrote a backup (from package.json, cached). */
export function applicationVersion(): string {
  if (cachedAppVersion) return cachedAppVersion;
  const candidates: string[] = [path.join(process.cwd(), 'package.json')];
  try {
    candidates.push(path.resolve(__dirname, '..', '..', 'package.json'));
  } catch {
    /* __dirname is absent in a native-ESM build; cwd is enough there */
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
      if (parsed?.version) return (cachedAppVersion = String(parsed.version));
    } catch {
      /* try next */
    }
  }
  return (cachedAppVersion = '0.0.0');
}

export function emptyCounts(): BackupRecordCounts {
  return { categories: 0, tables: 0, products: 0, orders: 0, feedbacks: 0, waiterCalls: 0 };
}

export function countSnapshot(snapshot: Partial<AppSnapshot>): BackupRecordCounts {
  return {
    categories: snapshot.categories?.length || 0,
    tables: snapshot.tables?.length || 0,
    products: snapshot.products?.length || 0,
    orders: snapshot.orders?.length || 0,
    feedbacks: snapshot.feedbacks?.length || 0,
    waiterCalls: snapshot.waiterCalls?.length || 0,
  };
}

/**
 * Structural validation, run before writing (never persist nonsense) and after
 * reading (never restore nonsense). Checks the fields the app actually breaks
 * on, not every optional one.
 */

/**
 * Structural validation, run before writing (never persist nonsense) and after
 * reading (never restore nonsense). Checks the fields the app actually breaks
 * on, not every optional one.
 */
export function validateSnapshot(snapshot: unknown): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, problems: ['Backup payload is not an object.'] };
  const data = snapshot as Record<string, unknown>;
  if (!data.settings || typeof data.settings !== 'object') problems.push('Missing settings.');
  for (const key of ['categories', 'tables', 'products', 'orders', 'feedbacks', 'waiterCalls'] as const) {
    if (!Array.isArray(data[key])) problems.push(`Missing or invalid "${key}" list.`);
  }
  const orders = Array.isArray(data.orders) ? (data.orders as Array<Record<string, unknown>>) : [];
  for (const order of orders) {
    if (!order || typeof order !== 'object' || !order.id) problems.push('An order has no id.');
    else if (!Array.isArray(order.items)) problems.push(`Order ${String(order.id)} has no item list.`);
    else if (!order.timeline || typeof order.timeline !== 'object') problems.push(`Order ${String(order.id)} has no timeline.`);
  }
  const tables = Array.isArray(data.tables) ? (data.tables as Array<Record<string, unknown>>) : [];
  for (const table of tables) {
    if (!table || !table.id) problems.push('A table has no id.');
    else if (!table.token) problems.push(`Table ${String(table.id)} has no QR token — QR ordering would break.`);
  }
  const products = Array.isArray(data.products) ? (data.products as Array<Record<string, unknown>>) : [];
  for (const product of products) {
    if (!product || !product.id) problems.push('A product has no id.');
  }
  return { ok: problems.length === 0, problems: problems.slice(0, 25) };
}


/**
 * Keys whose values must never reach a backup file. Backups are copied into
 * whoever's cloud account is connected and sometimes onto a brand-new machine,
 * so connection secrets belong to the installation, not to the business data.
 * (DATABASE_URL, the JWT secret and OAuth material never live in the store at
 * all — this also catches `settings.whatsappApiToken` and anything similar.)
 */
export const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api_?key|credential|authorization|access_?key|private_?key|database_?url|connection_?string|session_?key)/i;

/**
 * `CafeTable.token` is the QR-code routing key, not a credential: every printed
 * table standee points at it. Blankening it would be silent data loss — the one
 * thing this subsystem is forbidden to do — so it is exempted by exact name.
 * (Everything else that matches the pattern above is treated as a secret.)
 */

/**
 * `CafeTable.token` is the QR-code routing key, not a credential: every printed
 * table standee points at it. Blankening it would be silent data loss — the one
 * thing this subsystem is forbidden to do — so it is exempted by exact name.
 * (Everything else that matches the pattern above is treated as a secret.)
 */
export const BUSINESS_KEYS_THAT_LOOK_SECRET = new Set(['token']);

export function scrubSecrets<T>(value: T): { value: T; removed: number } {
  let removed = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (SECRET_KEY_PATTERN.test(key) && !BUSINESS_KEYS_THAT_LOOK_SECRET.has(key)) {
          // Keep the key (the app expects the shape) and drop the value.
          if (child !== '' && child !== null && child !== undefined) removed += 1;
          out[key] = typeof child === 'string' ? '' : null;
          continue;
        }
        out[key] = walk(child);
      }
      return out;
    }
    return node;
  };
  return { value: walk(value) as T, removed };
}
