/**
 * The cloud copy stage of the backup pipeline:
 *
 *   LOCAL VERIFIED → UPLOAD → REMOTE VERIFY → PROTECTED
 *
 * A backup that is verified locally is already a completed backup; this stage
 * only *adds* protection. So everything here is allowed to fail: failures are
 * recorded on the backup's manifest entry, retried with backoff, and never
 * propagate into the till, printing, orders or the local file.
 *
 * Two rules:
 *  - Only encrypted payloads are uploaded. An unencrypted business database must
 *    not leave this computer, even into the owner's own cloud.
 *  - A cloud copy is marked protected only when the provider confirmed the bytes
 *    (size, plus a content hash where the provider exposes one). "Uploaded" is
 *    never reported as "verified".
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { CloudError, classifyTransportError, PROVIDER_LABELS, type CloudProviderId, type RemoteBackup, type RemoteVerification } from './provider.js';
import { providerFor } from './manager.js';
import {
  effectiveBackupDir,
  loadBackupConfig,
  type BackupConfig,
} from '../backupConfig.js';
import {
  importBackup,
  listBackups,
  patchBackupRecord,
  peekHeaderFromFile,
  resolveBackupPath,
  type BackupCloudState,
  type BackupListEntry,
  type BackupRecord,
} from '../backup/index.js';

const MAX_PER_SYNC = 5;

export interface UploadProgressInfo {
  recordId: string;
  provider: string;
  sentBytes: number;
  totalBytes: number;
  resumed: boolean;
  startedAt: string;
}

const inFlight = new Map<string, UploadProgressInfo>();

/** Live progress for the UI ("Uploading 62% — resumed" instead of a spinner). */
export function currentUploads(): UploadProgressInfo[] {
  return [...inFlight.values()];
}

export type CloudEligibility = 'ready' | 'no-provider' | 'not-encrypted' | 'not-verified';

export function cloudEligibility(record: BackupRecord | BackupListEntry, config: BackupConfig = loadBackupConfig()): CloudEligibility {
  if (!config.cloud) return 'no-provider';
  if (!record.verified) return 'not-verified';
  if (config.encryption.mode !== 'password') return 'not-encrypted';
  return 'ready';
}

export interface SyncSummary {
  attempted: number;
  uploaded: number;
  verified: number;
  pending: number;
  failed: number;
  skipped: number;
  reason: string | null;
  results: { recordId: string; outcome: 'verified' | 'uploaded' | 'pending' | 'failed'; detail: string }[];
}

/**
 * Upload everything the cloud is missing, newest first (recent data matters most
 * for recovery time), and keep going when a provider is down. Called after a local
 * backup, on the retry timer, and by the "Try now" button.
 */
export async function syncNow(options: { force?: boolean; recordIds?: string[] } = {}): Promise<SyncSummary> {
  const config = loadBackupConfig();
  const dir = effectiveBackupDir(config);
  const summary: SyncSummary = { attempted: 0, uploaded: 0, verified: 0, pending: 0, failed: 0, skipped: 0, reason: null, results: [] };
  if (!config.cloud) {
    summary.reason = 'No cloud storage is connected, so backups stay on this computer only.';
    return summary;
  }
  const now = Date.now();
  const entries = listBackups(dir, config).filter((entry) => entry.verified && !entry.damaged && !entry.missing);
  const eligible = entries.filter((entry) => {
    if (options.recordIds?.length) return options.recordIds.includes(entry.id);
    const state = entry.cloud;
    if (!state || state.status === 'uploaded' || state.status === 'verified') return true;
    if (state.status === 'uploading') return false;
    if (!options.force) {
      const next = state.nextAttemptAt ? Date.parse(state.nextAttemptAt) : 0;
      if (next > now) return false;
    }
    return true;
  });

  for (const entry of eligible.slice(0, MAX_PER_SYNC)) {
    summary.attempted += 1;
    try {
      const result = await uploadRecord(entry, config, { quiet: !options.recordIds?.length });
      summary.results.push({ recordId: entry.id, outcome: result.outcome, detail: result.detail });
      if (result.outcome === 'verified') summary.verified += 1;
      else if (result.outcome === 'uploaded') summary.uploaded += 1;
      else if (result.outcome === 'pending') summary.pending += 1;
      else summary.failed += 1;
    } catch (error) {
      const described = describeCloudError(error, config.cloud.provider);
      summary.failed += 1;
      summary.results.push({ recordId: entry.id, outcome: 'failed', detail: described.message });
    }
  }
  if (!summary.attempted) {
    summary.reason = entries.length ? 'Nothing is due for the cloud right now.' : 'No verified backup exists yet, so there is nothing to upload.';
  }
  return summary;
}

export interface UploadResult {
  outcome: 'verified' | 'uploaded' | 'pending' | 'failed';
  detail: string;
  record: BackupRecord | null;
}

/** One backup, one attempt: upload → confirm → record. Never throws for retryable problems. */
export async function uploadRecord(
  entry: BackupListEntry | BackupRecord,
  config: BackupConfig = loadBackupConfig(),
  options: { quiet?: boolean } = {},
): Promise<UploadResult> {
  const dir = effectiveBackupDir(config);
  const eligibility = cloudEligibility(entry, config);
  if (eligibility === 'no-provider') return { outcome: 'pending', detail: 'No cloud storage is connected.', record: null };
  if (eligibility === 'not-verified') return { outcome: 'pending', detail: 'This backup is not verified locally, so it was not uploaded.', record: null };
  const provider = config.cloud!.provider;

  const file = resolveBackupPath(dir, entry.file);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    patchRecord(entry.id, dir, { status: 'failed', error: 'The local backup file could not be read for upload.', nextAttemptAt: null, resume: null });
    return { outcome: 'failed', detail: 'The local backup file is missing.', record: null };
  }
  if (eligibility === 'not-encrypted') {
    const message = 'Cloud copies are only made from encrypted backups. Set a backup password under Automatic backup to protect this data before it leaves the computer.';
    patchRecord(entry.id, dir, { status: 'failed', error: message, nextAttemptAt: null, resume: null });
    return { outcome: 'failed', detail: message, record: null };
  }

  const startedAt = new Date().toISOString();
  inFlight.set(entry.id, { recordId: entry.id, provider, sentBytes: 0, totalBytes: bytes.length, resumed: Boolean(entry.cloud?.resume), startedAt });
  patchRecord(entry.id, dir, { status: 'uploading', lastAttemptAt: startedAt, error: options.quiet ? entry.cloud?.error ?? null : null });

  try {
    const instance = providerFor(provider, config);
    const outcome = await instance.uploadBackup(bytes, entry.file, entry.cloud?.resume ?? null, (progress) => {
      inFlight.set(entry.id, { recordId: entry.id, provider, sentBytes: progress.sentBytes, totalBytes: progress.totalBytes, resumed: progress.resumed, startedAt });
    });

    if (!outcome.remoteId) throw new CloudError(`${PROVIDER_LABELS[provider]} did not confirm the uploaded file.`, 'server', { provider });

    const verification: RemoteVerification = await instance
      .verifyRemoteBackup(outcome.remoteId, { bytes: bytes.length, sha256: entry.fileSha256, buffer: bytes })
      .catch((error) => {
        // Uploaded but unverifiable: the copy exists, so it is reported as uploaded
        // and re-checked next run rather than re-sent.
        const described = describeCloudError(error, provider);
        return { present: true, bytes: null, hash: null, matches: false, limited: true, detail: `uploaded but not confirmed: ${described.message}` } satisfies RemoteVerification;
      });

    const remoteState: Partial<BackupCloudState> = {
      provider,
      status: verification.matches && !verification.limited ? 'verified' : verification.present ? 'uploaded' : 'pending',
      remoteId: outcome.remoteId,
      remotePath: outcome.path,
      remoteBytes: verification.bytes ?? outcome.bytes,
      remoteHash: verification.hash ?? null,
      uploadedAt: new Date().toISOString(),
      verifiedAt: verification.matches ? new Date().toISOString() : null,
      attempts: 0,
      nextAttemptAt: verification.matches ? null : new Date(Date.now() + backoff(1)).toISOString(),
      error: verification.matches ? null : verification.detail || 'The cloud copy could not be confirmed yet.',
      resume: null,
      lastAttemptAt: new Date().toISOString(),
    };
    const record = patchRecord(entry.id, dir, remoteState);
    if (!verification.matches) {
      return { outcome: 'pending', detail: verification.detail || 'The cloud copy is uploaded but not confirmed yet.', record };
    }
    return {
      outcome: verification.limited ? 'uploaded' : 'verified',
      detail: verification.limited
        ? `${PROVIDER_LABELS[provider]} confirmed the size${verification.detail ? ` (${verification.detail})` : ''}. The file is readable in your cloud.`
        : `${PROVIDER_LABELS[provider]} confirmed the copy byte for byte.`,
      record,
    };
  } catch (error) {
    const described = describeCloudError(error, provider);
    const retryable = described.retryable;
    const attempts = Number(entry.cloud?.attempts ?? 0) + 1;
    patchRecord(entry.id, dir, {
      provider,
      status: retryable ? 'pending' : 'failed',
      error: described.message,
      attempts,
      lastAttemptAt: new Date().toISOString(),
      nextAttemptAt: retryable ? new Date(Date.now() + backoff(attempts)).toISOString() : null,
      resume: described.resumeState ?? entry.cloud?.resume ?? null,
    });
    return { outcome: retryable ? 'pending' : 'failed', detail: described.message, record: null };
  } finally {
    inFlight.delete(entry.id);
  }
}

function backoff(attempts: number): number {
  const minutes = Math.min(15 * 2 ** Math.max(0, attempts - 1), 360);
  return minutes * 60_000;
}

function patchRecord(recordId: string, dir: string, patch: Partial<BackupCloudState>): BackupRecord | null {
  return patchBackupRecord(recordId, { cloud: patch as BackupCloudState } as Partial<BackupRecord>, dir);
}

export interface CloudErrorDescription {
  message: string;
  kind: string;
  retryable: boolean;
  /** What the UI should offer, if anything. */
  action: 'reconnect' | 'retry' | 'free-space' | 'encryption' | null;
  resumeState?: Record<string, unknown> | null;
}

/**
 * Turns a provider failure into a sentence an owner can act on. Raw codes and
 * stack traces stop here: the UI never sees them, and neither do the logs beyond a
 * single line for the technician.
 */
export function describeCloudError(error: unknown, provider: CloudProviderId | undefined): CloudErrorDescription {
  if (error instanceof CloudError) {
    const action =
      error.kind === 'auth' || error.kind === 'consent' || error.kind === 'permission'
        ? 'reconnect'
        : error.kind === 'quota'
          ? 'free-space'
          : error.retryable
            ? 'retry'
            : error.kind === 'config'
              ? 'reconnect'
              : null;
    return { message: error.message, kind: error.kind, retryable: error.retryable, action, resumeState: error.resumeState ?? null };
  }
  const cloudError = classifyTransportError(error, provider || 'google-drive');
  return { message: cloudError.message, kind: cloudError.kind, retryable: cloudError.retryable, action: 'retry' };
}

// ── recovering from the cloud ───────────────────────────────────────────────

export interface RemoteBackupView extends RemoteBackup {
  /** This installation has a matching local file, so the cloud copy is a mirror. */
  knownLocally: boolean;
  /** The cloud has it and this computer does not — the disaster-recovery case. */
  onlyInCloud: boolean;
  /** Id of the matching local backup, when there is one. */
  localRecordId: string | null;
}

export async function remoteBackups(): Promise<RemoteBackupView[]> {
  const config = loadBackupConfig();
  if (!config.cloud) return [];
  const dir = effectiveBackupDir(config);
  const local = new Map(listBackups(dir, config).map((entry) => [entry.file.split('/').pop(), entry.id]));
  const instance = providerFor(config.cloud.provider, config);
  const remote = await instance.listBackups();
  return remote
    .filter((file) => file.name.endsWith('.rdbak'))
    .map((file) => {
      const base = file.name.split('/').pop() || file.name;
      const localRecordId = local.get(base) ?? null;
      return { ...file, knownLocally: Boolean(localRecordId), onlyInCloud: !localRecordId, localRecordId };
    })
    .sort((a, b) => (a.modifiedAt && b.modifiedAt ? (a.modifiedAt < b.modifiedAt ? 1 : -1) : 0));
}

/**
 * Download a cloud copy into a private temporary file so it can be verified and
 * (if the owner asks) imported or restored. Nothing is applied here: this only
 * produces a candidate file plus its plaintext header, which the restore flow then
 * treats exactly like a local one — including the "written by another restaurant"
 * refusal and the safety backup.
 */
export async function downloadRemoteToTemp(
  remoteId: string,
  expected: { bytes?: number | null; name?: string | null } = {},
): Promise<{ file: string; header: ReturnType<typeof peekHeaderFromFile>; bytes: number; foreignRestaurant: boolean; remove: () => void }> {
  const config = loadBackupConfig();
  if (!config.cloud) throw new CloudError('No cloud storage is connected.', 'config');
  const instance = providerFor(config.cloud.provider, config);
  const buffer = await instance.downloadBackup(remoteId);
  if (expected.bytes && buffer.length !== expected.bytes) {
    throw new CloudError(`The download from ${PROVIDER_LABELS[config.cloud.provider]} is ${buffer.length} bytes but ${expected.bytes} were expected, so it was not used.`, 'corrupt', { provider: config.cloud.provider });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restaurant-restore-'));
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* some platforms ignore mode on temp dirs */
  }
  const file = path.join(dir, `cloud-${crypto.randomBytes(6).toString('hex')}.rdbak`);
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  const header = peekHeaderFromFile(file);
  if (!header) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new CloudError('That cloud file is not a backup this app can read (it is damaged, or was written by another program).', 'corrupt', { provider: config.cloud.provider });
  }
  return {
    file,
    header,
    bytes: buffer.length,
    foreignRestaurant: Boolean(header.restaurantId) && header.restaurantId !== config.restaurantId,
    remove: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp cleanup is best effort */
      }
    },
  };
}

/**
 * Bring a cloud copy back into this computer's backup folder (new machine, or a
 * machine whose disk was replaced). The file is downloaded, verified by the normal
 * import path — checksums, structure, schema version, foreign-restaurant refusal —
 * and registered; nothing is applied to live data. The owner then chooses Restore.
 */
export async function importRemoteBackup(
  remoteId: string,
  password?: string | null,
): Promise<{ record: BackupRecord; foreignRestaurant: boolean; alreadyLocal: boolean; message: string }> {
  const config = loadBackupConfig();
  const dir = effectiveBackupDir(config);
  const temp = await downloadRemoteToTemp(remoteId);
  try {
    const header = temp.header!;
    const localMatch = listBackups(dir, config).find((entry) => entry.file.split('/').pop() === (header.createdAt || '').replace(/[:.]/g, '-'));
    const bytes = fs.readFileSync(temp.file);
    const result = await importBackup(bytes, password ?? null);
    // The cloud already holds this exact file, so say so instead of queueing a
    // pointless second copy of it.
    patchBackupRecord(
      result.record.id,
      {
        cloud: {
          provider: config.cloud!.provider,
          status: 'verified',
          remoteId,
          remotePath: remoteId,
          remoteBytes: bytes.length,
          remoteHash: result.record.fileSha256,
          uploadedAt: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
          lastAttemptAt: new Date().toISOString(),
          attempts: 0,
          nextAttemptAt: null,
          error: null,
          resume: null,
        } as BackupCloudState,
      } as Partial<BackupRecord>,
      dir,
    );
    return {
      record: { ...result.record, cloud: { ...result.record.cloud!, status: 'verified', remoteId } },
      foreignRestaurant: temp.foreignRestaurant,
      alreadyLocal: Boolean(localMatch),
      message: temp.foreignRestaurant
        ? 'This cloud backup was written by a different installation and is now listed as a foreign backup. Restoring it will replace everything on this computer with that restaurant’s data.'
        : `${remoteId.split('/').pop()} was downloaded from your cloud folder and verified. Choose Restore when you want it applied.`,
    };
  } finally {
    temp.remove();
  }
}

/**
 * Delete a cloud copy on purpose (the owner is cleaning their own storage). The
 * last cloud copy of a restaurant whose local folder no longer holds it is
 * refused: that file is the only thing standing between them and data loss.
 */
export async function deleteRemoteBackup(remoteId: string, options: { confirmLastCopy?: boolean } = {}): Promise<{ deleted: boolean; message: string }> {
  const config = loadBackupConfig();
  if (!config.cloud) throw new CloudError('No cloud storage is connected.', 'config');
  const dir = effectiveBackupDir(config);
  const views = await remoteBackups();
  const target = views.find((file) => file.id === remoteId);
  if (!target) throw new CloudError('That cloud file is no longer in the backup folder.', 'not-found', { provider: config.cloud.provider });
  if (target.onlyInCloud && !options.confirmLastCopy) {
    return {
      deleted: false,
      message: 'This backup exists only in your cloud folder — this computer has no copy. Import it first if you want to keep it, or confirm that you really want to delete your only copy.',
    };
  }
  const instance = providerFor(config.cloud.provider, config);
  await instance.deleteBackup(remoteId);
  // Drop the cloud marker from any local record that pointed at it.
  for (const entry of listBackups(dir, config)) {
    if (entry.cloud?.remoteId === remoteId) {
      patchRecord(entry.id, dir, { status: 'pending', remoteId: null, remotePath: null, remoteBytes: undefined, remoteHash: null, verifiedAt: null, uploadedAt: null, error: 'The cloud copy was deleted from this app.' });
    }
  }
  return { deleted: true, message: `${target.name} was deleted from your ${PROVIDER_LABELS[config.cloud.provider]} folder. The local copy is untouched.` };
}


