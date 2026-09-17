/**
 * Where backups live on this machine, and the index that describes them.
 *
 * Layout (under the OS app-data folder, never the installation directory):
 *   backups/manifest.json
 *   backups/daily/restaurant-2026-09-17-023000.rdbak
 *   backups/weekly/...    backups/monthly/...    backups/manual/...
 *
 * `manifest.json` is a cache, not a source of truth: every field is derivable
 * from the plaintext header of each file, because after the failure this feature
 * exists for you may have the files and nothing else. Paths in the manifest are
 * always re-checked against the backup folder (no traversal out of it).
 */

import fs from 'fs';
import path from 'path';
import { replaceFile } from '../atomicFile.js';
import crypto from 'crypto';
import { effectiveBackupDir, loadBackupConfig, type BackupClass, type BackupConfig } from '../backupConfig.js';
import { BackupError } from './errors.js';
import { parseContainer, peekHeaderFromFile } from './format.js';
import { emptyCounts, MAX_MANIFEST_RECORDS, sha256 } from './integrity.js';
import { BACKUP_EXTENSION, BackupListEntry, BackupRecord, Manifest } from './types.js';

export function manifestPath(dir: string): string {
  return path.join(dir, 'manifest.json');
}

/**
 * The manifest is a cache, not a source of truth: every field can be rebuilt
 * from the plaintext header of each `.rdbak`. That matters for precisely the
 * situation this feature exists for — after a disk failure you may have the
 * backup files and nothing else.
 */

export function safeSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function safeBirthTime(file: string): string {
  try {
    const stat = fs.statSync(file);
    return (stat.birthtime || stat.mtime || new Date()).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

export function stampOf(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}


export function backupDir(config: BackupConfig = loadBackupConfig()): string {
  return effectiveBackupDir(config);
}

/** Folder layout inside the backup directory, mirroring the cloud layout. */
export const BACKUP_CLASS_DIRS = ['daily', 'weekly', 'monthly', 'manual'] as const;

export function classDir(backupRoot: string, backupClass: BackupClass | string): string {
  const sub = BACKUP_CLASS_DIRS.includes(backupClass as BackupClass) ? String(backupClass) : 'manual';
  return path.join(backupRoot, sub);
}

export function backupFileNameFor(date: Date): string {
  return `restaurant-${stampOf(date)}${BACKUP_EXTENSION}`;
}

/**
 * Join a path stored in the manifest onto the backup folder and prove it stays
 * inside the folder. Manifest entries can be hand-edited or arrive with an
 * imported machine, so they are treated as untrusted input: `..`, absolute paths
 * and drive/UNC prefixes are refused instead of resolved.
 */
export function resolveBackupPath(backupRoot: string, relative: string): string {
  const clean = String(relative || '').replace(/\\/g, '/');
  if (!clean || path.isAbsolute(clean) || /^[a-zA-Z]:/.test(clean) || clean.startsWith('/')) {
    throw new BackupError(`Refusing backup path "${relative}": not a path inside the backup folder.`, 'missing', 400);
  }
  const target = path.resolve(backupRoot, ...clean.split('/').filter(Boolean));
  const root = path.resolve(backupRoot);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new BackupError(`Refusing backup path "${relative}": it escapes the backup folder.`, 'missing', 400);
  }
  return target;
}

/** Absolute path → manifest-relative path with forward slashes. */
export function relativeBackupPath(backupRoot: string, absolute: string): string {
  return path.relative(path.resolve(backupRoot), absolute).split(path.sep).join('/');
}

export function uniquePath(dir: string, date: Date): string {
  const stem = `restaurant-${stampOf(date)}`;
  for (let attempt = 1; attempt < 100; attempt++) {
    const candidate = path.join(dir, attempt === 1 ? `${stem}${BACKUP_EXTENSION}` : `${stem}-${attempt}${BACKUP_EXTENSION}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${BACKUP_EXTENSION}`);
}

/** Create the backup root and its four class folders. Safe to call repeatedly. */
export function ensureBackupFolders(backupRoot = backupDir()): void {
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  for (const sub of BACKUP_CLASS_DIRS) {
    fs.mkdirSync(path.join(backupRoot, sub), { recursive: true, mode: 0o700 });
  }
}

/** WRITE TEMP FILE (+fsync) → ATOMIC FINALIZE (rename). Never overwrites. */

/** WRITE TEMP FILE (+fsync) → ATOMIC FINALIZE (rename). Never overwrites. */
export function writeAtomically(dir: string, bytes: Buffer, date: Date): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}.rdbak`);
  const handle = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    // Flush before the rename: after a Windows crash or forced shutdown a
    // renamed-but-buffered file would otherwise come back zero-length.
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  const target = uniquePath(dir, date);
  fs.renameSync(temp, target);
  try {
    const dirHandle = fs.openSync(dir, 'r');
    fs.fsyncSync(dirHandle);
    fs.closeSync(dirHandle);
  } catch {
    /* directory fsync is not supported everywhere */
  }
  return target;
}

/**
 * The manifest is a cache, not a source of truth: every field can be rebuilt
 * from the plaintext header of each `.rdbak`. That matters for precisely the
 * situation this feature exists for — after a disk failure you may have the
 * backup files and nothing else.
 */
export function loadManifest(dir = backupDir()): Manifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')) as Manifest;
    if (parsed && Array.isArray(parsed.records)) return { version: 1, records: parsed.records };
  } catch {
    /* missing or damaged → rebuild from the files themselves */
  }
  return rebuildManifest(dir);
}

export function rebuildManifest(dir = backupDir()): Manifest {
  const records: BackupRecord[] = [];
  const found: { name: string; relative: string; full: string }[] = [];
  const scan = (folder: string, prefix: string) => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(folder).filter((name) => name.endsWith(BACKUP_EXTENSION) && !name.startsWith('.tmp-'));
    } catch {
      return;
    }
    for (const name of names) found.push({ name, relative: prefix ? `${prefix}/${name}` : name, full: path.join(folder, name) });
  };
  // Files that predate the per-class folders are still discovered, and are kept
  // where they are: moving a verified backup would change nothing about safety.
  for (const sub of BACKUP_CLASS_DIRS) scan(path.join(dir, sub), sub);
  scan(dir, '');
  const seen = new Set<string>();
  for (const { name, relative, full } of found) {
    const candidateId = name.slice(0, -BACKUP_EXTENSION.length);
    if (seen.has(candidateId)) continue;
    seen.add(candidateId);
    try {
      const buffer = fs.readFileSync(full);
      const { header } = parseContainer(buffer);
      records.push({
        id: name.slice(0, -BACKUP_EXTENSION.length),
        file: relative,
        createdAt: header.createdAt,
        trigger: header.trigger,
        backupClass: header.backupClass,
        bytes: buffer.length,
        checksum: header.checksum,
        fileSha256: sha256(buffer),
        recordCounts: header.recordCounts,
        databaseProvider: header.databaseProvider,
        restaurantId: header.restaurantId,
        // A backup whose own checksum verifies is a verified backup, even if
        // the manifest that recorded it is gone.
        verified: header.checksum === sha256(buffer.subarray(buffer.length - header.cipherBytes)),
        verifiedAt: new Date().toISOString(),
        note: header.note,
        // Cloud state is deliberately not reconstructed: it is re-established
        // by listBackups() against the provider, never assumed.
        cloud: null,
      });
    } catch (error) {
      console.warn(`[backup] Skipping unreadable backup file ${name}:`, (error as Error)?.message || error);
      records.push({
        id: name.slice(0, -BACKUP_EXTENSION.length),
        file: relative,
        createdAt: safeBirthTime(full),
        trigger: 'manual',
        backupClass: 'manual',
        bytes: safeSize(full),
        checksum: '',
        fileSha256: '',
        recordCounts: emptyCounts(),
        databaseProvider: 'file',
        restaurantId: '',
        verified: false,
        verifiedAt: null,
        note: 'Unreadable or foreign file in the backup folder',
        cloud: null,
      });
    }
  }
  records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { version: 1, records };
}

export function saveManifest(manifest: Manifest, dir = backupDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ version: 1, records: manifest.records.slice(0, MAX_MANIFEST_RECORDS) }, null, 2);
    const tmp = `${manifestPath(dir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    replaceFile(tmp, manifestPath(dir));
  } catch (error) {
    // Losing the cache never means losing a backup.
    console.warn('[backup] Could not write manifest.json (backup files remain intact):', (error as Error)?.message || error);
  }
}

export function patchBackupRecord(recordId: string, patch: Partial<BackupRecord>, dir = backupDir()): BackupRecord | null {
  const manifest = loadManifest(dir);
  const index = manifest.records.findIndex((record) => record.id === recordId);
  if (index === -1) return null;
  manifest.records[index] = { ...manifest.records[index], ...patch };
  saveManifest(manifest, dir);
  return manifest.records[index];
}

export function getBackupRecord(recordId: string, dir = backupDir()): BackupRecord | null {
  return loadManifest(dir).records.find((record) => record.id === recordId) || null;
}

export function listBackups(dir = backupDir(), config: BackupConfig = loadBackupConfig()): BackupListEntry[] {
  const manifest = loadManifest(dir);
  return manifest.records
    .map((record) => {
      let fileName: string | null = null;
      let encrypted = record.checksum !== '';
      let damaged = false;
      try {
        fileName = resolveBackupPath(dir, record.file);
        // Only the plaintext header is read, so listing a folder of a hundred
        // backups costs a few kilobytes instead of every archive.
        const header = peekHeaderFromFile(fileName);
        if (!header) {
          damaged = true;
          encrypted = false;
        } else {
          encrypted = header.encryption.mode !== 'none';
        }
      } catch {
        // A manifest entry pointing outside the folder, or an unreadable file, is
        // reported as damaged rather than allowed to fail the whole listing.
        damaged = true;
        encrypted = false;
      }
      return {
        ...record,
        fileName,
        encrypted,
        missing: !damaged && (fileName === null || !fs.existsSync(fileName)),
        damaged,
        foreignRestaurant: Boolean(record.restaurantId) && record.restaurantId !== config.restaurantId,
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function diskSpaceInfo(dir = backupDir()): { freeBytes: number; totalBytes: number } | null {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const stat = fs.statfsSync(dir);
    return { freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
  } catch {
    return null;
  }
}

/** Where the backups actually live right now, for the UI + health output. */
/** Where the backups actually live right now, for the UI + health output. */
export function backupLocationInfo(config: BackupConfig = loadBackupConfig()) {
  const dir = effectiveBackupDir(config);
  const space = diskSpaceInfo(dir);
  let exists = false;
  let readable = false;
  let writable = false;
  try {
    exists = fs.existsSync(dir);
    readable = exists;
    if (exists) fs.accessSync(dir, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  return { dir, exists, readable, writable, freeBytes: space?.freeBytes ?? null, totalBytes: space?.totalBytes ?? null };
}
