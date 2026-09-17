/**
 * Restore, import, export and delete.
 *
 * Restore is the only operation here that changes live data, and it is
 * structured so it can never leave the restaurant worse off than it found them:
 * verify the chosen file → create and verify a safety backup of the CURRENT data
 * → apply → re-validate → on any failure roll back (in-memory previous snapshot,
 * falling back to the verified safety file).
 */

import fs from 'fs';
import path from 'path';
import { store } from '../store.js';
import { resolveBackupDataKey } from './crypto.js';
import { BackupError } from './errors.js';
import { decodeBackup, peekHeader } from './format.js';
import { assertSizeLimit, countSnapshot, MAX_BACKUP_BYTES, sha256, validateSnapshot } from './integrity.js';
import { backupDir, classDir, ensureBackupFolders, listBackups, loadManifest, relativeBackupPath, resolveBackupPath, safeSize, saveManifest, writeAtomically } from './manifest.js';
import { CreateBackupResult, createBackup } from './service.js';
import { BACKUP_EXTENSION, BACKUP_SCHEMA_VERSION, BackupHeader, BackupListEntry, BackupPayload, BackupRecord, BackupRecordCounts } from './types.js';
import { type BackupClass, type BackupConfig, type BackupTrigger, effectiveBackupDir, loadBackupConfig } from '../backupConfig.js';
import type { AppSnapshot } from '../seed.js';

/**
 * The key only matters for files that are actually encrypted. Requiring one for a
 * plaintext backup (or for an older file written before a password existed) would be
 * a needless dead end, so the header decides.
 */
function dataKeyForHeader(header: BackupHeader | null, password?: string | null): Buffer | null {
  if (header && header.encryption && header.encryption.mode !== 'none') return resolveBackupDataKey(password ?? null).key;
  if (password) return resolveBackupDataKey(password).key;
  const resolved = resolveBackupDataKeyOrNone();
  return resolved;
}

/** Same lookup, but a missing key is allowed to mean "no encryption in use". */
function resolveBackupDataKeyOrNone(): Buffer | null {
  try {
    return resolveBackupDataKey(null).key;
  } catch {
    return null;
  }
}

/**
 * Absolute path of a record, always derived from the manifest-relative path (never
 * from a path a caller may have carried in from an old listing or an edited
 * manifest) and always re-checked to stay inside the backup folder.
 */
export function backupRecordFile(record: BackupListEntry | BackupRecord): string {
  return resolveBackupPath(backupDir(), record.file);
}

/** Verifies an on-disk backup and returns its decoded payload. */
export function openBackupFile(record: BackupListEntry | BackupRecord, password?: string | null): BackupPayload {
  const file = backupRecordFile(record);
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    throw new BackupError(`The backup file "${record.file}" is missing from the backup folder.`, 'missing', 404);
  }
  const header = peekHeader(buffer);
  return decodeBackup(buffer, dataKeyForHeader(header, password ?? null));
}

export interface RestoreInput {
  recordId: string;
  password?: string | null;
  /** Required to restore a backup written by a different installation. */
  acknowledgeForeignRestaurant?: boolean;
}

export interface RestoreResult {
  ok: true;
  restoredFrom: { id: string; file: string; createdAt: string; recordCounts: BackupRecordCounts };
  safetyBackup: BackupRecord | null;
  verifiedCounts: BackupRecordCounts;
  warnings: string[];
  message: string;
}

/**
 * RESTORE — never immediately destructive:
 *   verify chosen backup → verify a fresh SAFETY backup of current data →
 *   apply → validate the applied state → roll back on any failure.
 */

/**
 * RESTORE — never immediately destructive:
 *   verify chosen backup → verify a fresh SAFETY backup of current data →
 *   apply → validate the applied state → roll back on any failure.
 */
export async function restoreBackup(input: RestoreInput): Promise<RestoreResult> {
  const config = loadBackupConfig();
  const dir = effectiveBackupDir(config);
  const entry = listBackups(dir, config).find((candidate) => candidate.id === input.recordId);
  if (!entry) throw new BackupError('That backup is not in the backup folder on this computer.', 'not-found', 404);
  if (entry.missing || entry.damaged) throw new BackupError(`"${entry.file}" cannot be restored: the file is missing or unreadable.`, 'missing', 404);

  const warnings: string[] = [];
  const payload = openBackupFile(entry, input.password ?? null);

  if (payload.header.restaurantId && payload.header.restaurantId !== config.restaurantId) {
    if (!input.acknowledgeForeignRestaurant) {
      throw new BackupError(
        `This backup belongs to a different installation (${payload.header.restaurantId}). Restoring it replaces this computer's data. Confirm to continue.`,
        'restaurant-mismatch',
        409
      );
    }
    warnings.push(`Data came from installation ${payload.header.restaurantId}.`);
  }
  if (payload.header.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new BackupError('This backup was written by a newer version of the app. Update the application before restoring it.', 'version', 409);
  }
  if (payload.header.databaseProvider && payload.header.databaseProvider !== store.provider) {
    warnings.push(
      `Backup was taken while using ${payload.header.databaseProvider === 'postgres' ? 'PostgreSQL' : 'local file'} storage; it is now being applied to ${store.provider === 'postgres' ? 'PostgreSQL' : 'the local file'} store.`
    );
  }

  // 1. SAFETY BACKUP of the current data, verified, before anything changes.
  let safety: CreateBackupResult | null = null;
  try {
    safety = await createBackup({
      trigger: 'pre-restore',
      safetyFor: entry.id,
      password: input.password ?? null,
      note: `Safety copy taken automatically before restoring ${entry.id}`,
    });
  } catch (error) {
    throw new BackupError(
      `Restore aborted: the safety copy of your current data could not be created (${(error as Error)?.message || error}). Nothing was changed.`,
      'safety-failed',
      500
    );
  }

  let previous: AppSnapshot;
  try {
    previous = await store.snapshot();
  } catch (error) {
    throw new BackupError(`Restore aborted before making any change: ${(error as Error)?.message || error}`, 'store', 500);
  }

  // 2. APPLY
  try {
    await store.replaceSnapshot(payload.snapshot);
  } catch (error) {
    // 3. ROLLBACK — in-memory previous state first, verified file as fallback.
    let rolledBack = false;
    try {
      await store.replaceSnapshot(previous);
      rolledBack = true;
    } catch {
      try {
        const safetyEntry = listBackups(dir, config).find((candidate) => candidate.id === safety!.record.id);
        if (safetyEntry) {
          await store.replaceSnapshot(openBackupFile(safetyEntry, input.password ?? null).snapshot);
          rolledBack = true;
        }
      } catch (nested) {
        console.error('[backup] Automatic rollback failed:', (nested as Error)?.message || nested);
      }
    }
    if (!rolledBack) {
      throw new BackupError(
        `Restore failed and could not be rolled back automatically. Your data before the attempt is safe in ${safety.record.file} — use "Restore Local Backup" to recover it.`,
        'rollback-failed',
        500
      );
    }
    throw new BackupError(`Restore failed partway, so your previous data was restored instead: ${(error as Error)?.message || error}`, 'restore-rolled-back', 500);
  }

  // 4. VALIDATE what is now live against what the file promised.
  let after: AppSnapshot;
  try {
    after = await store.snapshot();
  } catch (error) {
    throw new BackupError(
      `The restore was applied but could not be re-read for verification (${(error as Error)?.message || error}). Your previous data is in ${safety.record.file}.`,
      'validate',
      500
    );
  }
  const afterCounts = countSnapshot(after);
  const expected = payload.header.recordCounts;
  const mismatch = (Object.keys(expected) as (keyof BackupRecordCounts)[]).filter((key) => afterCounts[key] !== expected[key]);
  if (mismatch.length > 0) {
    warnings.push(`Row counts differ from the backup for: ${mismatch.join(', ')}. Orders may have arrived while the restore was running.`);
  }
  const postValidation = validateSnapshot(after);
  if (!postValidation.ok) {
    throw new BackupError(
      `The restored data did not validate (${postValidation.problems.join(' ')}). Recover your previous data from ${safety.record.file}.`,
      'post-restore-validate',
      500
    );
  }

  return {
    ok: true,
    restoredFrom: { id: entry.id, file: entry.file, createdAt: entry.createdAt, recordCounts: expected },
    safetyBackup: safety.record,
    verifiedCounts: afterCounts,
    warnings,
    message: `Restored ${entry.id}. A safety copy of the previous data is available as ${safety.record.file}.`,
  };
}



export interface ImportResult {
  record: BackupRecord;
  header: BackupHeader;
  warning: string | null;
  /** Cloud status of the imported file is unknown until the owner uploads it. */
}

/**
 * Import a `.rdbak` the owner kept (USB stick, downloaded copy). The file is
 * verified and registered as a manual local backup — importing never changes
 * business data by itself; the owner still chooses Restore.
 */

/**
 * Import a `.rdbak` the owner kept (USB stick, downloaded copy). The file is
 * verified and registered as a manual local backup — importing never changes
 * business data by itself; the owner still chooses Restore.
 */
export async function importBackup(bytes: Buffer, password?: string | null): Promise<ImportResult> {
  // An imported file is untrusted input, so it is size-capped before it is parsed.
  assertSizeLimit(bytes.length, MAX_BACKUP_BYTES, 'backup file');
  const config = loadBackupConfig();
  const dir = effectiveBackupDir(config);
  // Peek first: a plaintext import must not be blocked for want of a password, and
  // an encrypted one asks for exactly the password that opens it.
  const key = dataKeyForHeader(peekHeader(bytes), password ?? null);
  let payload: BackupPayload;
  try {
    payload = decodeBackup(bytes, key);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(`That file is not a usable backup: ${(error as Error)?.message || error}`, 'read');
  }
  const date = new Date(payload.header.createdAt || Date.now());
  ensureBackupFolders(dir);
  const file = writeAtomically(classDir(dir, 'manual'), bytes, new Date());
  const record: BackupRecord = {
    id: path.basename(file, BACKUP_EXTENSION),
    // Import lands in the manual folder, and the manifest keeps the folder-qualified
    // path so the UI can show where a backup lives and listBackups can find it.
    file: relativeBackupPath(dir, file),
    createdAt: payload.header.createdAt || date.toISOString(),
    trigger: 'manual',
    backupClass: 'manual',
    bytes: safeSize(file),
    checksum: payload.header.checksum,
    fileSha256: sha256(bytes),
    recordCounts: payload.header.recordCounts,
    databaseProvider: payload.header.databaseProvider,
    restaurantId: payload.header.restaurantId,
    verified: true,
    verifiedAt: new Date().toISOString(),
    imported: true,
    note: 'Imported file',
    cloud: null,
  };
  const manifest = loadManifest(dir);
  manifest.records.unshift(record);
  saveManifest(manifest, dir);
  return {
    record,
    header: payload.header,
    warning:
      payload.header.restaurantId && payload.header.restaurantId !== config.restaurantId
        ? `This backup was written by installation ${payload.header.restaurantId}, not this one (${config.restaurantId}).`
        : null,
  };
}

/**
 * Verify without restoring: reads the file back, decrypts, decompresses, checks
 * every hash and re-validates the payload. Used by the "Verify" button in the
 * Recovery tab, so an owner can prove a backup is usable at any time — and the
 * only way a file is ever described as verified in the UI.
 */
export function verifyBackup(recordId: string, password?: string | null): { ok: true; id: string; file: string; createdAt: string; recordCounts: BackupRecordCounts; encrypted: boolean; message: string } {
  const config = loadBackupConfig();
  const dir = effectiveBackupDir(config);
  const entry = listBackups(dir, config).find((record) => record.id === recordId);
  if (!entry) throw new BackupError('No backup with that reference exists in the backup folder.', 'missing', 404);
  if (entry.damaged) throw new BackupError('This file could not be read as a backup, so it cannot be verified.', 'corrupt');
  const payload = openBackupFile(entry, password ?? null);
  const counts = countSnapshot(payload.snapshot);
  const validation = validateSnapshot(payload.snapshot);
  if (!validation.ok) throw new BackupError(`This backup did not pass its own checks: ${validation.problems.join(' ')}`, 'validate');
  return {
    ok: true,
    id: entry.id,
    file: entry.file,
    createdAt: payload.header.createdAt,
    recordCounts: counts,
    encrypted: payload.header.encryption.mode !== 'none',
    message: `This backup is complete and matches its own checksums: ${counts.orders} orders, ${counts.products} products, ${counts.tables} tables.`,
  };
}

export function backupForExport(recordId: string): { file: string; header: BackupHeader; size: number; fileName: string } {
  const config = loadBackupConfig();
  const dir = effectiveBackupDir(config);
  const entry = listBackups(dir, config).find((candidate) => candidate.id === recordId);
  if (!entry || entry.missing) throw new BackupError('That backup file is not available on this computer.', 'missing', 404);
  let header: BackupHeader | null = null;
  try {
    header = peekHeader(fs.readFileSync(entry.fileName));
  } catch {
    header = null;
  }
  if (!header) throw new BackupError('That backup file could not be read.', 'corrupt');
  return { file: entry.fileName, header, size: safeSize(entry.fileName), fileName: entry.file };
}

export interface DeleteResult {
  deleted: boolean;
  reason?: string;
  /** True when only the manifest entry went away (file was already gone). */
  cloudLeftAlone?: boolean;
}

/**
 * Deleting a local copy never touches the owner's cloud history: off-site
 * recovery is the point of the feature.
 */

/**
 * Deleting a local copy never touches the owner's cloud history: off-site
 * recovery is the point of the feature.
 */
export function deleteBackupRecord(recordId: string): DeleteResult {
  const config = loadBackupConfig();
  const dir = effectiveBackupDir(config);
  const manifest = loadManifest(dir);
  const record = manifest.records.find((candidate) => candidate.id === recordId);
  if (!record) return { deleted: false, reason: 'not-found' };
  const remaining = manifest.records.filter((candidate) => candidate.id !== recordId);
  if (record.verified && remaining.filter((candidate) => candidate.verified).length === 0) {
    return { deleted: false, reason: 'last-recovery-point' };
  }
  try {
    fs.rmSync(resolveBackupPath(dir, record.file), { force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') throw new BackupError(`The backup file could not be deleted: ${(error as Error)?.message || error}`, 'permission', 500);
  }
  saveManifest({ version: 1, records: remaining }, dir);
  return { deleted: true, cloudLeftAlone: Boolean(record.cloud) };
}
