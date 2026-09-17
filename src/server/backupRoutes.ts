/**
 * Backup + cloud routes. Registered from inside `createApp()` (one import, one
 * call) so this feature reuses the app's existing admin auth, license gate, audit
 * middleware and JSON error handling instead of inventing a parallel stack.
 *
 *   GET  /api/admin/backup/status              overview for the Backup Center
 *   GET  /api/admin/backup/history             every backup, local + cloud state
 *   GET  /api/admin/backup/config              schedule / retention / location
 *   POST /api/admin/backup/config              change them, set the password
 *   POST /api/admin/backup/create              run a backup now
 *   POST /api/admin/backup/upload              push pending copies to the cloud now
 *   POST /api/admin/backup/restore             restore (safety backup first)
 *   POST /api/admin/backup/import              register a .rdbak the owner kept
 *   POST /api/admin/backup/:id/verify          prove one file without restoring
 *   GET  /api/admin/backup/:id/export          download the file itself
 *   POST /api/admin/backup/:id/delete            delete one local file (guarded)
 *   POST /api/admin/backup/first-run           "Maybe later" / "Finished setup"
 *   GET  /api/admin/cloud/providers            what can be connected, and why not
 *   GET  /api/admin/cloud/status               protected / pending / attention
 *   POST /api/admin/cloud/:provider/connect    start OAuth, get a URL to open
 *   GET  /api/cloud/callback                   provider redirect target (public)
 *   GET  /api/admin/cloud/connect-result       poll the pending connect
 *   POST /api/admin/cloud/:provider/callback   finish a device-code sign-in
 *   POST /api/admin/cloud/disconnect           forget access, keep the files
 *   POST /api/admin/cloud/test                 prove the connection again
 *   GET  /api/admin/cloud/remote               list the customer's cloud copies
 *   POST /api/admin/cloud/remote/import        download one and register it
 *   POST /api/admin/cloud/remote/delete         delete one (guarded)
 */
import fs from 'fs';
import path from 'path';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { BackupConfig } from './backupConfig.js';
import {
  completeFirstRun,
  dismissFirstRunPrompt,
  effectiveBackupDir,
  loadBackupConfig,
  publicBackupConfig,
  shouldPromptFirstRun,
  updateBackupConfig,
  type CloudProviderId,
} from './backupConfig.js';
import { credentialBackendInfo } from './credentials.js';
import {
  BackupError,
  MAX_BACKUP_BYTES,
  backupForExport,
  changeBackupPassword,
  disableBackupPassword,
  enableBackupEncryption,
  backupLocationInfo,
  deleteBackupRecord,
  diskSpaceInfo,
  importBackup,
  listBackups,
  refreshBackupScheduler,
  restoreBackup,
  runNow,
  schedulerStatus,
  verifyBackup,
} from './backup/index.js';
import {
  CLOUD_PROVIDERS,
  CloudError,
  completeConnectFromApp,
  deleteRemoteBackup,
  disconnectCloud,
  getConnectResult,
  handleCloudCallback,
  importRemoteBackup,
  providerAvailability,
  remoteBackupViews,
  startConnect,
  statusWithQuota,
  syncNow,
  testCloudConnection,
  cloudProgress,
  cloudStatusPayload,
} from './cloud/index.js';

export interface BackupRouteDeps {
  asyncRoute: (handler: (req: Request, res: Response, next: () => void) => unknown) => RequestHandler;
  jsonError: (res: Response, status: number, message: string) => void;
  requireAdmin: unknown[];
}

/** Backup/cloud failures become the right status code + an owner-readable line. */
function sendFailure(error: unknown, res: Response, deps: BackupRouteDeps): void {
  if (error instanceof BackupError) return deps.jsonError(res, error.status || 400, error.message);
  if (error instanceof CloudError) {
    const status =
      Number(error.status) ||
      (error.kind === 'quota'
        ? 507
        : error.kind === 'offline' || error.kind === 'network'
          ? 503
          : error.kind === 'auth' || error.kind === 'consent' || error.kind === 'permission'
            ? 401
            : error.kind === 'config' || error.kind === 'unsupported'
              ? 400
              : error.kind === 'not-found'
                ? 404
                : error.kind === 'corrupt'
                  ? 422
                  : 502);
    return deps.jsonError(res, status, error.message);
  }
  const message = String((error as Error)?.message || error || '');
  // A stack trace or an address in a message means an internal error leaked out;
  // the owner gets the honest summary and the detail stays in the log.
  if (!message || /at 0x|\n\s+at\s|\[object /i.test(message)) {
    console.warn('[backup] unexpected failure:', error);
    return deps.jsonError(res, 500, 'The backup could not be completed. The problem was logged and the app keeps running.');
  }
  deps.jsonError(res, 500, message);
}

/** Real 24-hour clock time, not just two digit groups: 99:99 is not a schedule. */
function isClockTime(value: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function isProviderId(value: unknown): value is CloudProviderId {
  return (CLOUD_PROVIDERS as string[]).includes(String(value));
}

export function registerBackupRoutes(app: Express, deps: BackupRouteDeps): void {
  const guard = deps.requireAdmin as RequestHandler[];
  const admin = (handler: (req: Request, res: Response) => unknown): RequestHandler[] => [
    ...guard,
    deps.asyncRoute((req, res) => Promise.resolve(handler(req, res)).catch((error) => sendFailure(error, res, deps))),
  ];

  // ── overview + history ─────────────────────────────────────────────────────

  app.get(
    '/api/admin/backup/status',
    ...admin(async (_req, res) => {
      const config = loadBackupConfig();
      const dir = effectiveBackupDir(config);
      const entries = listBackups(dir, config);
      const verified = entries.filter((entry) => entry.verified && !entry.damaged && !entry.missing);
      const newest = verified[0] || null;
      const schedule = schedulerStatus();
      const cloud = await statusWithQuota().catch(() => cloudStatusPayload());
      const waitingForCloud = config.cloud
        ? verified.filter((entry) => !entry.cloud || entry.cloud.status === 'pending' || entry.cloud.status === 'failed' || entry.cloud.status === 'uploading').length
        : 0;
      const needsFirstRun = shouldPromptFirstRun(config, verified.length > 0);
      res.json({
        ok: true,
        config: publicBackupConfig(config),
        location: backupLocationInfo(config),
        storage: diskSpaceInfo(dir),
        credentials: credentialBackendInfo(),
        counts: {
          total: entries.length,
          verified: verified.length,
          damaged: entries.filter((entry) => entry.damaged).length,
          missing: entries.filter((entry) => entry.missing).length,
        },
        newest: newest
          ? {
              id: newest.id,
              file: newest.file,
              createdAt: newest.createdAt,
              trigger: newest.trigger,
              backupClass: newest.backupClass,
              bytes: newest.bytes,
              encrypted: newest.encrypted,
              recordCounts: newest.recordCounts,
              cloud: newest.cloud,
            }
          : null,
        // Age in hours decides "Protected" vs "Attention required" in the UI, so it
        // is computed from the file's own timestamp rather than trusted from a flag.
        ageHours: newest ? Math.max(0, Math.round((Date.now() - Date.parse(newest.createdAt)) / 36000) / 10) : null,
        schedule,
        cloud,
        uploads: cloudProgress(),
        waitingForCloud,
        needsFirstRunPrompt: needsFirstRun,
        needsAttention: verified.length === 0 || schedule.needsAttention,
      });
    }),
  );

  app.get(
    '/api/admin/backup/history',
    ...admin(async (_req, res) => {
      const config = loadBackupConfig();
      const entries = listBackups(effectiveBackupDir(config), config);
      res.json({
        restaurantId: config.restaurantId,
        backups: entries.map((entry) => ({
          id: entry.id,
          file: entry.file,
          folder: entry.file.includes('/') ? entry.file.split('/')[0] : 'manual',
          createdAt: entry.createdAt,
          trigger: entry.trigger,
          backupClass: entry.backupClass,
          bytes: entry.bytes,
          verified: entry.verified,
          missing: entry.missing,
          damaged: entry.damaged,
          encrypted: entry.encrypted,
          foreignRestaurant: entry.foreignRestaurant,
          imported: Boolean(entry.imported),
          safetyFor: entry.safetyFor || null,
          note: entry.note || '',
          recordCounts: entry.recordCounts,
          databaseProvider: entry.databaseProvider,
          verifiedAt: entry.verifiedAt,
          cloud: entry.cloud,
        })),
      });
    }),
  );

  app.get(
    '/api/admin/backup/config',
    ...admin(async (_req, res) => {
      res.json({ ok: true, config: publicBackupConfig(), location: backupLocationInfo(), credentialBackend: credentialBackendInfo() });
    }),
  );

  app.post(
    '/api/admin/backup/config',
    ...admin(async (req, res) => {
      const body = (req.body || {}) as {
        schedule?: { enabled?: boolean; dailyTime?: string };
        retention?: { daily?: number; weekly?: number; monthly?: number };
        localDir?: string | null;
        encryption?: { action?: 'set' | 'clear'; password?: string; currentPassword?: string | null };
      };
      const current = loadBackupConfig();
      const patch: Partial<BackupConfig> = {};

      if (body.schedule) {
        const requested = String(body.schedule.dailyTime ?? '').trim();
        if (requested && !isClockTime(requested)) {
          return deps.jsonError(res, 400, 'Enter the nightly backup time as 24-hour HH:MM, for example 23:30.');
        }
        patch.schedule = { ...current.schedule, enabled: Boolean(body.schedule.enabled), dailyTime: requested || current.schedule.dailyTime };
      }
      if (body.retention) {
        const clamp = (value: unknown, fallback: number, max: number) => {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? Math.max(0, Math.min(max, Math.round(parsed))) : fallback;
        };
        patch.retention = {
          ...current.retention,
          daily: clamp(body.retention.daily, current.retention.daily, 365),
          weekly: clamp(body.retention.weekly, current.retention.weekly, 104),
          monthly: clamp(body.retention.monthly, current.retention.monthly, 120),
        };
      }
      if (body.localDir !== undefined) {
        const value = typeof body.localDir === 'string' ? body.localDir.trim() : '';
        if (value) {
          // Only an existing absolute directory: a typo must not invent folders, and
          // a relative path must not point backups inside the installation folder.
          let stat: fs.Stats | null = null;
          try {
            stat = fs.statSync(path.resolve(value));
          } catch {
            stat = null;
          }
          if (!stat?.isDirectory()) {
            return deps.jsonError(res, 400, 'That backup folder does not exist yet. Create it (or choose it with the folder button) and try again.');
          }
        }
        patch.localDir = value || null;
      }

      let encryption: { encrypted: boolean; message: string; keyCached: boolean } | null = null;
      if (body.encryption?.action === 'set') {
        const password = String(body.encryption.password || '');
        if (password.length < 8) {
          return deps.jsonError(
            res,
            400,
            'Choose a backup password of at least 8 characters. It is the only thing between a stolen backup file and your sales data.',
          );
        }
        if (loadBackupConfig().encryption?.mode === 'password') {
          // Rotating must re-wrap the existing key: a fresh key would strand every
          // backup already on disk and in the cloud.
          const rotated = changeBackupPassword(String(body.encryption.currentPassword || ''), password);
          encryption = { encrypted: true, message: rotated.message, keyCached: rotated.cached };
        } else {
          const created = enableBackupEncryption(password);
          encryption = {
            encrypted: true,
            message: 'Backup encryption is on. Every new backup is written with AES-256-GCM, and copies can now go to your cloud storage.',
            keyCached: Boolean(created.cached),
          };
        }
      } else if (body.encryption?.action === 'clear') {
        const cleared = disableBackupPassword(body.encryption.currentPassword ?? null);
        encryption = { encrypted: false, message: cleared.message, keyCached: false };
      }

      if (Object.keys(patch).length) {
        updateBackupConfig((config) => ({ ...config, ...patch }));
        refreshBackupScheduler();
      }
      res.json({ ok: true, config: publicBackupConfig(), encryption, location: backupLocationInfo(), schedule: schedulerStatus() });
    }),
  );

  // ── the pipeline ────────────────────────────────────────────────────────────

  app.post(
    '/api/admin/backup/create',
    ...admin(async (req, res) => {
      const body = (req.body || {}) as { note?: string; password?: string | null };
      const { result, cloud } = await runNow({
        note: body.note ? String(body.note).slice(0, 200) : undefined,
        password: body.password ?? null,
      });
      if (result.record.verified) completeFirstRun();
      res.json({
        ok: true,
        record: result.record,
        header: result.header,
        durationMs: result.durationMs,
        encrypted: result.encrypted,
        cloud,
        message:
          cloud === 'queued'
            ? 'Backup created and verified here; the copy to your cloud storage has started.'
            : 'Backup created and verified on this computer.',
      });
    }),
  );

  app.post(
    '/api/admin/backup/upload',
    ...admin(async (req, res) => {
      const body = (req.body || {}) as { recordId?: string };
      const summary = await syncNow({ force: true, recordIds: body.recordId ? [String(body.recordId)] : undefined });
      res.json({ ok: true, ...summary, cloud: cloudStatusPayload() });
    }),
  );

  app.post(
    '/api/admin/backup/restore',
    ...admin(async (req, res) => {
      const body = (req.body || {}) as { recordId?: string; password?: string | null; acknowledgeForeignRestaurant?: boolean };
      const recordId = String(body.recordId || '');
      if (!recordId) return deps.jsonError(res, 400, 'Choose the backup you want to restore.');
      const result = await restoreBackup({
        recordId,
        password: body.password ?? null,
        acknowledgeForeignRestaurant: Boolean(body.acknowledgeForeignRestaurant),
      });
      completeFirstRun();
      res.json({ ok: true, ...result });
    }),
  );

  app.post(
    '/api/admin/backup/import',
    ...admin(async (req, res) => {
      const body = (req.body || {}) as { fileName?: string; contentBase64?: string; password?: string | null };
      const encoded = String(body.contentBase64 || '');
      if (!encoded) return deps.jsonError(res, 400, 'No backup file arrived. Choose the .rdbak file again.');
      // Ceiling before decoding: base64 of a 256 MB file is ~350 MB of text.
      if (encoded.length > Math.ceil((MAX_BACKUP_BYTES * 4) / 3) + 32) {
        return deps.jsonError(res, 413, 'That file is larger than the 256 MB limit for backup files.');
      }
      const buffer = Buffer.from(encoded.replace(/^data:[^,]+,/, ''), 'base64');
      if (!buffer.length) return deps.jsonError(res, 400, 'That file could not be read. Choose the backup file again.');
      const result = await importBackup(buffer, body.password ?? null);
      completeFirstRun();
      res.json({ ok: true, ...result, fileName: String(body.fileName || '').slice(0, 200) });
    }),
  );

  app.post(
    '/api/admin/backup/:id/verify',
    ...admin(async (req, res) => {
      const body = (req.body || {}) as { password?: string | null };
      res.json({ ok: true, ...verifyBackup(String(req.params.id), body.password ?? null) });
    }),
  );

  app.get(
    '/api/admin/backup/:id/export',
    ...admin(async (req, res) => {
      const payload = backupForExport(String(req.params.id));
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(payload.size));
      res.setHeader('Content-Disposition', `attachment; filename="${payload.fileName.split('/').pop()}"`);
      res.setHeader('Cache-Control', 'no-store');
      fs.createReadStream(payload.file).pipe(res);
    }),
  );

  app.post(
    '/api/admin/backup/:id/delete',
    ...admin(async (req, res) => {
      const result = deleteBackupRecord(String(req.params.id));
      res.json({ ok: Boolean(result.deleted), ...result, cloud: cloudStatusPayload() });
    }),
  );

  app.post(
    '/api/admin/backup/first-run',
    ...admin(async (req, res) => {
      const body = (req.body || {}) as { action?: 'dismiss' | 'complete' };
      if (body.action === 'complete') completeFirstRun();
      else dismissFirstRunPrompt();
      res.json({ ok: true, firstRun: publicBackupConfig().firstRun });
    }),
  );

  // ── cloud ──────────────────────────────────────────────────────────────────

  app.get(
    '/api/admin/cloud/providers',
    ...admin(async (_req, res) => {
      res.json({ ok: true, providers: providerAvailability() });
    }),
  );

  app.get(
    '/api/admin/cloud/status',
    ...admin(async (_req, res) => {
      res.json({ ok: true, cloud: await statusWithQuota({ refresh: true }), uploads: cloudProgress() });
    }),
  );

  app.post(
    '/api/admin/cloud/:provider/connect',
    ...admin(async (req, res) => {
      const provider = String(req.params.provider);
      if (!isProviderId(provider)) return deps.jsonError(res, 400, 'That cloud storage provider is not supported.');
      const body = (req.body || {}) as { redirectUri?: string; deviceCode?: boolean };
      let redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri.trim() : '';
      if (redirectUri) {
        // No open redirect: the only address this app will register is its own
        // callback endpoint on the host the owner is actually using.
        let parsed: URL | null = null;
        try {
          parsed = new URL(redirectUri);
        } catch {
          parsed = null;
        }
        if (!parsed || !/^https?:$/.test(parsed.protocol) || !parsed.pathname.endsWith('/api/cloud/callback')) {
          return deps.jsonError(res, 400, 'The return address must be this app’s own /api/cloud/callback address.');
        }
        redirectUri = `${parsed.origin}${parsed.pathname}`;
      } else {
        redirectUri = `${req.protocol}://${req.get('host')}/api/cloud/callback`;
      }
      const begun = await startConnect(provider, redirectUri, { deviceCode: Boolean(body.deviceCode) });
      res.json({ ok: true, ...begun });
    }),
  );

  /**
   * Where the provider sends the browser back to. Public, because a browser
   * landing here has no admin token — and protected by the single-use state the
   * provider echoes back, which is what makes this unusable for CSRF, for replay,
   * and for a second time in general. The code is spent here, once, and no token
   * ever appears in a URL or in this page.
   */
  app.get(
    '/api/cloud/callback',
    deps.asyncRoute(async (req, res) => {
      const state = String(req.query.state || '');
      const code = String(req.query.code || '');
      const error = String(req.query.error || '');
      // Two different jobs: the provider's own `error` token is untrusted input, so
      // it is filtered to a short plain slug. Sentences this app wrote (including the
      // provider's message text) only need HTML escaping, not mutilation.
      const slug = (value: string) => value.replace(/[^a-zA-Z0-9_\- ]/g, ' ').slice(0, 40);
      const html = (value: string) =>
        value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      // The exchange is done before the page is rendered, so the tab says what
      // actually happened instead of promising something the server has not done.
      // Nothing the provider puts in the URL is echoed beyond that escaping.
      let outcome = { ok: false, message: 'Nothing was connected. Open the restaurant app and start the connection again.' };
      if (error) {
        outcome = {
          ok: false,
          message: `The cloud sign-in was cancelled or refused (${slug(error)}). Nothing was connected and no data left this computer.`,
        };
      } else if (code && state) {
        try {
          const result = await handleCloudCallback({ code, state });
          outcome = {
            ok: result.ok,
            message: result.ok
              ? `${result.message} You can close this tab and return to the restaurant app.`
              : `${result.message} You can close this tab.`,
          };
        } catch (callbackError) {
          outcome = {
            ok: false,
            message: `The connection could not be finished: ${(callbackError as Error)?.message || 'unknown reason'}. Nothing was changed on this computer.`,
          };
        }
      } else {
        outcome = { ok: false, message: 'This link is missing the sign-in details it needs, so nothing was connected. Start the connection again from the app.' };
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const heading = outcome.ok ? 'Cloud storage connected' : 'Not connected';
      const note = `${outcome.message} You can close this tab.`.replace(/ You can close this tab\. You can close this tab\./g, ' You can close this tab.');
      res
        .status(200)
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
            `<meta name="viewport" content="width=device-width,initial-scale=1">` +
            `<title>${html(heading)}</title>` +
            `<style>body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:48px 20px;background:#0b0d10;color:#e8eaed;display:flex;align-items:center;justify-content:center;min-height:100vh}` +
            `main{max-width:34rem}h1{font-size:1.2rem;margin:0 0 10px}p{margin:0;color:#a8b0ba;overflow-wrap:anywhere}</style></head>` +
            `<body><main><h1>${html(heading)}</h1><p>${html(note)}</p></main></body></html>`,
        );
    }),
  );

  app.get(
    '/api/admin/cloud/connect-result',
    ...admin(async (req, res) => {
      const result = getConnectResult(String(req.query.state || ''));
      if (!result) return res.json({ ok: true, state: 'expired' });
      res.json({ ok: result.state === 'connected', ...result });
    }),
  );

  app.post(
    '/api/admin/cloud/:provider/callback',
    ...admin(async (req, res) => {
      const provider = String(req.params.provider);
      if (!isProviderId(provider)) return deps.jsonError(res, 400, 'That cloud storage provider is not supported.');
      const body = (req.body || {}) as { code?: string; state?: string };
      if (!body.code || !body.state) return deps.jsonError(res, 400, 'The sign-in did not return a code. Start the connection again.');
      const result = await completeConnectFromApp(provider, String(body.code), String(body.state));
      completeFirstRun();
      res.json({ ok: true, ...result });
    }),
  );

  app.post(
    '/api/admin/cloud/disconnect',
    ...admin(async (req, res) => {
      // No body options on purpose: disconnecting never removes anything from the
      // customer's own cloud folder.
      const result = await disconnectCloud();
      res.json({ ok: true, ...result, cloud: cloudStatusPayload() });
    }),
  );

  app.post(
    '/api/admin/cloud/test',
    ...admin(async (_req, res) => {
      const result = await testCloudConnection();
      res.json({ ok: result.ok, ...result, cloud: cloudStatusPayload() });
    }),
  );

  app.get(
    '/api/admin/cloud/remote',
    ...admin(async (_req, res) => {
      const files = await remoteBackupViews();
      res.json({ ok: true, files, cloud: cloudStatusPayload() });
    }),
  );

  app.post(
    '/api/admin/cloud/remote/import',
    ...admin(async (req, res) => {
      const body = (req.body || {}) as { remoteId?: string; password?: string | null };
      if (!body.remoteId) return deps.jsonError(res, 400, 'Choose the cloud file to bring back.');
      const result = await importRemoteBackup(String(body.remoteId), body.password ?? null);
      completeFirstRun();
      res.json({ ok: true, ...result });
    }),
  );

  app.post(
    '/api/admin/cloud/remote/delete',
    ...admin(async (req, res) => {
      const body = (req.body || {}) as { remoteId?: string; confirmLastCopy?: boolean };
      if (!body.remoteId) return deps.jsonError(res, 400, 'Choose the cloud file to delete.');
      const result = await deleteRemoteBackup(String(body.remoteId), { confirmLastCopy: Boolean(body.confirmLastCopy) });
      res.json({ ok: Boolean(result.deleted), ...result, cloud: cloudStatusPayload() });
    }),
  );
}
