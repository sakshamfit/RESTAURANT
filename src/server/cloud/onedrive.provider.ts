/**
 * OneDrive destination (Microsoft Graph).
 *
 * The app writes inside its own **app folder** (`/Restaurant Backup/...` under
 * `OneDrive/Apps/<this app>`), which is what the `Files.ReadWrite.AppFolder`
 * scope allows: the app cannot see the rest of the customer's OneDrive, and the
 * customer cannot accidentally point a backup at a folder it cannot read back.
 * Both are deliberate: a backup the app cannot list is a backup it cannot restore.
 *
 * Personal accounts and most business tenants work with a public client id plus
 * PKCE (no secret shipped in the app). Device-code sign-in is supported for
 * till machines with no usable redirect.
 */
import {
  CloudError,
  CLOUD_UPLOAD_TIMEOUT_MS,
  type AuthorizeRequest,
  type CloudAccount,
  type CloudRequestContext,
  type CloudStorageProvider,
  type CloudTokens,
  type FolderInfo,
  type OAuthSpec,
  type RemoteBackup,
  type RemoteVerification,
  type StorageInfo,
  type UploadOutcome,
  type UploadProgress,
} from './provider.js';
import { beginAuthForProvider, beginDeviceAuthForProvider, disconnectProvider, finishAuthForProvider, pollDeviceAuthForProvider, tokenLoaderFor } from './oauth.js';
import { CloudHttp } from './http.js';
import type { BackupClass } from '../backupConfig.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const APP_ROOT = `${GRAPH}/me/drive/special/approot`;
const CLASSES: BackupClass[] = ['daily', 'weekly', 'monthly', 'manual'];
/** Above this, OneDrive's quickXor checksum is not recomputed locally (see verify). */
const QUICKXOR_MAX_BYTES = 256 * 1024 * 1024;

export const oneDriveOAuth: OAuthSpec = {
  authorizeEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  deviceCodeEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
  // AppFolder scope + the two read-only fields the connected card shows.
  scopes: ['Files.ReadWrite.AppFolder', 'offline_access', 'User.Read'],
  authorizeParams: {},
  tokenParams: {},
  authStyle: 'pkce-public',
  refreshRequiresClientSecret: false,
  // Microsoft has no revocation endpoint; `offline_access` refresh tokens expire
  // on their own, and disconnecting wipes the local copy (see disconnect()).
  revokeEndpoint: null,
};

interface GraphItem {
  id?: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  parentReference?: { path?: string };
  file?: { hashes?: { quickXorHash?: string; sha1Hash?: string } };
  deleted?: unknown;
  folder?: unknown;
}

interface GraphPage {
  value?: GraphItem[];
  '@odata.nextLink'?: string;
}

export class OneDriveProvider implements CloudStorageProvider {
  readonly id = 'onedrive' as const;
  readonly label = 'OneDrive';
  readonly accessSummary =
    'This app can create, read and delete only the backup files inside its own OneDrive app folder (Restaurant Backup). It cannot open the rest of your OneDrive.';
  readonly oauth = oneDriveOAuth;

  private readonly http: CloudHttp;
  private readonly folderIds = new Map<string, string>();
  private useDeviceCode = false;

  constructor(private readonly context: CloudRequestContext) {
    this.http = new CloudHttp({
      provider: this.id,
      fetchImpl: context.fetchImpl,
      timeoutMs: CLOUD_UPLOAD_TIMEOUT_MS,
      getAccessToken: tokenLoaderFor({
        spec: oneDriveOAuth,
        provider: this.id,
        restaurantId: context.restaurantId,
        clientId: context.clientId,
        clientSecret: context.clientSecret,
        fetchImpl: context.fetchImpl,
      }),
    });
  }

  /** Set by the manager when the tenant/admin prefers device-code sign-in. */
  setDeviceCodeFlow(enabled: boolean): void {
    this.useDeviceCode = enabled;
  }

  // ── connecting ─────────────────────────────────────────────────────────────

  async beginAuthorization(redirectUri: string): Promise<AuthorizeRequest> {
    if (this.useDeviceCode || !redirectUri) {
      const started = await beginDeviceAuthForProvider({
        spec: oneDriveOAuth,
        provider: this.id,
        restaurantId: this.context.restaurantId,
        clientId: this.context.clientId,
        fetchImpl: this.context.fetchImpl,
      });
      return started.request;
    }
    const begun = beginAuthForProvider({
      spec: oneDriveOAuth,
      provider: this.id,
      restaurantId: this.context.restaurantId,
      clientId: this.context.clientId,
      redirectUri,
    });
    return { url: begun.url, state: begun.state, usesRedirect: true };
  }

  async completeAuthorization(code: string, state: string): Promise<CloudTokens> {
    if (code.startsWith('device:')) {
      const [, deviceCode] = code.split(':');
      const tokens = await pollDeviceAuthForProvider({
        spec: oneDriveOAuth,
        provider: this.id,
        restaurantId: this.context.restaurantId,
        clientId: this.context.clientId,
        state,
        deviceCode,
        fetchImpl: this.context.fetchImpl,
      });
      if (!tokens) {
        throw new CloudError('Still waiting for you to finish signing in to OneDrive. Enter the code shown, then this window updates by itself.', 'auth', { retryable: true, provider: this.id });
      }
      return tokens;
    }
    return finishAuthForProvider({
      spec: oneDriveOAuth,
      provider: this.id,
      restaurantId: this.context.restaurantId,
      clientId: this.context.clientId,
      code,
      state,
      fetchImpl: this.context.fetchImpl,
    });
  }

  async disconnect(): Promise<void> {
    await disconnectProvider({
      spec: oneDriveOAuth,
      provider: this.id,
      restaurantId: this.context.restaurantId,
      clientId: this.context.clientId,
      revokeEndpoint: oneDriveOAuth.revokeEndpoint ?? null,
      fetchImpl: this.context.fetchImpl,
    });
  }

  async account(): Promise<CloudAccount> {
    const me = await this.http.tryJson<{ id?: string; displayName?: string; mail?: string; userPrincipalName?: string }>({
      url: `${GRAPH}/me`,
      query: { $select: 'id,displayName,mail,userPrincipalName' },
    });
    return { id: me?.id ?? null, email: me?.mail || me?.userPrincipalName || null, name: me?.displayName ?? null };
  }

  async storageInfo(): Promise<StorageInfo> {
    const quota = await this.http.tryJson<{ used?: number; state?: string } & Record<string, unknown>>({
      url: `${GRAPH}/me/drive/quota`,
    });
    const remaining = Number((quota as { remaining?: number })?.remaining ?? NaN);
    const used = Number(quota?.used ?? NaN);
    const limit = Number.isFinite(remaining) && Number.isFinite(used) ? used + remaining : NaN;
    return {
      usedBytes: Number.isFinite(used) && used >= 0 ? used : null,
      limitBytes: Number.isFinite(limit) && limit > 0 ? limit : null,
      accountLabel: quota?.state && String(quota.state) !== 'normal' ? `OneDrive storage ${String(quota.state)}` : null,
    };
  }

  // ── folder tree, addressed by id (app-folder paths are relative) ───────────

  private async childFolder(parentId: string | null, name: string): Promise<{ id: string; created: boolean }> {
    const cacheKey = `${parentId ?? 'approot'}/${name}`;
    const cached = this.folderIds.get(cacheKey);
    if (cached) return { id: cached, created: false };
    const base = parentId ? `${GRAPH}/me/drive/items/${parentId}/children` : `${APP_ROOT}/children`;
    const page = await this.http.tryJson<GraphPage>({
      url: base,
      query: { $filter: `startswith(name,'${escapeFilter(name)}')`, $select: 'id,name,folder', $top: 200 },
      allowFailure: true,
    });
    const existing = (page?.value || []).find((item) => item.name === name && item.folder);
    if (existing?.id) {
      this.folderIds.set(cacheKey, existing.id);
      return { id: existing.id, created: false };
    }
    const created = await this.http.send({
      url: base,
      method: 'POST',
      query: { $select: 'id,name,size,file' },
      json: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      allowFailure: true,
    });
    // 409 = it already exists but my filter missed it (name case/encoding): reuse it.
    if (created.status === 409) {
      const reread = await this.http.tryJson<GraphPage>({ url: base, query: { $select: 'id,name,folder', $top: 999 }, allowFailure: true });
      const retry = (reread?.value || []).find((item) => item.name === name && item.folder);
      if (retry?.id) {
        this.folderIds.set(cacheKey, retry.id);
        return { id: retry.id, created: false };
      }
    }
    if (!created.ok) {
      throw graphError(created.status, created.text, this.id);
    }
    const item = created.json<GraphItem>();
    if (!item?.id) throw new CloudError('OneDrive created the backup folder but did not confirm it, so nothing was uploaded. Please try again.', 'server', { provider: this.id });
    this.folderIds.set(cacheKey, item.id);
    return { id: item.id, created: true };
  }

  async backupRootId(): Promise<string> {
    let parent: string | null = null;
    for (const segment of this.context.folderSegments) {
      parent = (await this.childFolder(parent, segment)).id;
    }
    if (!parent) throw new CloudError('The OneDrive backup folder could not be prepared.', 'config', { provider: this.id });
    return parent;
  }

  async ensureBackupFolder(): Promise<FolderInfo> {
    const id = await this.backupRootId();
    return { folderId: id, folderPath: `OneDrive/Apps/…/${this.context.folderSegments.join('/')}`, created: true };
  }

  async classFolderId(backupClass: BackupClass): Promise<string> {
    const root = await this.backupRootId();
    return (await this.childFolder(root, String(backupClass))).id;
  }

  // ── files ──────────────────────────────────────────────────────────────────

  async listBackups(): Promise<RemoteBackup[]> {
    const out: RemoteBackup[] = [];
    for (const backupClass of CLASSES) {
      const folderId = await this.classFolderId(backupClass);
      let url: string = `${GRAPH}/me/drive/items/${folderId}/children`;
      let query: Record<string, string | number> | undefined = { $select: 'id,name,size,lastModifiedDateTime,file', $top: 999 };
      while (url) {
        const page = await this.http.tryJson<GraphPage>({ url, query, allowFailure: true });
        for (const item of page?.value || []) {
          if (item.folder || item.deleted) continue;
          out.push({
            id: item.id || '',
            name: `${backupClass}/${item.name || ''}`,
            bytes: Number(item.size ?? 0) || 0,
            modifiedAt: item.lastModifiedDateTime ?? null,
            hash: item.file?.hashes?.quickXorHash ?? null,
            hashKind: item.file?.hashes?.quickXorHash ? 'quickxor' : 'none',
          });
        }
        const next = page?.['@odata.nextLink'];
        if (!next) break;
        url = next;
        query = undefined; // the link carries its own query
      }
    }
    return out.filter((file) => file.id);
  }

  /**
   * Graph's upload session is genuinely resumable: the session reports which byte
   * ranges are still expected, so an interrupted night-time upload continues from
   * there instead of re-sending the file over the restaurant's connection.
   */
  async uploadBackup(
    bytes: Buffer,
    name: string,
    resumeState?: Record<string, unknown> | null,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<UploadOutcome> {
    const { className, fileName } = splitName(name);
    const total = bytes.length;
    let uploadUrl = typeof resumeState?.uploadUrl === 'string' ? resumeState.uploadUrl : '';
    let sent = clamp(Number(resumeState?.sentBytes ?? 0) || 0, 0, total);
    let resumed = false;

    if (!uploadUrl) {
      const parent = await this.classFolderId(className as BackupClass);
      const session = await this.http.json<{ uploadUrl?: string; nextExpectedRanges?: string[] }>({
        url: `${GRAPH}/me/drive/items/${parent}:/${encodeURIComponent(fileName)}:/createUploadSession`,
        method: 'POST',
        json: { item: { '@microsoft.graph.conflictBehavior': 'fail', name: fileName }, parentReference: { itemId: parent } },
      });
      uploadUrl = session?.uploadUrl || '';
      if (!uploadUrl) throw new CloudError('OneDrive did not open an upload session. The local backup is safe; this copy is queued for retry.', 'server', { provider: this.id });
      sent = nextExpectedOffset(session.nextExpectedRanges, total);
      resumed = sent > 0;
    } else {
      resumed = true;
    }

    const chunkSize = 5 * 1024 * 1024; // Graph requires multiples of 320 KiB
    let offset = sent;
    const lastId = typeof resumeState?.remoteId === 'string' ? resumeState.remoteId : '';
    while (offset < total) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, total));
      const response = await this.http.send({
        url: uploadUrl,
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${offset}-${offset + chunk.length - 1}/${total}`,
        },
        body: chunk,
        timeoutMs: CLOUD_UPLOAD_TIMEOUT_MS,
        allowFailure: true,
      }).catch((error) => {
        // A cut connection is the whole reason Graph sessions exist: keep the byte
        // offset so the next attempt continues instead of re-sending the file.
        const base = error instanceof CloudError ? error : new CloudError(`OneDrive upload could not be completed: ${(error as Error)?.message || error}`, 'network', { provider: this.id });
        throw new CloudError(base.message, base.kind, {
          provider: this.id,
          status: base.status,
          retryable: base.retryable,
          retryAfterSeconds: base.retryAfterSeconds,
          resumeState: { uploadUrl, sentBytes: offset, totalBytes: total, remoteId: lastId },
        });
      });
      if (response.status === 200 || response.status === 201) {
        const item = response.json<GraphItem>();
        onProgress?.({ sentBytes: total, totalBytes: total, resumed });
        return {
          remoteId: item?.id || lastId,
          path: `${this.context.folderSegments.join('/')}/${className}/${fileName}`,
          bytes: total,
          resumed,
          resumeState: null,
        };
      }
      if (response.status === 202) {
        offset = nextExpectedOffset(rangesFrom(response.headers.get('Range'), total), total) || offset + chunk.length;
        onProgress?.({ sentBytes: offset, totalBytes: total, resumed });
        continue;
      }
      if (response.status === 401) {
        throw new CloudError('OneDrive access expired. Reconnect OneDrive to resume automatic backups.', 'auth', { provider: this.id, status: 401, resumeState: { uploadUrl, sentBytes: offset, totalBytes: total, remoteId: lastId } });
      }
      if (response.status === 404 || response.status === 410 || /expired/i.test(response.text)) {
        throw new CloudError('The OneDrive upload session expired, so this copy starts again from the beginning on the next attempt.', 'server', { provider: this.id, status: response.status });
      }
      throw graphError(response.status, response.text, this.id, { uploadUrl, sentBytes: offset, totalBytes: total, remoteId: lastId });
    }
    throw new CloudError('OneDrive finished the upload without confirming the file. The local backup is safe; this copy is queued for retry.', 'server', { provider: this.id });
  }

  async downloadBackup(remoteId: string): Promise<Buffer> {
    return this.http.download({ url: `${GRAPH}/me/drive/items/${encodeURIComponent(remoteId)}/content`, timeoutMs: CLOUD_UPLOAD_TIMEOUT_MS });
  }

  async deleteBackup(remoteId: string): Promise<void> {
    await this.http.send({ url: `${GRAPH}/me/drive/items/${encodeURIComponent(remoteId)}`, method: 'DELETE', allowFailure: true });
  }

  async verifyRemoteBackup(remoteId: string, expected: { bytes: number; sha256?: string | null; buffer?: Buffer | null }): Promise<RemoteVerification> {
    const item = await this.http.tryJson<GraphItem & { '@microsoft.graph.downloadUrl'?: string }>({
      url: `${GRAPH}/me/drive/items/${encodeURIComponent(remoteId)}`,
      query: { $select: 'id,name,size,lastModifiedDateTime,file,deleted' },
      allowFailure: true,
    });
    if (!item || item.deleted) return { present: false, bytes: null, hash: null, matches: false, limited: false, detail: 'not found in the app folder' };
    const bytes = Number(item.size ?? 0) || 0;
    const hash = item.file?.hashes?.quickXorHash ?? null;
    // Graph's checksum is quickXor, which has no crypto primitive in Node, so it is
    // only computed for objects small enough to walk without making a nightly backup
    // wait. Above that the size is confirmed and the bytes are checked on download.
    const computeHash = Boolean(expected.buffer) && bytes <= QUICKXOR_MAX_BYTES;
    const localHash = computeHash ? quickXorHash(expected.buffer as Buffer) : null;
    const matches = bytes === expected.bytes && (!localHash || !hash || hash === localHash);
    return {
      present: true,
      bytes,
      hash,
      matches,
      limited: !localHash || !hash,
      detail: matches
        ? localHash && hash
          ? 'size and quickXor checksum matched'
          : 'size matched (checksum not compared)'
        : `OneDrive reports ${bytes} bytes${localHash && hash && localHash !== hash ? ' with a different checksum' : ''}, local copy is ${expected.bytes} bytes`,
    };
  }

  async probeWriteAccess(fileName: string, content: string): Promise<{ remoteId: string; verified: boolean }> {
    const uploaded = await this.uploadBackup(Buffer.from(content, 'utf8'), `manual/${fileName}`);
    if (!uploaded.remoteId) {
      throw new CloudError('OneDrive accepted the test file without confirming it, so this folder cannot be used for backups yet.', 'permission', { provider: this.id });
    }
    const read = await this.downloadBackup(uploaded.remoteId);
    return { remoteId: uploaded.remoteId, verified: read.toString('utf8') === content };
  }

  async removeProbe(remoteId: string): Promise<void> {
    await this.deleteBackup(remoteId);
  }
}

function graphError(status: number, body: string, provider: 'onedrive', resumeState?: Record<string, unknown> | null): CloudError {
  const text = String(body || '');
  if (status === 403 && /accessDenied|ItemAccessCheckFailed/i.test(text)) {
    return new CloudError('OneDrive refused access to that folder. Reconnect OneDrive to grant this app access again.', 'permission', { provider, status, resumeState: resumeState ?? null });
  }
  if (status === 409 && /nameAlreadyExists|itemAlreadyExists/i.test(text)) {
    return new CloudError('A file with that name already exists in the OneDrive backup folder. The next attempt will reuse it.', 'server', { provider, status, resumeState: resumeState ?? null });
  }
  if (status === 429) {
    return new CloudError('OneDrive is asking for a slower pace. Automatic backups will retry on their own.', 'rate', { provider, status, resumeState: resumeState ?? null });
  }
  if (status === 507 || /quotaLimitReached|insufficient/i.test(text)) {
    return new CloudError('OneDrive is out of space, so the cloud copy could not be stored. Your local backup is safe — free space in your account or choose another provider.', 'quota', { provider, status, retryable: false, resumeState: resumeState ?? null });
  }
  if (status === 404) return new CloudError('That file is no longer in the OneDrive app folder.', 'not-found', { provider, status, resumeState: resumeState ?? null });
  return new CloudError(`OneDrive request failed (HTTP ${status}). Your local backup is safe; this copy is queued for retry.`, 'server', { provider, status, resumeState: resumeState ?? null });
}

/**
 * quickXorHash, Microsoft's checksum for drive items. Kept for completeness: it is
 * cheap to compare against, and one day Graph will expose SHA-256 the way Dropbox
 * does. It is O(bytes) with no crypto primitive available in Node for it.
 */
export function quickXorHash(buffer: Buffer): string {
  const maxChunk = 320 * 1024;
  const xor = Buffer.alloc(320);
  for (let start = 0; start < buffer.length; start += maxChunk) {
    const chunk = buffer.subarray(start, Math.min(start + maxChunk, buffer.length));
    for (let row = 0; row < 320; row++) {
      let byte = 0;
      for (let index = row; index < chunk.length; index += 320) byte ^= chunk[index];
      xor[row] ^= byte;
    }
  }
  if (buffer.length < maxChunk) {
    const lengthBytes = Buffer.alloc(8);
    lengthBytes.writeBigUInt64LE(BigInt(buffer.length));
    for (let index = 0; index < 8; index++) xor[(320 - 1 - index) % 320] ^= lengthBytes[index];
  }
  return xor.toString('base64');
}

function nextExpectedOffset(ranges: string[] | undefined, total: number): number {
  const first = (ranges || [])[0];
  if (!first) return 0;
  const match = /^(\d+)-?(\d*)$/.exec(first.trim());
  if (!match) return 0;
  const start = Number(match[1]);
  return Number.isFinite(start) ? clamp(start, 0, total) : 0;
}

function rangesFrom(header: string | null, total: number): string[] {
  if (!header) return [];
  const match = /bytes=(\d+)-(\d+)/.exec(header);
  if (!match) return [];
  return [`${Number(match[2]) + 1}-${total - 1}`];
}

function splitName(name: string): { className: string; fileName: string } {
  const parts = String(name || '').split('/').filter(Boolean);
  if (parts.length >= 2) return { className: parts[0], fileName: parts.slice(1).join('/') };
  return { className: 'manual', fileName: parts[0] || 'backup.rdbak' };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function escapeFilter(value: string): string {
  return value.replace(/'/g, "''");
}
