/**
 * Google Drive destination.
 *
 * Everything lands inside the customer's own Drive: the app asks for the narrow
 * `drive.file` scope, which means it can only touch files it created itself —
 * never the rest of their account, and never another customer's. The tree is
 * `Restaurant Backup/<restaurant>/<class>/`, created once and reused.
 *
 * Google bills and stores this data; we pay nothing for it and hold no copy of
 * it anywhere. The OAuth client id comes from the environment (or the
 * installation's own registered client), never from a secret we distribute.
 */
import { createHash } from 'crypto';
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
import { beginAuthForProvider, disconnectProvider, finishAuthForProvider, tokenLoaderFor } from './oauth.js';
import { CloudHttp } from './http.js';
import type { BackupClass } from '../backupConfig.js';

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const CLASSES: BackupClass[] = ['daily', 'weekly', 'monthly', 'manual'];

export const googleOAuth: OAuthSpec = {
  authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  // drive.file is the narrowest scope that can store a file. email/openid only
  // exist so the connected card can say which account this is.
  scopes: ['https://www.googleapis.com/auth/drive.file', 'email', 'openid'],
  authorizeParams: { access_type: 'offline', include_granted_scopes: 'true' },
  tokenParams: {},
  authStyle: 'pkce-public',
  deviceCodeEndpoint: null,
  refreshRequiresClientSecret: false,
  revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
};

interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  trashed?: boolean;
  parents?: string[];
}

export class GoogleDriveProvider implements CloudStorageProvider {
  readonly id = 'google-drive' as const;
  readonly label = 'Google Drive';
  readonly accessSummary =
    'This app can create, read and delete only the backup files it stores in your Restaurant Backup folder. It cannot open any other file in your Google Drive.';
  readonly oauth = googleOAuth;

  private readonly http: CloudHttp;
  private readonly folderIds = new Map<string, string>();

  constructor(private readonly context: CloudRequestContext) {
    this.http = new CloudHttp({
      provider: this.id,
      fetchImpl: context.fetchImpl,
      timeoutMs: CLOUD_UPLOAD_TIMEOUT_MS,
      getAccessToken: tokenLoaderFor({
        spec: googleOAuth,
        provider: this.id,
        restaurantId: context.restaurantId,
        clientId: context.clientId,
        clientSecret: context.clientSecret,
        fetchImpl: context.fetchImpl,
      }),
    });
  }

  // ── connecting ─────────────────────────────────────────────────────────────

  async beginAuthorization(redirectUri: string): Promise<AuthorizeRequest> {
    const begun = beginAuthForProvider({
      spec: googleOAuth,
      provider: this.id,
      restaurantId: this.context.restaurantId,
      clientId: this.context.clientId,
      redirectUri,
    });
    return { url: begun.url, state: begun.state, usesRedirect: true };
  }

  async completeAuthorization(code: string, state: string): Promise<CloudTokens> {
    return finishAuthForProvider({
      spec: googleOAuth,
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
      spec: googleOAuth,
      provider: this.id,
      restaurantId: this.context.restaurantId,
      clientId: this.context.clientId,
      revokeEndpoint: googleOAuth.revokeEndpoint ?? null,
      fetchImpl: this.context.fetchImpl,
    });
  }

  async account(): Promise<CloudAccount> {
    const info = await this.http.tryJson<{ email?: string; name?: string; sub?: string }>({
      url: 'https://www.googleapis.com/oauth2/v3/userinfo',
    });
    return { id: info?.sub ?? null, email: info?.email ?? null, name: info?.name ?? null };
  }

  async storageInfo(): Promise<StorageInfo> {
    const about = await this.http.tryJson<{ storageQuota?: { usage?: string; limit?: string } }>({
      url: `${API}/about`,
      query: { fields: 'storageQuota' },
    });
    const usage = Number(about?.storageQuota?.usage ?? '');
    const limit = Number(about?.storageQuota?.limit ?? '');
    return {
      usedBytes: Number.isFinite(usage) && usage > 0 ? usage : null,
      limitBytes: Number.isFinite(limit) && limit > 0 ? limit : null,
      accountLabel: null,
    };
  }

  // ── folder tree (created once, then reused) ────────────────────────────────

  private async findOrCreateFolder(name: string, parent: string | null): Promise<{ id: string; created: boolean }> {
    const cacheKey = parent ? `${parent}/${name}` : `root/${name}`;
    const cached = this.folderIds.get(cacheKey);
    if (cached) return { id: cached, created: false };
    const query = [`name = '${escapeValue(name)}'`, `mimeType = '${FOLDER_MIME}'`, 'trashed = false', parent ? `'${parent}' in parents` : `'root' in parents`].join(' and ');
    const found = await this.http.json<{ files?: DriveFile[] }>({
      url: `${API}/files`,
      query: { q: query, spaces: 'drive', fields: 'files(id,name)', pageSize: 10, supportsAllDrives: true, includeItemsFromAllDrives: true },
    });
    const existing = (found?.files || []).find((file) => file.name === name);
    if (existing) {
      this.folderIds.set(cacheKey, existing.id);
      return { id: existing.id, created: false };
    }
    const created = await this.http.json<DriveFile>({
      url: `${API}/files`,
      method: 'POST',
      query: { fields: 'id,name', supportsAllDrives: true },
      json: { name, mimeType: FOLDER_MIME, parents: parent ? [parent] : ['root'], properties: { restaurantBackup: 'true' } },
    });
    if (!created?.id) {
      throw new CloudError('Google Drive did not confirm the backup folder, so nothing was uploaded. Please try again.', 'server', { provider: this.id });
    }
    this.folderIds.set(cacheKey, created.id);
    return { id: created.id, created: true };
  }

  /** `Restaurant Backup/<restaurant>` — the root of this installation's tree. */
  async backupRootId(): Promise<string> {
    let parent: string | null = null;
    for (const segment of this.context.folderSegments) {
      parent = (await this.findOrCreateFolder(segment, parent)).id;
    }
    if (!parent) throw new CloudError('The backup folder in Google Drive could not be prepared.', 'config', { provider: this.id });
    return parent;
  }

  async ensureBackupFolder(): Promise<FolderInfo> {
    const id = await this.backupRootId();
    return { folderId: id, folderPath: this.context.folderSegments.join('/'), created: true };
  }

  async classFolderId(backupClass: BackupClass): Promise<string> {
    const root = await this.backupRootId();
    return (await this.findOrCreateFolder(String(backupClass), root)).id;
  }

  // ── files ──────────────────────────────────────────────────────────────────

  async listBackups(): Promise<RemoteBackup[]> {
    const files: RemoteBackup[] = [];
    for (const backupClass of CLASSES) {
      const folderId = backupClass === undefined ? null : await this.classFolderId(backupClass);
      const page = await this.http.tryJson<{ files?: DriveFile[] }>({
        url: `${API}/files`,
        query: {
          q: `'${folderId}' in parents and trashed = false`,
          fields: 'files(id,name,size,modifiedTime,md5Checksum,mimeType)',
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
      });
      for (const file of page?.files || []) {
        if (file.mimeType === FOLDER_MIME) continue;
        files.push({
          id: file.id,
          name: `${backupClass}/${file.name}`,
          bytes: Number(file.size ?? 0) || 0,
          modifiedAt: file.modifiedTime ?? null,
          hash: file.md5Checksum ? String(file.md5Checksum).toLowerCase() : null,
          hashKind: file.md5Checksum ? 'md5' : 'none',
        });
      }
    }
    return files;
  }

  /**
   * Resumable upload. The session URI is handed back to the caller (stored on the
   * manifest record) so an upload cut off by a flaky restaurant connection
   * continues from the last byte received instead of paying for the file again.
   */
  async uploadBackup(
    bytes: Buffer,
    name: string,
    resumeState?: Record<string, unknown> | null,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<UploadOutcome> {
    const { className, fileName } = splitName(name);
    const total = bytes.length;
    const path = `${this.context.folderSegments.join('/')}/${className}/${fileName}`;
    let sessionUri = typeof resumeState?.sessionUri === 'string' ? resumeState.sessionUri : '';
    let sent = clamp(Number(resumeState?.sentBytes ?? 0) || 0, 0, total);
    let resumed = false;

    if (!sessionUri) {
      // A folder that cannot be prepared is reported as it is (revoked access, no
      // permission, provider outage) — not flattened into "try again later".
      const parent = await this.classFolderId(className as BackupClass);
      const started = await this.http.send({
        url: `${API}/files`,
        method: 'POST',
        query: { uploadType: 'resumable', fields: 'id,name,size,md5Checksum', supportsAllDrives: true },
        headers: { 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(total) },
        json: { name: fileName, mimeType: 'application/octet-stream', parents: [parent] },
      });
      sessionUri = started.headers.get('location') || '';
      if (!sessionUri) {
        throw new CloudError('Google Drive did not open an upload session. The local backup is safe; this copy is queued for retry.', 'server', { provider: this.id });
      }
    } else {
      const status = await this.push(sessionUri, Buffer.alloc(0), 0, total, true);
      sent = status.sentBytes;
      resumed = true;
      if (status.done) {
        return { remoteId: status.remoteId || String(resumeState?.remoteId || ''), path, bytes: total, resumed: true, resumeState: null };
      }
    }

    const chunkSize = 8 * 1024 * 1024;
    let offset = sent;
    while (offset < total) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, total));
      const result = await this.push(sessionUri, chunk, offset, total, false);
      if (result.done) {
        onProgress?.({ sentBytes: total, totalBytes: total, resumed });
        return { remoteId: result.remoteId || '', path, bytes: total, resumed, resumeState: null };
      }
      offset = Math.max(result.sentBytes, offset + chunk.length);
      onProgress?.({ sentBytes: offset, totalBytes: total, resumed });
    }
    throw new CloudError('Google Drive finished the upload without confirming the file. The local backup is safe; this copy is queued for retry.', 'server', { provider: this.id, retryable: true });
  }

  private async push(
    sessionUri: string,
    chunk: Buffer,
    start: number,
    total: number,
    probeOnly: boolean,
  ): Promise<{ sentBytes: number; done: boolean; remoteId?: string }> {
    const resumable = { sessionUri, sentBytes: start, totalBytes: total };
    const withResume = (error: unknown): CloudError => {
      const base = error instanceof CloudError ? error : new CloudError(`Google Drive upload could not be completed: ${(error as Error)?.message || error}`, 'network', { provider: this.id });
      // A dropped connection is the normal case for resuming, so the session must
      // survive the error rather than only being returned on success.
      return new CloudError(base.message, base.kind, { provider: this.id, status: base.status, retryable: base.retryable, retryAfterSeconds: base.retryAfterSeconds, resumeState: resumable });
    };
    const response = await this.http.send({
      url: sessionUri,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': probeOnly ? `bytes */${total}` : `bytes ${start}-${start + chunk.length - 1}/${total}`,
      },
      body: chunk.length ? chunk : undefined,
      timeoutMs: CLOUD_UPLOAD_TIMEOUT_MS,
      allowFailure: true,
    }).catch((error) => {
      throw withResume(error);
    });
    if (response.status === 308) {
      const match = /bytes=\d+-(\d+)/.exec(response.headers.get('range') || '');
      return { sentBytes: match ? Number(match[1]) + 1 : start, done: false };
    }
    if (response.status === 200 || response.status === 201) {
      const file = response.json<{ id?: string }>();
      return { sentBytes: total, done: true, remoteId: file?.id || '' };
    }
    if (response.status === 404 || response.status === 410 || (response.status === 400 && /session/i.test(response.text))) {
      throw new CloudError('The Google Drive upload session expired, so this copy starts again from the beginning on the next attempt.', 'server', { provider: this.id, status: response.status });
    }
    if (response.status === 401) {
      // CloudHttp already tried one refresh; reaching here means the account has
      // to sign in again. Nothing is retried silently.
      throw new CloudError('Google Drive access expired. Reconnect Google Drive to resume automatic backups.', 'auth', { provider: this.id, status: 401, resumeState: resumable });
    }
    throw new CloudError(`Google Drive refused the upload (HTTP ${response.status}). Your local backup is safe; this copy is queued for retry.`, response.status === 403 ? 'permission' : 'server', {
      provider: this.id,
      status: response.status,
      resumeState: resumable,
    });
  }

  async downloadBackup(remoteId: string): Promise<Buffer> {
    return this.http.download({ url: `${API}/files/${encodeURIComponent(remoteId)}`, query: { alt: 'media', supportsAllDrives: true }, timeoutMs: CLOUD_UPLOAD_TIMEOUT_MS });
  }

  async deleteBackup(remoteId: string): Promise<void> {
    await this.http.send({ url: `${API}/files/${encodeURIComponent(remoteId)}`, method: 'DELETE', query: { supportsAllDrives: true }, allowFailure: true });
  }

  /**
   * Metadata-only check (size + Drive's MD5 of the stored object), so a cloud copy
   * can be confirmed without downloading it on a metered connection. Full content
   * verification — re-download, decrypt, validate — happens before a restore.
   */
  async verifyRemoteBackup(remoteId: string, expected: { bytes: number; sha256?: string | null; buffer?: Buffer | null }): Promise<RemoteVerification> {
    const expectedMd5 = expected.buffer ? md5Hex(expected.buffer) : null;
    const file = await this.http.tryJson<DriveFile>({
      url: `${API}/files/${encodeURIComponent(remoteId)}`,
      query: { fields: 'id,name,size,md5Checksum,trashed', supportsAllDrives: true },
      allowFailure: true,
    });
    if (!file || file.trashed) return { present: false, bytes: null, hash: null, matches: false, limited: false, detail: 'not found in the backup folder' };
    const bytes = Number(file.size ?? 0) || 0;
    const hash = file.md5Checksum ? String(file.md5Checksum).toLowerCase() : null;
    let matches = bytes === expected.bytes;
    if (matches && hash && expectedMd5) matches = hash === expectedMd5;
    return {
      present: true,
      bytes,
      hash,
      matches,
      limited: !hash || !expectedMd5,
      detail: matches
        ? 'size and MD5 matched'
        : `Drive reports ${bytes} bytes${hash && expectedMd5 && hash !== expectedMd5 ? ' with a different checksum' : ''}, local copy is ${expected.bytes} bytes`,
    };
  }

  /**
   * Prove write, read and delete actually work before the UI is allowed to say
   * "Connected" — a folder the account cannot write to is worse than none.
   */
  async probeWriteAccess(fileName: string, content: string): Promise<{ remoteId: string; verified: boolean }> {
    // Same code path a real backup uses (folder creation, resumable upload,
    // download), so "Connected" means the next 2 GB nightly backup would work.
    const uploaded = await this.uploadBackup(Buffer.from(content, 'utf8'), `manual/${fileName}`);
    if (!uploaded.remoteId) {
      throw new CloudError('Google Drive accepted the test file without confirming it, so this folder cannot be used for backups yet.', 'permission', { provider: this.id });
    }
    const read = await this.downloadBackup(uploaded.remoteId);
    return { remoteId: uploaded.remoteId, verified: read.toString('utf8') === content };
  }

  async removeProbe(remoteId: string): Promise<void> {
    await this.deleteBackup(remoteId);
  }
}

function splitName(name: string): { className: string; fileName: string } {
  const parts = String(name || '').split('/').filter(Boolean);
  if (parts.length >= 2) return { className: parts[0], fileName: parts.slice(1).join('/') };
  return { className: 'manual', fileName: parts[0] || 'backup.rdbak' };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** MD5 of the exact bytes uploaded; Drive reports the same value for the object. */
export function md5Hex(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}
