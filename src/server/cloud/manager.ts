/**
 * Cloud connection management: which customer-owned account this installation
 * writes to, whether that account is still reachable, and what the owner needs to
 * do about it.
 *
 * Two rules hold this module together:
 *  1. The cloud is a *destination*. It is never the source of truth, never
 *     consulted while taking an order, and losing it changes nothing except the
 *     "protected" badge.
 *  2. "Connected" is earned, not assumed — a connection is only reported after
 *     the app has written, read back and deleted a test file in the real folder.
 *
 * Tokens are never handled here: each provider reads them from the OS credential
 * store through `oauth.ts`, so this file cannot accidentally return one to the UI.
 */
import {
  classifyTransportError,
  CloudError,
  createProvider,
  providerDescriptor,
  PROVIDER_LABELS,
  registerProvider,
  resolveClientCredentials,
  type AuthorizeRequest,
  type CloudProviderId,
  type CloudRequestContext,
  type CloudStorageProvider,
  type StorageInfo,
} from './provider.js';
import { GoogleDriveProvider } from './google-drive.provider.js';
import { OneDriveProvider } from './onedrive.provider.js';
import { DropboxProvider } from './dropbox.provider.js';
import { forgetTokens } from './oauth.js';
import { effectiveBackupDir, loadBackupConfig, updateBackupConfig, type BackupConfig, type CloudConnectionInfo } from '../backupConfig.js';
import { listBackups, patchBackupRecord } from '../backup/index.js';

// Registered once, at import: everything else in the app looks providers up by id
// and never imports a concrete provider class.
registerProvider('google-drive', (context) => new GoogleDriveProvider(context));
registerProvider('onedrive', (context) => new OneDriveProvider(context));
registerProvider('dropbox', (context) => new DropboxProvider(context));

export const CLOUD_PROVIDERS: CloudProviderId[] = ['google-drive', 'onedrive', 'dropbox'];

export interface ProviderAvailability {
  id: CloudProviderId;
  label: string;
  accessSummary: string;
  /** True when this installation has its own OAuth client configured. */
  clientConfigured: boolean;
  envVarNames: string[];
  connected: boolean;
  isCurrent: boolean;
  supportsDeviceCode: boolean;
}

export type CloudState = 'protected' | 'uploading' | 'pending' | 'failed' | 'attention' | 'disconnected';

export interface CloudStatus {
  state: CloudState;
  headline: string;
  /** Single action the owner can take, or null when nothing is needed. */
  action: { kind: 'reconnect' | 'connect' | 'retry' | 'encryption'; label: string; provider?: CloudProviderId } | null;
  provider: CloudProviderId | null;
  label: string | null;
  accountLabel: string | null;
  folderLabel: string | null;
  folderPath: string | null;
  connectedAt: string | null;
  clientConfigured: boolean;
  quota: StorageInfo | null;
  pendingCount: number;
  failedCount: number;
  uploadedCount: number;
  lastUploadedAt: string | null;
  nextAttemptAt: string | null;
  /** Set when the quota lookup failed, so the UI can say why it is blank. */
  quotaError?: string | null;
  /** Files the customer kept in an earlier provider's folder (still theirs). */
  retired: { provider: CloudProviderId; label: string; folderLabel: string | null; supersededAt: string | null }[];
}

/** The folder backups land in, inside the customer's account. */
export function cloudFolderSegments(config: BackupConfig = loadBackupConfig()): string[] {
  return ['Restaurant Backup', `Restaurant-${config.restaurantId}`];
}

export function providerFor(provider: CloudProviderId, config: BackupConfig = loadBackupConfig()): CloudStorageProvider {
  if (!CLOUD_PROVIDERS.includes(provider)) {
    // Refused before any lookup or network call: an id this app does not implement
    // must not be able to reach a URL derived from it.
    throw new CloudError(`Unknown cloud provider "${provider}".`, 'config', { provider: undefined });
  }
  const connection = config.cloud && config.cloud.provider === provider ? config.cloud : null;
  const credentials = resolveClientCredentials(provider, connection?.clientId);
  if (!credentials.clientId) {
    throw new CloudError(
      `Cloud backup for ${PROVIDER_LABELS[provider]} needs its own sign-in client id. Set ${credentials.envVarNames[0]} to the client you registered for this installation (see docs/BACKUP.md), then try again.`,
      'config',
      { provider },
    );
  }
  const context: CloudRequestContext = {
    provider,
    restaurantId: config.restaurantId,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    folderLabel: connection?.folderLabel || `Restaurant-${config.restaurantId}`,
    folderSegments: cloudFolderSegments(config),
  };
  return createProvider(provider, context);
}

/** Instance built for connect/disconnect flows, where the account is not yet in config. */
export function providerForConnect(provider: CloudProviderId, options: { clientId?: string | null; deviceCode?: boolean } = {}): CloudStorageProvider & { disconnect?(): Promise<void> } {
  if (!CLOUD_PROVIDERS.includes(provider)) throw new CloudError(`Unknown cloud provider "${provider}".`, 'config');
  const config = loadBackupConfig();
  const connection = config.cloud && config.cloud.provider === provider ? config.cloud : null;
  const credentials = resolveClientCredentials(provider, options.clientId ?? connection?.clientId);
  if (!credentials.clientId) {
    throw new CloudError(
      `${PROVIDER_LABELS[provider]} needs an OAuth client id for this installation. Set ${credentials.envVarNames[0]} (see .env.example), then try again.`,
      'config',
      { provider },
    );
  }
  const instance = createProvider(provider, {
    provider,
    restaurantId: config.restaurantId,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    folderLabel: `Restaurant-${config.restaurantId}`,
    folderSegments: cloudFolderSegments(config),
  });
  instance.setDeviceCodeFlow?.(Boolean(options.deviceCode));
  return instance as CloudStorageProvider & { disconnect?(): Promise<void> };
}

/** OAuth client id recorded on the connection, so refreshes survive env changes. */
export function connectedProvider(): CloudProviderId | null {
  return loadBackupConfig().cloud?.provider ?? null;
}

export function providerAvailability(): ProviderAvailability[] {
  const config = loadBackupConfig();
  return CLOUD_PROVIDERS.map((id) => {
    const descriptor = providerDescriptor(id);
    const credentials = resolveClientCredentials(id, config.cloud?.provider === id ? config.cloud.clientId : null);
    return {
      id,
      label: PROVIDER_LABELS[id],
      accessSummary: descriptor?.accessSummary || 'This app will only manage the files it creates in your chosen backup folder.',
      clientConfigured: Boolean(credentials.clientId),
      envVarNames: credentials.envVarNames,
      connected: config.cloud?.provider === id,
      isCurrent: config.cloud?.provider === id,
      supportsDeviceCode: id === 'onedrive',
    };
  });
}

// Quota needs a network call, and the Backup Center should not pay for it every
// poll: the last answer is reused for a few minutes and refreshed on demand.
let quotaCache: { at: number; provider: CloudProviderId; quota: StorageInfo | null; error: string | null } | null = null;
const QUOTA_TTL_MS = 5 * 60_000;

export async function statusWithQuota(options: { refresh?: boolean } = {}): Promise<CloudStatus> {
  const base = status();
  if (!base.provider) return base;
  const fresh = quotaCache && quotaCache.provider === base.provider && Date.now() - quotaCache.at < QUOTA_TTL_MS;
  if (!fresh || options.refresh) {
    try {
      const quota = await providerFor(base.provider).storageInfo();
      quotaCache = { at: Date.now(), provider: base.provider, quota, error: null };
    } catch (error) {
      quotaCache = {
        at: Date.now(),
        provider: base.provider,
        quota: null,
        error: error instanceof CloudError ? error.message : 'The cloud account could not be reached.',
      };
    }
  }
  const cached = quotaCache && quotaCache.provider === base.provider ? quotaCache : null;
  return {
    ...base,
    quota: cached?.quota ?? null,
    accountLabel: base.accountLabel ?? cached?.quota?.accountLabel ?? null,
    quotaError: cached?.error ?? null,
  };
}

// ── connecting ───────────────────────────────────────────────────────────────

export interface BeginConnectResult extends AuthorizeRequest {
  provider: CloudProviderId;
  label: string;
  /** Set when the provider wants the owner to type a code instead of a redirect. */
  instructions?: string | null;
}

export async function beginConnect(
  provider: CloudProviderId,
  redirectUri: string,
  options: { deviceCode?: boolean; clientId?: string | null } = {},
): Promise<BeginConnectResult> {
  const instance = providerForConnect(provider, { clientId: options.clientId, deviceCode: options.deviceCode });
  const request = await instance.beginAuthorization(redirectUri);
  return {
    ...request,
    provider,
    label: PROVIDER_LABELS[provider],
    instructions: request.usesRedirect
      ? 'A browser window will open. After you approve, this window finishes on its own.'
      : `Open ${request.url} on any device and enter the code ${request.deviceCode?.userCode || ''}. This window finishes on its own.`,
  };
}

/**
 * Finish the handshake, then prove the folder works, and only then record the
 * connection. `folderPath`/`folderId` come from the provider, so what the UI shows
 * is where files actually went.
 */
export async function completeConnect(provider: CloudProviderId, code: string, state: string): Promise<CloudConnectionInfo & { verified: boolean; probe: string }> {
  const config = loadBackupConfig();
  const instance = providerForConnect(provider);
  await instance.completeAuthorization(code, state);

  const account = await instance.account();
  const folder = await instance.ensureBackupFolder();
  const probeName = `restaurant-backup-probe-${Date.now()}.txt`;
  const probe = await instance.probeWriteAccess(probeName, `write test for ${config.restaurantId}`);
  if (!probe.verified) {
    await instance.removeProbe(probe.remoteId).catch(() => undefined);
    throw new CloudError(`${PROVIDER_LABELS[provider]} stored the test file but could not read it back, so it is not usable for backups yet.`, 'permission', { provider });
  }
  await instance.removeProbe(probe.remoteId).catch(() => undefined);

  const connection: CloudConnectionInfo = {
    provider,
    connectedAt: new Date().toISOString(),
    folderLabel: `Restaurant Backup / Restaurant-${config.restaurantId}`,
    folderPath: folder.folderPath,
    folderId: folder.folderId,
    accountLabel: account.email || account.name || null,
    clientId: resolveClientCredentials(provider).clientId,
    supersededAt: null,
  };

  // Switching providers retires the old connection — it never deletes anything in
  // it, and its history stays visible in the Recovery tab.
  updateBackupConfig((current) => ({
    ...current,
    retiredCloud:
      current.cloud && current.cloud.provider !== provider
        ? [...current.retiredCloud.filter((entry) => entry.provider !== current.cloud!.provider), { ...current.cloud, supersededAt: new Date().toISOString() }].slice(-8)
        : current.retiredCloud,
    cloud: connection,
  }));
  return { ...connection, verified: true, probe: 'wrote, read back and deleted a test file in the folder' };
}

export interface DisconnectResult {
  forgotAccess: boolean;
  cloudFilesKept: true;
  remoteBackups: number;
  message: string;
}

/**
 * Disconnecting removes *this app's access*. The customer's files are left alone,
 * because the whole reason they pay for cloud storage is to keep their own copies.
 */
export async function disconnect(): Promise<DisconnectResult> {
  const config = loadBackupConfig();
  const provider = config.cloud?.provider;
  if (!provider) {
    return { forgotAccess: false, cloudFilesKept: true, remoteBackups: 0, message: 'No cloud storage is connected.' };
  }
  let remoteBackups = 0;
  try {
    remoteBackups = (await providerFor(provider, config).listBackups()).length;
    // Deliberately no "also delete my cloud files" option: disconnecting is about
    // access, and the customer's copies stay theirs until they delete them
    // themselves — one misclick must not destroy the only off-site backup.
  } catch {
    /* unreachable account: the token is still forgotten below */
  }
  try {
    await providerForConnect(provider).disconnect?.();
  } catch {
    /* revocation is best effort; the stored token is cleared regardless */
  }
  forgetTokens(config.restaurantId, provider);
  updateBackupConfig((current) => ({
    ...current,
    retiredCloud: current.cloud ? [...current.retiredCloud, { ...current.cloud, supersededAt: new Date().toISOString() }].slice(-8) : current.retiredCloud,
    cloud: null,
  }));
  return {
    forgotAccess: true,
    cloudFilesKept: true,
    remoteBackups,
    message: `${PROVIDER_LABELS[provider]} was disconnected. ${remoteBackups} backup ${remoteBackups === 1 ? 'file remains' : 'files remain'} in your ${PROVIDER_LABELS[provider]} folder — they are yours to keep or delete. Automatic backups continue locally.`,
  };
}

/** Manual "check connection" from the UI: proves the token, folder and quota. */
export async function testConnection(): Promise<{ ok: boolean; detail: string; latencyMs: number; accountLabel: string | null; quota: StorageInfo | null }> {
  const started = Date.now();
  const config = loadBackupConfig();
  const provider = config.cloud?.provider;
  if (!provider) return { ok: false, detail: 'No cloud storage is connected yet.', latencyMs: 0, accountLabel: null, quota: null };
  try {
    const instance = providerFor(provider, config);
    const account = await instance.account();
    const quota = await instance.storageInfo().catch(() => null);
    const folder = await instance.ensureBackupFolder();
    void folder;
    return {
      ok: true,
      detail: `${PROVIDER_LABELS[provider]} is reachable and the backup folder is available.`,
      latencyMs: Date.now() - started,
      accountLabel: account.email || account.name || config.cloud?.accountLabel || null,
      quota,
    };
  } catch (error) {
    const cloudError = error instanceof CloudError ? error : classifyTransportError(error, provider);
    return {
      ok: false,
      detail: cloudError.message,
      latencyMs: Date.now() - started,
      accountLabel: config.cloud?.accountLabel || null,
      quota: null,
    };
  }
}

// ── status ───────────────────────────────────────────────────────────────────

/**
 * What the Backup Center, the banner and the health endpoint all show. Derived
 * from real state only: the newest verified local backup, its cloud record, and
 * the schedule — never a stored "last success" flag that could drift.
 */
export function status(): CloudStatus {
  const config = loadBackupConfig();
  const connection = config.cloud;
  const entries = listBackups(effectiveBackupDir(config), config);
  const verified = entries.filter((entry) => entry.verified && !entry.damaged && !entry.missing);
  const pending = verified.filter((entry) => entry.cloud && (entry.cloud.status === 'pending' || entry.cloud.status === 'failed'));
  const uploading = verified.filter((entry) => entry.cloud?.status === 'uploading');
  const uploaded = verified.filter((entry) => entry.cloud && (entry.cloud.status === 'uploaded' || entry.cloud.status === 'verified'));
  const newest = verified[0] || null;
  const nextAttempt = pending.map((entry) => entry.cloud?.nextAttemptAt || '').filter(Boolean).sort()[0] || null;
  const lastUploadedAt = uploaded.map((entry) => entry.cloud?.uploadedAt || '').filter(Boolean).sort().reverse()[0] || null;

  const base = {
    provider: connection?.provider ?? null,
    label: connection ? PROVIDER_LABELS[connection.provider] : null,
    accountLabel: connection?.accountLabel ?? null,
    folderLabel: connection?.folderLabel ?? null,
    folderPath: connection?.folderPath ?? null,
    connectedAt: connection?.connectedAt ?? null,
    clientConfigured: connection ? resolveClientCredentials(connection.provider, connection.clientId).clientId !== null : false,
    quota: null as StorageInfo | null,
    pendingCount: pending.length,
    failedCount: pending.filter((entry) => entry.cloud?.status === 'failed').length,
    uploadedCount: uploaded.length,
    lastUploadedAt,
    nextAttemptAt: nextAttempt,
    retired: config.retiredCloud.map((entry) => ({
      provider: entry.provider,
      label: PROVIDER_LABELS[entry.provider],
      folderLabel: entry.folderLabel,
      supersededAt: entry.supersededAt ?? null,
    })),
  };

  if (!connection) {
    return { ...base, state: 'disconnected', headline: 'Backups are saved on this computer only. Connect your own Google Drive, OneDrive or Dropbox to keep a second copy off-site.', action: { kind: 'connect', label: 'Connect cloud storage' } };
  }
  if (!base.clientConfigured) {
    return { ...base, state: 'attention', headline: `${base.label} is connected, but this installation lost its sign-in configuration.`, action: { kind: 'reconnect', label: `Reconnect ${base.label}`, provider: connection.provider } };
  }
  if (uploading.length) {
    return { ...base, state: 'uploading', headline: `${uploading.length} backup ${uploading.length === 1 ? 'copy is' : 'copies are'} uploading to ${base.label}.`, action: null };
  }
  const needsPassword = verified.some((entry) => !entry.cloud);
  // Only encrypted payloads may leave this computer, so an owner who connected a
  // cloud but has not set a password is told exactly that instead of seeing a
  // silent queue of refusals.
  if (needsPassword && config.encryption.mode !== 'password') {
    return {
      ...base,
      state: 'attention',
      headline: `Cloud copies are only made from encrypted backups, so nothing unencrypted can leave this computer. Set a backup password to start protecting ${base.label}.`,
      action: { kind: 'encryption', label: 'Set a backup password' },
    };
  }
  if (uploading.length) {
    return { ...base, state: 'uploading', headline: `Uploading to ${base.label}.`, action: null };
  }
  if (pending.length) {
    const lastError = pending[0].cloud?.error || '';
    const blocked = /expired|reconnect|permission|revoked|sign in/i.test(lastError);
    if (blocked) {
      return { ...base, state: 'attention', headline: `${base.label} access expired. Reconnect ${base.label} to resume automatic backups.`, action: { kind: 'reconnect', label: `Reconnect ${base.label}`, provider: connection.provider } };
    }
    return {
      ...base,
      state: 'pending',
      headline: `${pending.length} backup ${pending.length === 1 ? 'copy is' : 'copies are'} waiting for ${base.label} to come back.${nextAttempt ? ` Next attempt around ${new Date(nextAttempt).toLocaleString()}.` : ''}`,
      action: { kind: 'retry', label: 'Try now' },
    };
  }
  if (newest && newest.cloud && (newest.cloud.status === 'verified' || newest.cloud.status === 'uploaded')) {
    return { ...base, state: 'protected', headline: `Protected: the latest backup is on this computer and in ${base.label}.`, action: null };
  }
  if (!verified.length) {
    return { ...base, state: 'attention', headline: 'No verified backup exists yet, so nothing is protected. Create the first backup now.', action: { kind: 'retry', label: 'Create backup' } };
  }
  return { ...base, state: 'pending', headline: `${base.label} is connected and waiting for the next backup.`, action: { kind: 'retry', label: 'Try now' } };
}

/** Clear a stale "uploading" marker left behind by a crash mid-upload. */
export function recoverInterruptedUploads(): number {
  const config = loadBackupConfig();
  const dir = effectiveBackupDir(config);
  const stuck = listBackups(dir, config).filter((entry) => entry.cloud?.status === 'uploading');
  for (const entry of stuck) {
    // A restart means the socket is gone; the stored session lets the next attempt
    // continue the same upload instead of starting the file over.
    patchBackupRecord(
      entry.id,
      { cloud: { ...(entry.cloud as object), status: 'pending', error: 'An upload was interrupted by a restart; it will resume automatically.' } } as never,
      dir,
    );
  }
  return stuck.length;
}
