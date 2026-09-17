/**
 * Retention: how many daily/weekly/monthly backups survive, and what may never
 * be pruned. Deleting a backup is the only destructive thing this subsystem does
 * voluntarily, so the guards are the point of the module.
 */

import { BackupRecord } from './types.js';
import { type BackupClass, type BackupConfig, type BackupTrigger, effectiveBackupDir, loadBackupConfig } from '../backupConfig.js';


export interface RetentionResult {
  kept: BackupRecord[];
  removed: string[];
  keptForSafety: string[];
}

export function isProtectedKind(record: BackupRecord): boolean {
  return Boolean(record.safetyFor) || Boolean(record.imported) || record.trigger === 'pre-restore' || record.trigger === 'manual' || record.trigger === 'initial';
}

/**
 * Daily / weekly / monthly counts come from the config; manual and safety
 * copies live until the owner deletes them. The newest verified backup and the
 * last verified recovery point can never be pruned, so a broken upload window
 * can never leave a restaurant with nothing to restore.
 */

/**
 * Daily / weekly / monthly counts come from the config; manual and safety
 * copies live until the owner deletes them. The newest verified backup and the
 * last verified recovery point can never be pruned, so a broken upload window
 * can never leave a restaurant with nothing to restore.
 */
export function applyRetention(records: BackupRecord[], retention: BackupConfig['retention']): RetentionResult {
  const sorted = [...records].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const keep = new Set<string>();
  const keptForSafety: string[] = [];

  for (const record of sorted) {
    if (isProtectedKind(record)) {
      keep.add(record.id);
      if (record.safetyFor || record.trigger === 'pre-restore') keptForSafety.push(record.id);
    }
  }

  const limits: Record<BackupClass, number> = {
    daily: Math.max(1, retention?.daily ?? 14),
    weekly: Math.max(1, retention?.weekly ?? 12),
    monthly: Math.max(1, retention?.monthly ?? 12),
    manual: Number.POSITIVE_INFINITY,
  };
  const counts: Record<BackupClass, number> = { daily: 0, weekly: 0, monthly: 0, manual: 0 };
  for (const record of sorted) {
    if (keep.has(record.id)) continue;
    const bucket = (record.backupClass || 'daily') as BackupClass;
    if (counts[bucket] < limits[bucket]) {
      counts[bucket] += 1;
      keep.add(record.id);
    }
  }

  const verified = sorted.filter((record) => record.verified);
  if (verified[0] && !keep.has(verified[0].id)) {
    keep.add(verified[0].id);
    keptForSafety.push(verified[0].id);
  }
  if (verified.length <= 1) {
    for (const record of verified) {
      if (!keep.has(record.id)) {
        keep.add(record.id);
        keptForSafety.push(record.id);
      }
    }
  }

  return {
    kept: sorted.filter((record) => keep.has(record.id)),
    removed: sorted.filter((record) => !keep.has(record.id)).map((record) => record.file),
    keptForSafety,
  };
}

