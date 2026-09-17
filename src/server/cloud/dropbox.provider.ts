/**
 * Dropbox destination.
 *
 * The OAuth client is registered in **App Folder** mode, which is the whole
 * point of this file: the app can only ever see its own folder inside the
 * customer's Dropbox, and the folder path in the API is relative to it
 * (`/Restaurant Backup/<restaurant>/<class>/…`). Nothing in their Dropbox outside
 * that folder is reachable, and no copy exists on our infrastructure.
 *
 * Dropbox hands out a genuine content hash (SHA-256 of the stored bytes), so a
 * cloud copy can be confirmed byte-for-byte without downloading it again.
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

const RPC = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const CLASSES: BackupClass[] = ['daily', 'weekly', 'monthly', 'manual'];

export const dropboxOAuth: OAuthSpec = {
  authorizeEndpoint: 'https://www.dropbox.com/oauth2/authorize',
  tokenEndpoint: 'https://api.dropbox.com/oauth2/token',
  // App-folder-scoped apps are limited to these two write/read scopes plus
  // account info; there is no scope here that reaches the rest of the account.
  scopes: ['files.content.write', 'files.content.read', 'account_info.read'],
  authorizeParams: { token_access_type: 'offline' },
  tokenParams: {},
  authStyle: 'pkce-public',
  deviceCodeEndpoint: null,
  refreshRequiresClientSecret: false,
  // Dropbox revocation is "remove this app" in the account's settings; there is
  // no token endpoint for it, so disconnecting clears the stored tokens locally.
  revokeEndpoint: null,
};

interface DropboxEntry {
  '.tag'?: 'file' | 'folder' | 'deleted';
  name?: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
  server_modified?: string;
  content_hash?: string;
  is_downloadable?: boolean;
}

interface DropboxListing {
  entries?: DropboxEntry[];
  cursor?: string;
  has_more?: boolean;
}

export class DropboxProvider implements CloudStorageProvider {
  readonly id = 'dropbox' as const;
  readonly label = 'Dropbox';
  readonly accessSummary =
    'This app can create, read and delete only the files inside its own Dropbox app folder (Restaurant Backup). It cannot see anything else in your Dropbox.';
  readonly oauth = dropboxOAuth;

  private readonly http: CloudHttp;

  constructor(private readonly context: CloudRequestContext) {
    this.http = new CloudHttp({
      provider: this.id,
      fetchImpl: context.fetchImpl,
      timeoutMs: CLOUD_UPLOAD_TIMEOUT_MS,
      getAccessToken: tokenLoaderFor({
        spec: dropboxOAuth,
        provider: this.id,
        restaurantId: context.restaurantId,
        clientId: context.clientId,
        clientSecret: context.clientSecret,
        fetchImpl: context.fetchImpl,
      }),
    });
  }

  /** RPC calls take JSON; Dropbox answers with `application/json`. */
  private rpc<T>(path: string, payload: unknown): Promise<T> {
    return this.http.json<T>({ url: `${RPC}${path}`, method: 'POST', headers: { 'Content-Type': 'application/json' }, json: payload ?? {} });
  }

  /** Content calls take the arguments in a header and the bytes as the body. */
  private content<T>(path: string, arg: Record<string, unknown>, body: Buffer): Promise<T> {
    return this.http.json<T>({
      url: `${CONTENT}${path}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify(arg) },
      body,
      timeoutMs: CLOUD_UPLOAD_TIMEOUT_MS,
    });
  }

  // ── connecting ─────────────────────────────────────────────────────────────

  async beginAuthorization(redirectUri: string): Promise<AuthorizeRequest> {
    const begun = beginAuthForProvider({
      spec: dropboxOAuth,
      provider: this.id,
      restaurantId: this.context.restaurantId,
      clientId: this.context.clientId,
      redirectUri,
    });
    return { url: begun.url, state: begun.state, usesRedirect: true };
  }

  async completeAuthorization(code: string, state: string): Promise<CloudTokens> {
    return finishAuthForProvider({
      spec: dropboxOAuth,
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
      spec: dropboxOAuth,
      provider: this.id,
      restaurantId: this.context.restaurantId,
      clientId: this.context.clientId,
      revokeEndpoint: null,
      fetchImpl: this.context.fetchImpl,
    });
  }

  async account(): Promise<CloudAccount> {
    const me = await this.http.tryJson<{ account_id?: string; email?: string; name?: string; given_name?: string; display_name?: string }>({
      url: `${RPC}/users/get_current_account`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      json: {},
    });
    return { id: me?.account_id ?? null, email: me?.email ?? null, name: me?.display_name || me?.name || me?.given_name || null };
  }

  async storageInfo(): Promise<StorageInfo> {
    const usage = await this.http.tryJson<{ used?: number; allocation?: { '.tag'?: string; allocated?: number } }>({
      url: `${RPC}/users/get_space_usage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      json: {},
    });
    const allocated = Number(usage?.allocation?.allocated ?? NaN);
    const used = Number(usage?.used ?? NaN);
    return {
      usedBytes: Number.isFinite(used) && used >= 0 ? used : null,
      limitBytes: Number.isFinite(allocated) && allocated > 0 ? allocated : null,
      // "individual" means unlimited-by-plan; there is no number worth showing.
      accountLabel: usage?.allocation?.['.tag'] === 'individual' && !Number.isFinite(allocated) ? 'Dropbox (no fixed quota reported)' : null,
    };
  }

  // ── folder tree ────────────────────────────────────────────────────────────

  private get rootPath(): string {
    return `/${this.context.folderSegments.join('/')}`.replace(/\/{2,}/g, '/');
  }

  /**
   * Dropbox creates missing parent folders on upload, so "ensuring" the folder
   * means checking what is there — the probe upload during connect is what proves
   * it can actually be written to.
   */
  async ensureBackupFolder(): Promise<FolderInfo> {
    let created = false;
    for (const backupClass of CLASSES) {
      const target = `${this.rootPath}/${backupClass}`;
      const exists = await this.metadata(target).catch(() => null);
      if (!exists) {
        // A placeholder keeps the four folders visible in the customer's Dropbox
        // even before the first backup of that class exists.
        await this.content<{ path_display?: string }>('/files/upload', {
          path: `${target}/.keep`,
          mode: { '.tag': 'overwrite' },
          autorename: false,
          mute: true,
        }, Buffer.from('Placeholder created by the restaurant app so the backup folders are visible. Safe to delete.\n', 'utf8')).catch(() => null);
        created = true;
      }
    }
    return { folderId: null, folderPath: this.rootPath.replace(/^\//, ''), created };
  }

  private async metadata(path: string): Promise<DropboxEntry | null> {
    const response = await this.http.send({
      url: `${RPC}/files/get_metadata`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      json: { path },
      allowFailure: true,
    });
    if (response.status === 409) return null;
    if (!response.ok) throw dropboxError(response.status, response.text, this.id);
    return response.json<DropboxEntry>();
  }

  // ── files ──────────────────────────────────────────────────────────────────

  async listBackups(): Promise<RemoteBackup[]> {
    const out: RemoteBackup[] = [];
    for (const backupClass of CLASSES) {
      const target = `${this.rootPath}/${backupClass}`;
      let cursor = '';
      for (let page = 0; page < 20; page++) {
        const listing = cursor
          ? await this.rpc<DropboxListing>('/files/list_folder/continue', { cursor })
          : await this.rpc<DropboxListing>('/files/list_folder', { path: target, limit: 500, with_deleted: false });
        for (const entry of listing?.entries || []) {
          if (entry['.tag'] !== 'file') continue;
          if (!entry.path_display || entry.path_display.endsWith('.keep')) continue;
          out.push({
            id: entry.path_display,
            name: `${backupClass}/${entry.name || ''}`,
            bytes: Number(entry.size ?? 0) || 0,
            modifiedAt: entry.server_modified ?? null,
            hash: entry.content_hash ? String(entry.content_hash).toLowerCase() : null,
            hashKind: entry.content_hash ? 'sha256' : 'none',
          });
        }
        if (!listing?.has_more || !listing.cursor) break;
        cursor = listing.cursor;
      }
    }
    return out;
  }

  /**
   * Upload sessions are the reason Dropbox gets big backups well: an interrupted
   * session can be appended to at the exact offset, and the session id is what the
   * manifest stores so a restart continues instead of restarting.
   */
  async uploadBackup(
    bytes: Buffer,
    name: string,
    resumeState?: Record<string, unknown> | null,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<UploadOutcome> {
    const { className, fileName } = splitName(name);
    const target = `${this.rootPath}/${className}/${fileName}`;
    const total = bytes.length;
    const chunkSize = 8 * 1024 * 1024;
    let sessionId = typeof resumeState?.sessionId === 'string' ? resumeState.sessionId : '';
    let offset = clamp(Number(resumeState?.offsetBytes ?? 0) || 0, 0, total);
    const resumed = Boolean(sessionId);
    // The server's offset is trusted once per attempt; a second mismatch means the
    // session is broken and a fresh upload is the honest answer.
    let offsetCorrected = false;

    if (!sessionId && offset > 0) offset = 0;

    if (!sessionId) {
      const startBody = bytes.subarray(0, Math.min(chunkSize, total));
      const started = await this.content<{ session_id?: string }>('/files/upload_session/start', { close: false }, startBody);
      sessionId = String(started?.session_id || '');
      if (!sessionId) throw new CloudError('Dropbox did not open an upload session. The local backup is safe; this copy is queued for retry.', 'server', { provider: this.id });
      offset = startBody.length;
      onProgress?.({ sentBytes: offset, totalBytes: total, resumed: false });
    }

    while (offset < total) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, total));
      const response = await this.http.send({
        url: `${CONTENT}/files/upload_session/append_v2`,
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset }, close: false }) },
        body: chunk,
        timeoutMs: CLOUD_UPLOAD_TIMEOUT_MS,
        allowFailure: true,
      }).catch((error) => {
        // A cut connection keeps the session and the offset: the next attempt
        // appends from where this one stopped instead of re-uploading the file.
        const base = error instanceof CloudError ? error : new CloudError(`Dropbox upload could not be completed: ${(error as Error)?.message || error}`, 'network', { provider: this.id });
        throw new CloudError(base.message, base.kind, {
          provider: this.id,
          status: base.status,
          retryable: base.retryable,
          retryAfterSeconds: base.retryAfterSeconds,
          resumeState: { sessionId, offsetBytes: offset, totalBytes: total },
        });
      });
      if (!response.ok) {
        // Dropbox answers an append whose offset drifted with the offset it really
        // holds. Trusting it once here is the difference between a resumed upload and
        // a queue that retries the same mismatch every night forever.
        const mismatch = /incorrect_offset/.test(response.text);
        if (mismatch && !offsetCorrected) {
          const serverOffset = Number(JSON.parse(response.text || '{}')?.error?.incorrect_offset?.expected_offset);
          if (Number.isFinite(serverOffset) && serverOffset >= 0 && serverOffset < total) {
            offsetCorrected = true;
            // The server's offset wins: it knows how many bytes it kept.
            offset = serverOffset;
            continue;
          }
        }
        throw dropboxError(response.status, response.text, this.id, { sessionId, offsetBytes: offset, totalBytes: total });
      }
      offset += chunk.length;
      onProgress?.({ sentBytes: offset, totalBytes: total, resumed });
    }

    const finished = await this.http.send({
      url: `${CONTENT}/files/upload_session/finish`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          cursor: { session_id: sessionId, offset },
          commit: { path: target, mode: { '.tag': 'add' }, autorename: false, mute: true, content_hash: sha256Hex(bytes) },
        }),
      },
      body: Buffer.alloc(0),
      timeoutMs: CLOUD_UPLOAD_TIMEOUT_MS,
      allowFailure: true,
    });
    if (!finished.ok) {
      throw dropboxError(finished.status, finished.text, this.id, { sessionId, offsetBytes: offset, totalBytes: total });
    }
    const file = finished.json<DropboxEntry>();
    return {
      remoteId: file?.path_display || target,
      path: `${this.context.folderSegments.join('/')}/${className}/${fileName}`,
      bytes: total,
      resumed,
      resumeState: null,
    };
  }

  /**
   * Dropbox's download API is path-based, so the path *is* the id here; a file
   * renamed by the owner shows up as "missing" rather than silently restoring the
   * wrong object.
   */
  async downloadBackup(remoteId: string): Promise<Buffer> {
    const response = await this.http.send({
      url: `${CONTENT}/files/download`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Dropbox-API-Arg': JSON.stringify({ path: remoteId }) },
      body: Buffer.alloc(0),
      timeoutMs: CLOUD_UPLOAD_TIMEOUT_MS,
      expect: 'binary',
      allowFailure: true,
    });
    if (!response.ok) throw dropboxError(response.status, response.text, this.id);
    return response.buffer();
  }

  async deleteBackup(remoteId: string): Promise<void> {
    await this.http.send({
      url: `${RPC}/files/delete_v2`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      json: { path: remoteId },
      allowFailure: true,
    });
  }

  async verifyRemoteBackup(remoteId: string, expected: { bytes: number; sha256?: string | null; buffer?: Buffer | null }): Promise<RemoteVerification> {
    const file = await this.metadata(remoteId).catch(() => null);
    if (!file || file['.tag'] === 'deleted') {
      return { present: false, bytes: null, hash: null, matches: false, limited: false, detail: 'not found in the app folder' };
    }
    const bytes = Number(file.size ?? 0) || 0;
    const hash = file.content_hash ? String(file.content_hash).toLowerCase() : null;
    const hashMatches = !hash || !expected.sha256 ? true : hash === expected.sha256.toLowerCase();
    return {
      present: true,
      bytes,
      hash,
      matches: bytes === expected.bytes && hashMatches,
      // Dropbox's content hash is SHA-256 of the stored bytes, which is exactly
      // what the manifest records, so this is a real content confirmation.
      limited: false,
      detail:
        bytes === expected.bytes && hashMatches
          ? 'size and SHA-256 matched'
          : `Dropbox reports ${bytes} bytes${hash && expected.sha256 && !hashMatches ? ' with a different content hash' : ''}, local copy is ${expected.bytes} bytes`,
    };
  }

  async probeWriteAccess(fileName: string, content: string): Promise<{ remoteId: string; verified: boolean }> {
    const uploaded = await this.uploadBackup(Buffer.from(content, 'utf8'), `manual/${fileName}`);
    const read = await this.downloadBackup(uploaded.remoteId);
    return { remoteId: uploaded.remoteId, verified: read.toString('utf8') === content };
  }

  async removeProbe(remoteId: string): Promise<void> {
    await this.deleteBackup(remoteId);
  }
}

/**
 * Dropbox reports errors as `{ error_summary: "path/not_found", ... }`. The
 * summary is what tells "you ran out of space" apart from "this folder is gone",
 * so it is inspected before falling back to the shared HTTP classification.
 */
function dropboxError(status: number, body: string, provider: 'dropbox', resumeState?: Record<string, unknown> | null): CloudError {
  const text = String(body || '');
  let summary = '';
  try {
    summary = String(JSON.parse(text)?.error_summary || '');
  } catch {
    /* not JSON: the HTTP status still says something */
  }
  const options = { provider, status, resumeState: resumeState ?? null } as const;
  if (status === 401) return new CloudError('Dropbox access expired. Reconnect Dropbox to resume automatic backups.', 'auth', options);
  if (status === 403 && /missing_scope|incorrect-token|AccessNotPermitted/i.test(summary + text)) {
    return new CloudError('Dropbox says this app no longer has permission for that folder. Reconnect Dropbox to grant it again.', 'permission', options);
  }
  if (status === 409 && /insufficient_space/i.test(summary)) {
    return new CloudError('Dropbox is out of space, so the cloud copy could not be stored. Your local backup is safe — free space in your account or choose another provider.', 'quota', { ...options, retryable: false });
  }
  if (status === 409 && /incorrect_offset/i.test(summary)) {
    // Dropbox answers a resumed-but-mismatched append with the offset it actually
    // holds. Using it is what makes the retry continue instead of failing forever.
    let expectedOffset = Number.isFinite(Number(JSON.parse(text || '{}')?.error?.incorrect_offset?.expected_offset))
      ? Number(JSON.parse(text || '{}').error.incorrect_offset.expected_offset)
      : NaN;
    if (!Number.isFinite(expectedOffset)) expectedOffset = -1;
    return new CloudError(
      expectedOffset >= 0
        ? `Dropbox had received ${expectedOffset} bytes of this upload, so the next attempt continues from there.`
        : 'Dropbox could not match the upload offset, so the next attempt continues from what the server has.',
      'server',
      { ...options, retryAfterSeconds: 0 },
    );
  }
  if (status === 409 && /no_permission|not_found|rejected/i.test(summary)) {
    return new CloudError(`Dropbox refused that operation (${summary.split('/')[0] || 'rejected'}). The local backup is safe; this copy is queued for retry.`, 'permission', options);
  }
  if (status === 429 || /too_many_requests|slow_down|too_many_write_operations/i.test(summary)) {
    return new CloudError('Dropbox asked for a slower pace (busy account). Automatic backups will retry on their own.', 'rate', options);
  }
  if (status >= 500) {
    return new CloudError(`Dropbox had a service problem (HTTP ${status}). Your local backup is safe; retry happens automatically.`, 'server', options);
  }
  return new CloudError(`Dropbox request failed (HTTP ${status}${summary ? `, ${summary.split('/')[0]}` : ''}). Your local backup is safe.`, 'server', options);
}

function splitName(name: string): { className: string; fileName: string } {
  const parts = String(name || '').split('/').filter(Boolean);
  if (parts.length >= 2) return { className: parts[0], fileName: parts.slice(1).join('/') };
  return { className: 'manual', fileName: parts[0] || 'backup.rdbak' };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Dropbox's `content_hash` is hex SHA-256 of the file content. */
export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
