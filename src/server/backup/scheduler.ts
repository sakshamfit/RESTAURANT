/**
 * Automatic backups: one daily run at a time the owner chooses, plus a catch-up
 * when the app was off at that hour (restaurants close, power cuts, Friday
 * rushes). The scheduler never blocks, delays or interrupts the till: everything
 * it does happens after a short idle delay, in the background, and a failure is
 * recorded rather than surfaced to the person taking an order.
 *
 * Cloud copying is a stage of the same run (see ../cloud/sync.ts), so a nightly
 * backup that succeeds locally but finds Dropbox down ends up "pending", not
 * "failed" — and the POS never learns about it.
 */
import { DEFAULT_DAILY_TIME, effectiveBackupDir, loadBackupConfig, updateBackupConfig, type BackupScheduleConfig, type BackupTrigger } from '../backupConfig.js';
import { BACKUP_PHASE_LABELS as PHASE_LABELS, createBackup, type BackupPhase, type CreateBackupResult } from './service.js';
import { listBackups } from './manifest.js';

const STARTUP_DELAY_MS = 45_000;
const CLOUD_RETRY_INTERVAL_MS = 5 * 60_000;

export interface SchedulerProgress {
  running: boolean;
  phase: BackupPhase | null;
  phaseLabel: string | null;
  startedAt: string | null;
  recordId: string | null;
  /** Cloud stage, kept here so the UI has one object to poll. */
  cloud: { state: string; detail: string | null } | null;
}

export interface SchedulerStatus extends SchedulerProgress {
  enabled: boolean;
  dailyTime: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTrigger: string | null;
  lastOutcome: 'success' | 'failure' | null;
  lastError: string | null;
  consecutiveFailures: number;
  catchupDue: boolean;
  /** True when automatic backups have never succeeded — first-run prompt logic. */
  hasVerifiedBackup: boolean;
  needsAttention: boolean;
  attentionMessage: string | null;
}

let timer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let running = false;
let progress: SchedulerProgress = { running: false, phase: null, phaseLabel: null, startedAt: null, recordId: null, cloud: null };
let started = false;

function unref(handle: NodeJS.Timeout | null): void {
  if (handle && typeof (handle as unknown as { unref?: () => void }).unref === 'function') {
    (handle as unknown as { unref: () => void }).unref();
  }
}

export function parseDailyTime(value: string | null | undefined): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || DEFAULT_DAILY_TIME).trim());
  if (!match) return { hour: 2, minute: 30 };
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return { hour, minute };
}

/** Next scheduled moment, in the app's local time, strictly after `from`. */
export function nextRunAt(schedule: BackupScheduleConfig, from = new Date()): Date {
  const { hour, minute } = parseDailyTime(schedule.dailyTime);
  const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hour, minute, 0, 0);
  if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

/**
 * A run is owed when the scheduled time for today has passed and nothing has run
 * at or after it — including the very first day, and including a machine that was
 * switched off for a week (which gets exactly one catch-up, not seven).
 */
export function isCatchupDue(schedule: BackupScheduleConfig, now = new Date()): boolean {
  if (!schedule.enabled) return false;
  const { hour, minute } = parseDailyTime(schedule.dailyTime);
  const dueToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (now.getTime() < dueToday.getTime()) return false;
  if (!schedule.lastDailyRunAt) return true;
  const last = new Date(schedule.lastDailyRunAt);
  return last.getTime() < dueToday.getTime();
}

function armDailyTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const schedule = loadBackupConfig().schedule;
  if (!schedule.enabled) return;
  const delay = Math.min(Math.max(nextRunAt(schedule).getTime() - Date.now(), 1000), 24 * 60 * 60 * 1000);
  timer = setTimeout(() => {
    void runScheduled('daily').finally(() => armDailyTimer());
  }, delay);
  unref(timer);
}

function setPhase(phase: BackupPhase | null): void {
  progress = { ...progress, phase, phaseLabel: phase ? PHASE_LABELS[phase] : null };
}

async function recordOutcome(trigger: BackupTrigger, error: unknown): Promise<void> {
  const failed = Boolean(error);
  updateBackupConfig((current) => ({
    ...current,
    schedule: {
      ...current.schedule,
      lastRunAt: new Date().toISOString(),
      lastTrigger: trigger,
      lastOutcome: failed ? 'failure' : 'success',
      lastError: failed ? ownerMessage(error) : null,
      consecutiveFailures: failed ? current.schedule.consecutiveFailures + 1 : 0,
      ...(trigger === 'daily' || trigger === 'startup-catchup' ? { lastDailyRunAt: new Date().toISOString() } : {}),
    },
  }));
}

/** BackupError/CloudError messages are written for owners; anything else is not. */
function ownerMessage(error: unknown): string {
  const message = String((error as Error)?.message || error || 'The backup failed.');
  if (/at 0x|\[object |\n\s+at\s/.test(message)) return 'The automatic backup failed for a reason this app could not describe. Open Backup Center for details.';
  return message;
}

export async function runScheduled(trigger: 'daily' | 'startup-catchup'): Promise<CreateBackupResult | null> {
  if (running) return null;
  running = true;
  progress = { running: true, phase: null, phaseLabel: null, startedAt: new Date().toISOString(), recordId: null, cloud: null };
  let result: CreateBackupResult | null = null;
  let failure: unknown = null;
  try {
    setPhase('snapshot');
    result = await createBackup({
      trigger,
      note: trigger === 'startup-catchup' ? 'Automatic backup (catch-up after the app was closed)' : 'Automatic nightly backup',
      onPhase: (phase) => setPhase(phase),
    });
    setPhase(null);
    progress = { ...progress, recordId: result.record.id };
    await copyToCloud(result);
  } catch (error) {
    failure = error;
    // Local backups must never crash a server because a disk is full at 02:30.
    console.warn('[backup] automatic backup failed:', ownerMessage(error));
  } finally {
    running = false;
    progress = { running: false, phase: null, phaseLabel: null, startedAt: null, recordId: null, cloud: null };
    await recordOutcome(trigger, failure);
  }
  return result;
}

/**
 * Cloud stage of a scheduled run. The import is lazy on purpose: if the cloud
 * modules fail to load on somebody's machine, the local backup above has already
 * happened and the nightly job still counts as a success.
 */
async function copyToCloud(result: CreateBackupResult): Promise<void> {
  const config = loadBackupConfig();
  if (!config.cloud) return;
  setPhase(null);
  progress = { ...progress, cloud: { state: 'uploading', detail: null } };
  try {
    const { syncNow } = await import('../cloud/sync.js');
    const summary = await syncNow({ recordIds: [result.record.id] });
    const first = summary.results[0];
    progress = { ...progress, cloud: { state: first?.outcome || 'pending', detail: first?.detail || summary.reason || null } };
  } catch (error) {
    progress = { ...progress, cloud: { state: 'pending', detail: ownerMessage(error) } };
  }
}

/** Manual run from the UI: local backup is awaited, the cloud copy continues after. */
export async function runNow(input: { trigger?: 'manual'; note?: string; password?: string | null } = {}): Promise<{ result: CreateBackupResult; cloud: 'queued' | 'skipped' }> {
  if (running) throw new Error('A backup is already running. Please wait for it to finish.');
  running = true;
  progress = { running: true, phase: null, phaseLabel: null, startedAt: new Date().toISOString(), recordId: null, cloud: null };
  try {
    const result = await createBackup({
      trigger: 'manual',
      note: input.note,
      password: input.password,
      onPhase: (phase) => setPhase(phase),
    });
    progress = { ...progress, recordId: result.record.id };
    const config = loadBackupConfig();
    if (config.cloud) {
      // Not awaited: a 500 MB upload on a restaurant line must not hold a request
      // open. The Backup Center shows the progress, and it is recorded on the file.
      void import('../cloud/sync.js')
        .then(({ syncNow }) => syncNow({ force: true, recordIds: [result.record.id] }))
        .catch(() => undefined);
      return { result, cloud: 'queued' };
    }
    return { result, cloud: 'skipped' };
  } finally {
    running = false;
    progress = { running: false, phase: null, phaseLabel: null, startedAt: null, recordId: null, cloud: null };
  }
}

/** Called at boot (and after config changes): timers, catch-up, cloud retries. */
export function startBackupScheduler(): void {
  const config = loadBackupConfig();
  if (started) {
    armDailyTimer();
    return;
  }
  started = true;
  armDailyTimer();

  (async () => {
    const schedule = loadBackupConfig().schedule;
    if (!isCatchupDue(schedule)) return;
    await new Promise((resolve) => {
      startupTimer = setTimeout(resolve, STARTUP_DELAY_MS);
      unref(startupTimer);
    });
    if (!isCatchupDue(loadBackupConfig().schedule)) return;
    await runScheduled('startup-catchup');
  })().catch(() => undefined);

  const pollCloud = () => {
    const current = loadBackupConfig();
    if (!current.cloud) return;
    void import('../cloud/sync.js')
      .then(({ syncNow }) => syncNow())
      .then(async (summary) => {
        if (summary.verified || summary.uploaded) return;
        const { recoverInterruptedUploads } = await import('../cloud/manager.js');
        recoverInterruptedUploads();
      })
      .catch(() => undefined);
  };
  retryTimer = setInterval(pollCloud, CLOUD_RETRY_INTERVAL_MS);
  unref(retryTimer);
  void import('../cloud/manager.js')
    .then(({ recoverInterruptedUploads }) => {
      recoverInterruptedUploads();
    })
    .catch(() => undefined);
}

export function stopBackupScheduler(): void {
  if (timer) clearTimeout(timer);
  if (retryTimer) clearInterval(retryTimer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  retryTimer = null;
  startupTimer = null;
  started = false;
  running = false;
}

/** Re-arm after the owner changes the time or the on/off switch. */
export function refreshBackupScheduler(): void {
  if (!started) return;
  armDailyTimer();
}

export function schedulerStatus(): SchedulerStatus {
  const config = loadBackupConfig();
  const schedule = config.schedule;
  const verified = listBackups(effectiveBackupDir(config), config).filter((entry) => entry.verified && !entry.damaged && !entry.missing);
  const next = schedule.enabled ? nextRunAt(schedule) : null;
  const needsAttention = schedule.consecutiveFailures >= 3 || (schedule.lastOutcome === 'failure' && schedule.consecutiveFailures >= 1);
  return {
    ...progress,
    enabled: schedule.enabled,
    dailyTime: schedule.dailyTime || DEFAULT_DAILY_TIME,
    nextRunAt: next ? next.toISOString() : null,
    lastRunAt: schedule.lastRunAt,
    lastTrigger: schedule.lastTrigger,
    lastOutcome: schedule.lastOutcome,
    lastError: schedule.lastError,
    consecutiveFailures: schedule.consecutiveFailures,
    catchupDue: isCatchupDue(schedule),
    hasVerifiedBackup: verified.length > 0,
    needsAttention,
    attentionMessage: needsAttention
      ? `Automatic backups have failed ${schedule.consecutiveFailures} time${schedule.consecutiveFailures === 1 ? '' : 's'} in a row. Last attempt said: ${schedule.lastError || 'no reason was recorded.'}`
      : null,
  };
}

/** Used by the health endpoint and tests. */
export function schedulerRunning(): boolean {
  return running;
}
