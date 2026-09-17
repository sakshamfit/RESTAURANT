/**
 * The create-backup pipeline:
 *   STORE → SNAPSHOT → VALIDATE → SERIALIZE → COMPRESS → ENCRYPT → HASH
 *   → WRITE TEMP FILE → VERIFY → ATOMIC FINALIZE → RETENTION
 * The cloud upload stage lives in ../../server/cloud/manager.ts and runs after
 * this returns: a verified local backup is already a completed backup, so cloud
 * trouble can never lose data, and can never be reported as a success.
 */

import { store } from '../store.js';
import { resolveBackupDataKey } from './crypto.js';
import { BackupError } from './errors.js';
import { decodeBackup, encodeBackup } from './format.js';
import { countSnapshot, sha256, validateSnapshot } from './integrity.js';
import { classDir, ensureBackupFolders, loadManifest, relativeBackupPath, resolveBackupPath, safeSize, saveManifest, writeAtomically } from './manifest.js';
import { applyRetention } from './retention.js';
import { BACKUP_EXTENSION, BACKUP_SCHEMA_VERSION, BackupHeader, BackupRecord } from './types.js';
import fs from 'fs';
import path from 'path';
import { type BackupClass, type BackupConfig, type BackupTrigger, effectiveBackupDir, loadBackupConfig } from '../backupConfig.js';
import type { AppSnapshot } from '../seed.js';

export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** ISO-8601 week key (Thursday-based), so a week bucket is unambiguous. */

/** ISO-8601 week key (Thursday-based), so a week bucket is unambiguous. */
export function weekKey(date: Date): string {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The newest backup of a period doubles as that period's long-term copy: if it
 * is the first of its month it is kept for the monthly window, else if it is
 * the first of its week it joins the weekly window, else it is a daily.
 */

/**
 * The newest backup of a period doubles as that period's long-term copy: if it
 * is the first of its month it is kept for the monthly window, else if it is
 * the first of its week it joins the weekly window, else it is a daily.
 */
export function classifyBackup(date: Date, trigger: BackupTrigger, existing: BackupRecord[]): BackupClass {
  if (trigger === 'manual' || trigger === 'pre-restore' || trigger === 'initial') return 'manual';
  const automatic = existing.filter((record) => record.trigger === 'daily' || record.trigger === 'startup-catchup');
  const month = monthKey(date);
  const week = weekKey(date);
  if (!automatic.some((record) => monthKey(new Date(record.createdAt)) === month)) return 'monthly';
  if (!automatic.some((record) => weekKey(new Date(record.createdAt)) === week)) return 'weekly';
  return 'daily';
}

/**
 * Runs the full local pipeline. Throws BackupError with an owner-readable
 * message on any problem; on failure no file is left under a final name and
 * nothing is marked verified.
 */


/** Stages of the pipeline, reported so the UI can say what is happening now. */
export type BackupPhase = 'snapshot' | 'validate' | 'key' | 'build' | 'write' | 'verify' | 'finalize';

export const BACKUP_PHASE_LABELS: Record<BackupPhase, string> = {
  snapshot: 'Reading the current data',
  validate: 'Checking it is complete',
  key: 'Unlocking the backup key',
  build: 'Compressing and encrypting',
  write: 'Writing the file',
  verify: 'Reading it back to confirm',
  finalize: 'Updating the backup index',
};

export interface CreateBackupInput {
  trigger: BackupTrigger;
  note?: string;
  /** Needed to unwrap the data key on a session that has not done so yet. */
  password?: string | null;
  /** 'safetyFor' links the pre-restore copy to the backup being restored. */
  safetyFor?: string | null;
  /** Progress hook; it can never make a backup fail. */
  onPhase?: (phase: BackupPhase) => void;
}

export interface CreateBackupResult {
  record: BackupRecord;
  header: BackupHeader;
  durationMs: number;
  encrypted: boolean;
}

/**
 * Runs the full local pipeline. Throws BackupError with an owner-readable
 * message on any problem; on failure no file is left under a final name and
 * nothing is marked verified.
 */
export async function createBackup(input: CreateBackupInput): Promise<CreateBackupResult> {
  const startedAt = Date.now();
  const config = loadBackupConfig();
  const dir = effectiveBackupDir(config);
  const phase = (value: BackupPhase) => {
    try {
      input.onPhase?.(value);
    } catch {
      /* a progress hook must never be able to break a backup */
    }
  };
  phase('snapshot');
  try {
    ensureBackupFolders(dir);
  } catch (error) {
    throw new BackupError(`The backup folder could not be created (${dir}): ${(error as Error)?.message || error}`, 'permission', 500);
  }

  // STORE → SNAPSHOT, always through the existing data layer (never by copying
  // Postgres files or the JSON store out from under a running write).
  let snapshot: AppSnapshot;
  try {
    snapshot = await store.snapshot();
  } catch (error) {
    throw new BackupError(`Could not read the restaurant data for backup: ${(error as Error)?.message || error}`, 'store', 500);
  }

  // VALIDATE — refuse to burn a verified slot on broken data.
  phase('validate');
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) {
    throw new BackupError(`Refused to back up invalid data: ${validation.problems.join(' ')}`, 'validate', 500);
  }

  phase('key');
  const { key: dataKey } = resolveBackupDataKey(input.password ?? null);

  const date = new Date();
  const manifest = loadManifest(dir);
  const meta = {
    restaurantId: config.restaurantId,
    createdAt: date.toISOString(),
    trigger: input.trigger,
    backupClass: classifyBackup(date, input.trigger, manifest.records),
    databaseProvider: store.provider,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    recordCounts: countSnapshot(snapshot),
    note: input.note,
  };

  phase('build');
  let encoded: { buffer: Buffer; header: BackupHeader };
  try {
    encoded = encodeBackup(snapshot, meta, dataKey);
  } catch (error) {
    throw new BackupError(`Could not build the backup: ${(error as Error)?.message || error}`, 'encrypt', 500);
  }

  // WRITE TEMP FILE (+fsync) → ATOMIC FINALIZE (rename) into the folder for this
  // backup class, so the local layout mirrors the customer's cloud layout:
  //   backups/{daily,weekly,monthly,manual}/restaurant-<stamp>.rdbak
  let file: string;
  let relativeFile: string;
  phase('write');
  try {
    ensureBackupFolders(dir);
    file = writeAtomically(classDir(dir, meta.backupClass), encoded.buffer, date);
    relativeFile = relativeBackupPath(dir, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOSPC' || code === 'EDQUOT') {
      throw new BackupError('Not enough free disk space to write a backup. Free space, or choose another backup folder under Automatic backup settings.', 'disk-full', 507);
    }
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new BackupError(`The backup folder is not writable (${code}): ${dir}`, 'permission', 500);
    }
    throw new BackupError(`Could not write the backup file: ${(error as Error)?.message || error}`, 'write', 500);
  }

  // VERIFY — read back what is actually on disk, end to end.
  phase('verify');
  let fileSha256 = '';
  try {
    const written = fs.readFileSync(file);
    fileSha256 = sha256(written);
    const decoded = decodeBackup(written, dataKey);
    if (decoded.header.checksum !== encoded.header.checksum || decoded.header.contentSha256 !== encoded.header.contentSha256) {
      throw new BackupError('Backup verification failed: the file on disk does not match what was written.', 'verify');
    }
    if (decoded.header.recordCounts.orders !== encoded.header.recordCounts.orders) {
      throw new BackupError('Backup verification failed: order count changed while the backup was written.', 'verify');
    }
  } catch (error) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* unverified and unlisted: it will never be offered for restore */
    }
    if (error instanceof BackupError) throw error;
    throw new BackupError(`Backup verification failed: ${(error as Error)?.message || error}`, 'verify');
  }

  const record: BackupRecord = {
    id: path.basename(file, BACKUP_EXTENSION),
    file: relativeFile,
    createdAt: encoded.header.createdAt,
    trigger: encoded.header.trigger,
    backupClass: encoded.header.backupClass,
    bytes: safeSize(file) || encoded.buffer.length,
    checksum: encoded.header.checksum,
    fileSha256,
    recordCounts: encoded.header.recordCounts,
    databaseProvider: encoded.header.databaseProvider,
    restaurantId: encoded.header.restaurantId,
    verified: true,
    verifiedAt: new Date().toISOString(),
    safetyFor: input.safetyFor || null,
    note: input.note,
    cloud: null,
  };

  phase('finalize');
  manifest.records.unshift(record);
  const retention = applyRetention(manifest.records, config.retention);
  for (const stale of retention.removed) {
    try {
      fs.rmSync(resolveBackupPath(dir, stale), { force: true });
    } catch (error) {
      // Keeping more than intended is safe; deleting is best-effort.
      console.warn(`[backup] Retention kept ${stale} because it could not be deleted:`, (error as Error)?.message);
    }
  }
  manifest.records = retention.kept;
  saveManifest(manifest, dir);

  return { record, header: encoded.header, durationMs: Date.now() - startedAt, encrypted: Boolean(dataKey) };
}

