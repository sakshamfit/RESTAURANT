/**
 * Types and constants of the `.rdbak` backup format and of the local backup
 * index (manifest). Deliberately dependency-free (types only) so every other
 * module in this folder can import them without creating a cycle.
 */
import type { AppSnapshot } from '../seed.js';
import type { BackupClass, BackupTrigger, CloudProviderId } from '../backupConfig.js';


/**
 * Backup engine: the `.rdbak` format, the write/verify pipeline, the on-disk
 * manifest, retention, and restore with a guaranteed safety copy.
 *
 * Pipeline (`createBackup`):
 *   STORE → SNAPSHOT → VALIDATE → SERIALIZE → COMPRESS → ENCRYPT → HASH
 *   → WRITE TEMP FILE → VERIFY → ATOMIC FINALIZE
 * Cloud upload is a later stage (backupProtection.ts): a backup counts as
 * verified — and is reported as such — the moment the LOCAL file verifies, so a
 * cloud outage can never lose data, block the POS, or be dressed up as success.
 *
 * Data-safety invariants:
 *   • an existing backup file is never overwritten (temp file + rename);
 *   • a backup is only listed as verified after it has been read back, sized,
 *     hashed, decrypted and structurally revalidated;
 *   • retention never prunes the newest verified backup, nor the last one;
 *   • restore writes and verifies a safety copy of the CURRENT data first and
 *     rolls the store back if applying the chosen backup fails;
 *   • connection secrets are scrubbed out of the payload and never written into
 *     a backup file or the manifest.
 */

export const BACKUP_FORMAT_VERSION = 1;
/** Bumped when the shape of the stored business data changes (db/schema.sql). */

/** Bumped when the shape of the stored business data changes (db/schema.sql). */
export const BACKUP_SCHEMA_VERSION = 1;

export const BACKUP_MAGIC = 'RDBAK1';

export const BACKUP_EXTENSION = '.rdbak';

export interface BackupRecordCounts {
  categories: number;
  tables: number;
  products: number;
  orders: number;
  feedbacks: number;
  waiterCalls: number;
}

export interface BackupCryptoInfo {
  mode: 'none' | 'aes-256-gcm';
  kdf?: 'scrypt-wrapped-key';
  /** base64 per-file IV. The KDF salt lives in the config, never here. */
  iv?: string;
}

/**
 * Plaintext envelope: everything needed to locate, identify and verify a
 * backup without the key. Contains no business data and no secrets — only
 * counts, versions, timestamps and hashes.
 */

/**
 * Plaintext envelope: everything needed to locate, identify and verify a
 * backup without the key. Contains no business data and no secrets — only
 * counts, versions, timestamps and hashes.
 */
export interface BackupHeader {
  backupVersion: number;
  applicationVersion: string;
  restaurantId: string;
  createdAt: string;
  trigger: BackupTrigger;
  backupClass: BackupClass;
  databaseProvider: 'postgres' | 'file';
  schemaVersion: number;
  recordCounts: BackupRecordCounts;
  /** bytes of the uncompressed JSON payload */
  payloadBytes: number;
  /** bytes of the gzip stream */
  archiveBytes: number;
  /** bytes of the stored (encrypted or plain) blob */
  cipherBytes: number;
  /** sha256 of the JSON payload, checked after decrypting */
  contentSha256: string;
  /** sha256 of the stored blob — the backup "checksum" from the spec */
  checksum: string;
  encryption: BackupCryptoInfo;
  /** secret-bearing fields blanked out before the payload was written */
  scrubbedSecretFields: number;
  note?: string;
}

export interface BackupCloudState {
  provider: CloudProviderId;
  status: 'pending' | 'uploading' | 'uploaded' | 'verified' | 'failed';
  remoteId?: string | null;
  remotePath?: string | null;
  remoteBytes?: number;
  remoteHash?: string | null;
  attempts?: number;
  lastAttemptAt?: string | null;
  uploadedAt?: string | null;
  verifiedAt?: string | null;
  /** exponential backoff for offline / transient cloud failures */
  nextAttemptAt?: string | null;
  error?: string | null;
  /** provider-specific resumable-upload session, so an interrupted PUT continues */
  resume?: Record<string, unknown> | null;
}

export interface BackupRecord {
  id: string;
  file: string;
  createdAt: string;
  trigger: BackupTrigger;
  backupClass: BackupClass;
  bytes: number;
  checksum: string;
  /** sha256 of the whole .rdbak file, for cloud/off-site comparison */
  fileSha256: string;
  recordCounts: BackupRecordCounts;
  databaseProvider: 'postgres' | 'file';
  restaurantId: string;
  verified: boolean;
  verifiedAt: string | null;
  /** Marks the copy taken before a restore: never pruned. */
  safetyFor?: string | null;
  imported?: boolean;
  note?: string;
  cloud: BackupCloudState | null;
}

export interface Manifest {
  version: 1;
  records: BackupRecord[];
}

export interface BackupPayload {
  header: BackupHeader;
  snapshot: AppSnapshot;
}

export interface BackupListEntry extends BackupRecord {
  fileName: string;
  encrypted: boolean;
  missing: boolean;
  /** Header says a different installation wrote this file. */
  foreignRestaurant: boolean;
  damaged: boolean;
}
