import type { CloudProviderId } from '../backupConfig.js';

export type { CloudProviderId };

/** Name an owner recognises — error text never says "google-drive". */
export function providerLabel(id: CloudProviderId | string | undefined): string {
  if (id === 'google-drive') return 'Google Drive';
  if (id === 'onedrive') return 'OneDrive';
  if (id === 'dropbox') return 'Dropbox';
  return 'the cloud storage';
}

/**
 * The single contract the rest of the application is allowed to know about the
 * cloud. Backup/restore logic, the scheduler, the API and the UI all speak this
 * interface — no file outside `src/server/cloud/` may contain
 * provider-specific fields, URLs or error strings.
 *
 * Transport is injectable (`fetchImpl`) so the flows can be exercised against a
 * fake provider in tests without touching a real cloud account.
 */

export interface CloudTokens {
  accessToken: string;
  refreshToken?: string | null;
  /** epoch ms; refresh is attempted a little before it actually expires */
  expiresAt?: number | null;
  scope?: string | null;
}

export interface CloudAccount {
  id: string | null;
  email: string | null;
  name: string | null;
}

export interface StorageInfo {
  usedBytes: number | null;
  limitBytes: number | null;
  /** Human label for the UI, e.g. "1.2 GB of 15 GB used". */
  accountLabel: string | null;
}

export interface RemoteBackup {
  id: string;
  name: string;
  bytes: number;
  modifiedAt: string | null;
  /** Provider-side content hash, when the provider exposes one. */
  hash: string | null;
  hashKind: 'md5' | 'sha256' | 'quickxor' | 'none';
}

export interface UploadProgress {
  sentBytes: number;
  totalBytes: number;
  /** true when a previously interrupted session was continued rather than restarted */
  resumed: boolean;
}

export interface UploadOutcome {
  remoteId: string;
  path: string;
  bytes: number;
  resumed: boolean;
  /** provider session cursor, kept so an interrupted upload can continue */
  resumeState: Record<string, unknown> | null;
}

export interface RemoteVerification {
  present: boolean;
  bytes: number | null;
  hash: string | null;
  /** size matched (and hash matched when the provider exposes one) */
  matches: boolean;
  /** true when the provider could not confirm content, only existence */
  limited: boolean;
  detail?: string;
}

export interface FolderInfo {
  folderId: string | null;
  folderPath: string;
  created: boolean;
}

export type CloudErrorKind =
  | 'auth'
  | 'consent'
  | 'network'
  | 'offline'
  | 'quota'
  | 'rate'
  | 'not-found'
  | 'corrupt'
  | 'permission'
  | 'unsupported'
  | 'server'
  | 'config';

/**
 * Every failure the cloud can produce is translated into one of these, with a
 * plain-English message an owner can act on, plus `retryable` so the queue
 * knows whether to back off or stop and ask for re-authorization.
 */
export class CloudError extends Error {
  kind: CloudErrorKind;
  retryable: boolean;
  status?: number;
  provider?: CloudProviderId;
  /** When the provider asked us to slow down, how long to wait (seconds). */
  retryAfterSeconds?: number;
  /**
   * Where an interrupted upload should continue from. The provider fills it in on
   * the error so a failed attempt still leaves a resumable session behind, instead
   * of the next attempt starting the file over from byte zero.
   */
  resumeState?: Record<string, unknown> | null;
  constructor(
    message: string,
    kind: CloudErrorKind = 'server',
    options: { retryable?: boolean; status?: number; provider?: CloudProviderId; retryAfterSeconds?: number; resumeState?: Record<string, unknown> | null } = {},
  ) {
    super(message);
    this.name = 'CloudError';
    this.kind = kind;
    this.status = options.status;
    this.provider = options.provider;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.resumeState = options.resumeState;
    this.retryable = options.retryable ?? (kind === 'network' || kind === 'offline' || kind === 'rate' || kind === 'server');
  }
}

export interface CloudRequestContext {
  provider: CloudProviderId;
  restaurantId: string;
  clientId: string;
  clientSecret?: string | null;
  redirectUri?: string | null;
  /** Owner-visible folder label, e.g. "Restaurant Backup / Café XYZ". */
  folderLabel: string;
  /** Provider path segments of the backup folder, root-relative. */
  folderSegments: string[];
  fetchImpl?: typeof fetch;
}

/** OAuth pieces a provider must describe; the flows themselves are shared. */
export interface OAuthSpec {
  authorizeEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  /** extra query params on the authorize URL (access_type, token_access_type…) */
  authorizeParams?: Record<string, string>;
  /** extra body params on the token exchange (grant_type is added by oauth.ts) */
  tokenParams?: Record<string, string>;
  /** 'pkce' for public clients (recommended, no secret needed) */
  authStyle: 'pkce-public' | 'pkce-confidential';
  deviceCodeEndpoint?: string | null;
  /** Refresh needs the client secret even in PKCE mode (Google web clients). */
  refreshRequiresClientSecret?: boolean;
  /** Revokes the refresh token server-side on disconnect (absent for Dropbox). */
  revokeEndpoint?: string | null;
}

export interface AuthorizeRequest {
  url: string;
  state: string;
  /** true when the provider needs the loopback redirect instead of a device code */
  usesRedirect: boolean;
  deviceCode?: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  };
}

export interface CloudStorageProvider {
  readonly id: CloudProviderId;
  readonly label: string;
  /** Where backups land, explained to the owner before they authorize. */
  readonly accessSummary: string;
  readonly oauth: OAuthSpec;

  /** Step 1: hand the UI a URL to open (a real link, never a popup). */
  beginAuthorization(redirectUri: string): Promise<AuthorizeRequest>;
  /** Step 2: turn the provider's ?code= into tokens. */
  completeAuthorization(code: string, state: string): Promise<CloudTokens>;
  /** Step 3: identity + quota, used to prove the grant works. */
  account(): Promise<CloudAccount>;
  storageInfo(): Promise<StorageInfo>;

  ensureBackupFolder(): Promise<FolderInfo>;
  listBackups(): Promise<RemoteBackup[]>;
  /**
   * Upload must be resumable where the provider supports it: on a dropped
   * connection the caller stores `resumeState` and passes it back on retry.
   */
  uploadBackup(bytes: Buffer, name: string, resumeState?: Record<string, unknown> | null, onProgress?: (progress: UploadProgress) => void): Promise<UploadOutcome>;
  downloadBackup(remoteId: string): Promise<Buffer>;
  deleteBackup(remoteId: string): Promise<void>;
  /**
   * Confirm the stored object without a full re-download: size, plus whatever
   * content hash the provider exposes (Drive MD5, Graph quickXor, Dropbox SHA-256).
   * `buffer` is the exact payload that was uploaded, so the provider can compute the
   * hash its own service reports; the byte-for-byte check before a restore is always
   * a fresh download.
   */
  verifyRemoteBackup(remoteId: string, expected: { bytes: number; sha256?: string | null; buffer?: Buffer | null }): Promise<RemoteVerification>;
  /** Small object written during connect to prove write + read + delete. */
  probeWriteAccess(fileName: string, content: string): Promise<{ remoteId: string; verified: boolean }>;
  removeProbe(remoteId: string): Promise<void>;

  /**
   * Forget the stored tokens and revoke them where the provider supports it.
   * Never touches the customer's files: disconnecting is about this app's access,
   * not about their backups.
   */
  disconnect?(): Promise<void>;
  /** Switch between redirect and device-code sign-in (OneDrive only). */
  setDeviceCodeFlow?(enabled: boolean): void;
}

/** Environment variables that hold each provider's OAuth client, per installation. */
export const PROVIDER_CLIENT_ENV: Record<CloudProviderId, { id: string[]; secret: string[] }> = {
  'google-drive': { id: ['GOOGLE_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_ID'], secret: ['GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_SECRET'] },
  onedrive: { id: ['MICROSOFT_CLIENT_ID', 'AZURE_CLIENT_ID'], secret: ['MICROSOFT_CLIENT_SECRET', 'AZURE_CLIENT_SECRET'] },
  dropbox: { id: ['DROPBOX_APP_KEY', 'DROPBOX_CLIENT_ID'], secret: ['DROPBOX_APP_SECRET', 'DROPBOX_CLIENT_SECRET'] },
};

/** Owner-visible names for the provider list in Settings. */
export const PROVIDER_LABELS: Record<CloudProviderId, string> = {
  'google-drive': 'Google Drive',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
};

/**
 * The OAuth client this installation should use for a provider: the id recorded on
 * the connection first (so re-authorizing a device keeps working after the env
 * changes), then the environment. No client id means cloud backup is simply not
 * offered — the app never signs customers into a vendor-owned account of ours.
 */
export function resolveClientCredentials(
  provider: CloudProviderId,
  connectionClientId?: string | null,
): { clientId: string | null; clientSecret: string | null; envVarNames: string[] } {
  const env = PROVIDER_CLIENT_ENV[provider];
  const fromEnv = (names: string[]): string | null => {
    for (const name of names) {
      const value = process.env[name];
      if (value && value.trim()) return value.trim();
    }
    return null;
  };
  return {
    clientId: (connectionClientId && connectionClientId.trim()) || fromEnv(env.id),
    clientSecret: fromEnv(env.secret),
    envVarNames: env.id,
  };
}

/** Providers are looked up by id only; nothing switches on the id elsewhere. */
export type ProviderFactory = (context: CloudRequestContext, tokens?: () => Promise<CloudTokens>) => CloudStorageProvider;

const registry = new Map<CloudProviderId, ProviderFactory>();

export function registerProvider(id: CloudProviderId, factory: ProviderFactory) {
  registry.set(id, factory);
}

export function createProvider(id: CloudProviderId, context: CloudRequestContext, tokens?: () => Promise<CloudTokens>): CloudStorageProvider {
  const factory = registry.get(id);
  if (!factory) throw new CloudError(`Unknown cloud provider "${id}".`, 'config');
  return factory(context, tokens);
}

export function providerDescriptor(id: CloudProviderId) {
  switch (id) {
    case 'google-drive':
      return { label: 'Google Drive', accessSummary: 'Only the "Restaurant Backup" folder Drive grants this app create/read access to (drive.file).' };
    case 'onedrive':
      return { label: 'Microsoft OneDrive', accessSummary: 'Only the app folder Apps/NEXORAOSP Restaurant (Files.ReadWrite.AppFolder) — never your other OneDrive files.' };
    case 'dropbox':
      return { label: 'Dropbox', accessSummary: 'Only the app folder /Apps/<your app> (Dropbox app-folder access) — never your whole Dropbox.' };
  }
  throw new CloudError(`Unknown cloud provider "${id}".`, 'config');
}

export const SUPPORTED_PROVIDERS: CloudProviderId[] = ['google-drive', 'onedrive', 'dropbox'];

export function isProviderId(value: unknown): value is CloudProviderId {
  return value === 'google-drive' || value === 'onedrive' || value === 'dropbox';
}

/** Shared timeout for provider HTTP calls: a hung cloud must not hang the POS. */
export const CLOUD_TIMEOUT_MS = 30_000;
export const CLOUD_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Maps a transport/HTTP failure onto CloudError. Providers call this instead
 * of inventing their own wording, so "no internet" and "quota exceeded" stay
 * distinguishable everywhere in the product.
 */
export function classifyHttpError(
  status: number,
  body: string,
  provider: CloudProviderId,
  options: { url?: string; retryAfterSeconds?: number } = {},
): CloudError {
  const url = options.url;
  const label = providerLabel(provider);
  const text = (body || '').slice(0, 600);
  // "Out of space" outranks the status code: every provider reports a full account
  // differently (403, 409, 413, 507), and only the words say what to do about it.
  const outOfSpace =
    status === 413 ||
    status === 507 ||
    /quota|space limit|insufficient[ _-]?storage|insufficient[ _-]?space|disk quota|not_enough_space/i.test(text);
  if (outOfSpace) {
    return new CloudError(
      `${label} is out of space, so the cloud copy could not be stored. Your local backup is safe — free space in your cloud account or choose another provider.`,
      'quota',
      { status, provider, retryable: false },
    );
  }
  if (status === 401 || status === 403) {
    if (/insufficient|scope/i.test(text)) {
      return new CloudError(`${label} refused the request: the authorization is missing a permission. Reconnect the cloud account to grant it again.`, 'consent', { status, provider });
    }
    return new CloudError(`${label} no longer accepts this app's credentials (signed out, revoked, or expired). Reconnect your cloud account.`, 'auth', { status, provider });
  }
  if (status === 404) return new CloudError('That file is no longer in the cloud backup folder.', 'not-found', { status, provider });
  if (status === 409 || status === 412 || status === 428) {
    return new CloudError(`${label} reported a conflicting change in the backup folder. The next attempt will reconcile it.`, 'server', { status, provider });
  }
  if (status === 429) return new CloudError(`${label} asked for a slower pace (too many requests). Backup will retry automatically.`, 'rate', { status, provider, retryAfterSeconds: options.retryAfterSeconds });
  if (status >= 500) return new CloudError(`${label}'s service had a problem (HTTP ${status}). Your local backup is safe; retry will happen automatically.`, 'server', { status, provider });
  return new CloudError(`${label} request failed (HTTP ${status})${url ? ' for ' + url : ''}.`, 'server', { status, provider, retryAfterSeconds: options.retryAfterSeconds });
}

export function classifyTransportError(error: unknown, provider: CloudProviderId, timeoutMs?: number): CloudError {
  const label = providerLabel(provider);
  const message = String((error as Error)?.message || error || '');
  const code = String((error as NodeJS.ErrnoException)?.code || '');
  const aborted = (error as Error)?.name === 'AbortError';
  if (aborted && timeoutMs) {
    return new CloudError(`${label} took longer than ${Math.round(timeoutMs / 1000)} seconds to answer, so this attempt was stopped. The cloud copy stays queued.`, 'network', { provider });
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE|network|fetch failed/i.test(`${message} ${code}`)) {
    return new CloudError(`No internet connection to ${label}. The local backup is saved and the cloud copy is queued for when the connection returns.`, 'offline', { provider });
  }
  if ((error as Error)?.name === 'TimeoutError' || /timeout|timed out/i.test(message)) {
    return new CloudError(`${label} took too long to answer. The cloud copy is queued for retry.`, 'network', { provider });
  }
  if (aborted) {
    return new CloudError(`${label} request was cancelled (the app is shutting down, or the owner changed the cloud settings).`, 'network', { provider });
  }
  return new CloudError(`${label} request failed: ${message}`, 'network', { provider });
}
