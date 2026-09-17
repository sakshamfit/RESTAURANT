import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Persistent configuration for the backup / data-protection subsystem.
 *
 * Deliberately NOT stored in `data/restaurant.json` and NOT stored in the
 * business database:
 *
 *  1. Backup settings must survive the failures they exist to recover from. If
 *     the data file is deleted or corrupted, `restaurantId`, retention rules
 *     and the cloud link must still be present so recovery on a fresh install
 *     can find this restaurant's own backups in the cloud.
 *  2. Anything living in `restaurant.json` is copied INTO every backup. Backup
 *     configuration must never ride inside the payload it describes, and secrets
 *     must never be smuggled into business data that goes to a cloud account.
 *
 * Same placement convention as `data/admin.json` / `data/audit.log`, so the
 * desktop build keeps it under the user's data folder and Vercel uses /tmp.
 *
 * Secrets this file must never contain: OAuth tokens (see credentials.ts) and
 * the backup data key in the clear. What it does hold is a KDF salt, a key
 * verifier and the data key wrapped under the owner's password — useless to a
 * thief who does not have the password, and useless without the OS credential
 * store copy for an unattended nightly run.
 */

export type CloudProviderId = 'google-drive' | 'onedrive' | 'dropbox';

export interface CloudConnectionInfo {
  provider: CloudProviderId;
  connectedAt: string;
  /** Human-readable location for the UI, e.g. "Restaurant Backup / Café XYZ". */
  folderLabel: string;
  /** Provider-side path of the backup folder. */
  folderPath: string;
  /** Opaque provider folder id — not a secret, and never needed in a backup. */
  folderId: string | null;
  /** Connected cloud account label (email / display name) for the UI. */
  accountLabel: string | null;
  /**
   * OAuth client id. For the native/installed app types this app uses (public
   * client + PKCE, no client secret) the id is not a secret, and it is needed
   * to refresh tokens without asking the owner to authorize again. A client
   * SECRET, if the owner configured a confidential Google client, lives in the
   * OS credential store only.
   */
  clientId: string | null;
  /** Set when the provider was swapped, so both histories stay visible. */
  supersededAt?: string | null;
}

/**
 * Owner-chosen backup password protects a random 256-bit data key (DEK); the
 * DEK is what actually encrypts backups. `wrappedKey` is that DEK encrypted
 * under scrypt(password, salt), so the password can be changed or re-entered
 * without re-encrypting anything, and the password itself is never stored.
 */
export interface BackupEncryptionConfig {
  mode: 'password' | 'none';
  kdf: 'scrypt';
  /** base64, 32 random bytes, per installation (never per file). */
  salt: string;
  /** hex sha256(KEK): proves a password guess without storing anything. */
  verifier: string;
  /** AES-256-GCM wrapped data key. */
  wrappedKey: { iv: string; tag: string; ciphertext: string } | null;
  updatedAt: string;
}

export interface BackupRetentionConfig {
  daily: number;
  weekly: number;
  monthly: number;
}

export type BackupTrigger = 'manual' | 'daily' | 'startup-catchup' | 'pre-restore' | 'initial';
export type BackupClass = 'daily' | 'weekly' | 'monthly' | 'manual';

export interface BackupScheduleConfig {
  enabled: boolean;
  /** "HH:MM" local time; default 02:30 — after last service, before prep. */
  dailyTime: string;
  lastDailyRunAt: string | null;
  lastRunAt: string | null;
  lastTrigger: BackupTrigger | null;
  lastOutcome: 'success' | 'failure' | null;
  lastError: string | null;
  /** Backoff + escalation input for repeated failures. */
  consecutiveFailures: number;
}

export interface BackupConfig {
  version: 1;
  /** Stable installation identity, embedded in every backup + cloud folder. */
  restaurantId: string;
  restaurantIdCreatedAt: string;
  /** null = OS default (see defaultBackupDir). */
  localDir: string | null;
  retention: BackupRetentionConfig;
  schedule: BackupScheduleConfig;
  encryption: BackupEncryptionConfig | null;
  cloud: CloudConnectionInfo | null;
  /** Providers connected before a provider change (history stays visible). */
  retiredCloud: CloudConnectionInfo[];
  firstRun: {
    /** Set once the owner has seen the "protect your data" prompt. */
    promptedAt: string | null;
    /** "Maybe later" — drives the subtle reminder, never a blocking popup. */
    dismissedAt: string | null;
    remindAfter: string | null;
  };
  updatedAt: string;
}

const CONFIG_FILE_NAME = 'backup-config.json';
const DEFAULT_RETENTION: BackupRetentionConfig = { daily: 14, weekly: 12, monthly: 12 };
export const DEFAULT_DAILY_TIME = '02:30';
/** scrypt parameters: 32 MB memory cost, the OWASP-recommended interactive setting. */
export const SCRYPT_OPTS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function dataDir(): string {
  return process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/restaurant-data' : path.join(process.cwd(), 'data'));
}

function configFile(): string {
  return path.join(dataDir(), CONFIG_FILE_NAME);
}

/**
 * Backups live OUTSIDE the installation directory: the app folder is replaced
 * by every update (and removed by an uninstall) — one of the exact failure
 * modes this feature exists to survive.
 */
export function defaultBackupDir(): string {
  // An operator who keeps backups on another drive can say so once, in the
  // environment, without opening the app. A per-installation folder chosen in
  // Admin → Backup & Recovery still wins (see effectiveBackupDir).
  const fromEnv = typeof process.env.BACKUP_DIR === 'string' ? process.env.BACKUP_DIR.trim() : '';
  if (fromEnv) return path.resolve(fromEnv);
  if (process.env.VERCEL) {
    // Serverless: the only writable place is /tmp, and it is wiped between
    // invocations. Kept working on purpose (the app must never crash over a
    // backup folder) — docs/BACKUP.md tells hosted customers to use their own
    // cloud storage instead of trusting this path.
    return path.join('/tmp/restaurant-data', 'backups');
  }
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return path.join(base, 'NEXORAOSP Restaurant', 'backups');
}

export function effectiveBackupDir(config: BackupConfig = loadBackupConfig()): string {
  const custom = typeof config.localDir === 'string' ? config.localDir.trim() : '';
  return custom ? path.resolve(custom) : defaultBackupDir();
}

function freshConfig(): BackupConfig {
  const now = new Date().toISOString();
  return {
    version: 1,
    restaurantId: `rst-${crypto.randomBytes(8).toString('hex')}`,
    restaurantIdCreatedAt: now,
    localDir: null,
    retention: { ...DEFAULT_RETENTION },
    schedule: {
      enabled: true,
      dailyTime: DEFAULT_DAILY_TIME,
      lastDailyRunAt: null,
      lastRunAt: null,
      lastTrigger: null,
      lastOutcome: null,
      lastError: null,
      consecutiveFailures: 0,
    },
    encryption: null,
    cloud: null,
    retiredCloud: [],
    firstRun: { promptedAt: null, dismissedAt: null, remindAfter: null },
    updatedAt: now,
  };
}

let cache: { raw: string; config: BackupConfig } | null = null;

/**
 * Reads the config, healing what it can. A missing file is normal (first run)
 * and yields defaults; a corrupt file is preserved beside a fresh config
 * instead of being thrown away — the same discipline store.ts applies to
 * `restaurant.json`, because losing `restaurantId` orphans every backup.
 */
export function loadBackupConfig(): BackupConfig {
  const file = configFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    const config = freshConfig();
    // Persist at once: the restaurantId must be stable from the first run,
    // otherwise a backup taken before the first write would be orphaned.
    writeConfig(config, file);
    return config;
  }
  if (cache && cache.raw === raw) return cache.config;

  let parsed: Partial<BackupConfig> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<BackupConfig>;
  } catch (error) {
    const rescue = `${file}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(file, rescue);
      console.error(
        `[backup] ${file} is not valid JSON (${(error as Error)?.message || error}). Preserved at ${rescue}; continuing with fresh settings.`
      );
    } catch {
      console.error(`[backup] ${file} is not valid JSON and could not be preserved; continuing with fresh settings.`);
    }
  }

  const base = freshConfig();
  const config: BackupConfig = {
    ...base,
    ...(parsed || {}),
    version: 1,
    // Identity is immutable on purpose: regenerating it would orphan every
    // existing backup of this restaurant (local and in the cloud).
    restaurantId: typeof parsed?.restaurantId === 'string' && parsed.restaurantId ? parsed.restaurantId : base.restaurantId,
    restaurantIdCreatedAt:
      typeof parsed?.restaurantIdCreatedAt === 'string' ? parsed.restaurantIdCreatedAt : base.restaurantIdCreatedAt,
    retention: { ...base.retention, ...(parsed?.retention || {}) },
    schedule: { ...base.schedule, ...(parsed?.schedule || {}) },
    firstRun: { ...base.firstRun, ...(parsed?.firstRun || {}) },
    retiredCloud: Array.isArray(parsed?.retiredCloud) ? parsed!.retiredCloud : [],
  };
  if (!/^\d{2}:\d{2}$/.test(String(config.schedule.dailyTime || ''))) config.schedule.dailyTime = DEFAULT_DAILY_TIME;
  cache = { raw, config: clone(config) };
  return config;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function writeConfig(config: BackupConfig, file: string) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(config, null, 2);
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* read-only filesystems: the write succeeding is what matters */
  }
  cache = { raw: payload, config: clone(config) };
}

/** The only writer. Merges one level deep over a freshly read file so two
 *  handlers touching different keys cannot clobber each other. */
export function updateBackupConfig(
  patch: Partial<BackupConfig> | ((current: BackupConfig) => Partial<BackupConfig>)
): BackupConfig {
  const current = loadBackupConfig();
  const delta = typeof patch === 'function' ? patch(current) : patch;
  const next: BackupConfig = {
    ...current,
    ...delta,
    retention: { ...current.retention, ...(delta.retention || {}) },
    schedule: { ...current.schedule, ...(delta.schedule || {}) },
    firstRun: { ...current.firstRun, ...(delta.firstRun || {}) },
    updatedAt: new Date().toISOString(),
  };
  writeConfig(next, configFile());
  return next;
}

// ── encryption password handling ─────────────────────────────────────────────

export interface DataKeyWrap {
  /** base64 AES-256-GCM wrapped 32-byte data key. */
  wrappedKey: { iv: string; tag: string; ciphertext: string };
  salt: string;
  verifier: string;
}

function keyEncryptionKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, 32, SCRYPT_OPTS);
}

/** Generates a fresh data key and wraps it under the owner's password. */
export function createEncryptionConfig(password: string): { config: BackupEncryptionConfig; dataKey: Buffer } {
  const salt = crypto.randomBytes(32);
  const dataKey = crypto.randomBytes(32);
  const kek = keyEncryptionKey(password, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return {
    dataKey,
    config: {
      mode: 'password',
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      verifier: crypto.createHash('sha256').update(kek).digest('hex'),
      wrappedKey: { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') },
      updatedAt: new Date().toISOString(),
    },
  };
}

/** Proves the password by hashing the derived KEK — no secret is compared. */
export function keyMatchesPassword(config: BackupEncryptionConfig | null, password: string): boolean {
  if (!config || config.mode !== 'password') return false;
  try {
    const kek = keyEncryptionKey(password, Buffer.from(config.salt, 'base64'));
    return crypto.createHash('sha256').update(kek).digest('hex') === config.verifier;
  } catch {
    return false;
  }
}

/** Unwraps the data key with the owner's password (recovery on a new machine). */
export function unwrapDataKey(config: BackupEncryptionConfig, password: string): Buffer | null {
  if (!config.wrappedKey) return null;
  try {
    const kek = keyEncryptionKey(password, Buffer.from(config.salt, 'base64'));
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      kek,
      Buffer.from(config.wrappedKey.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(config.wrappedKey.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(config.wrappedKey.ciphertext, 'base64')), decipher.final()]);
  } catch {
    // GCM tag failure == wrong password or a tampered wrapper. Same answer.
    return null;
  }
}

/** Re-wraps an existing data key under a new password (key rotation). */
export function rewrapDataKey(config: BackupEncryptionConfig, oldPassword: string, newPassword: string): { config: BackupEncryptionConfig; dataKey: Buffer } | null {
  const dataKey = unwrapDataKey(config, oldPassword);
  if (!dataKey) return null;
  const fresh = createEncryptionConfig(newPassword);
  // Keep the data key stable so existing backups stay readable; only the
  // wrapper changes.
  const salt = Buffer.from(fresh.config.salt, 'base64');
  const kek = keyEncryptionKey(newPassword, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return {
    dataKey,
    config: {
      mode: 'password',
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      verifier: crypto.createHash('sha256').update(kek).digest('hex'),
      wrappedKey: { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') },
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * What the admin UI may see. The shape is explicit so a future field cannot
 * accidentally reach the browser: everything not listed here stays server-side.
 */
export function publicBackupConfig(config: BackupConfig = loadBackupConfig()) {
  return {
    restaurantId: config.restaurantId,
    localDir: config.localDir || defaultBackupDir(),
    defaultLocalDir: defaultBackupDir(),
    retention: config.retention,
    schedule: config.schedule,
    encryption: config.encryption
      ? { mode: config.encryption.mode, kdf: config.encryption.kdf, updatedAt: config.encryption.updatedAt, hasWrappedKey: Boolean(config.encryption.wrappedKey) }
      : null,
    cloud: config.cloud
      ? {
          provider: config.cloud.provider,
          connectedAt: config.cloud.connectedAt,
          folderLabel: config.cloud.folderLabel,
          folderPath: config.cloud.folderPath,
          accountLabel: config.cloud.accountLabel,
          clientId: config.cloud.clientId,
        }
      : null,
    retiredCloud: config.retiredCloud.map((entry) => ({
      provider: entry.provider,
      folderLabel: entry.folderLabel,
      connectedAt: entry.connectedAt,
      supersededAt: entry.supersededAt || null,
    })),
    firstRun: config.firstRun,
  };
}

/**
 * First-run prompt bookkeeping. Dismissing is never permanent: it schedules a
 * subtler reminder for next week. Seeing the prompt at all is remembered, so the
 * dialog never blocks the POS twice, and once the restaurant is actually protected
 * the reminder stops.
 */
export function dismissFirstRunPrompt(now = new Date()): void {
  updateBackupConfig((current) => ({
    ...current,
    firstRun: {
      promptedAt: current.firstRun.promptedAt || now.toISOString(),
      dismissedAt: now.toISOString(),
      remindAfter: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  }));
}

/** Called when the owner has finished setup (a verified backup exists, or cloud connected). */
export function completeFirstRun(now = new Date()): void {
  updateBackupConfig((current) => ({
    ...current,
    firstRun: { promptedAt: current.firstRun.promptedAt || now.toISOString(), dismissedAt: null, remindAfter: null },
  }));
}

/** True when the first-run dialog should appear (never when data is already safe). */
export function shouldPromptFirstRun(config: BackupConfig = loadBackupConfig(), hasVerifiedBackup = false): boolean {
  if (hasVerifiedBackup || config.cloud) return false;
  if (!config.firstRun.promptedAt) return true;
  if (!config.firstRun.remindAfter) return false;
  return Date.parse(config.firstRun.remindAfter) <= Date.now();
}
