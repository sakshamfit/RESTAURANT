import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Clock,
  Cloud,
  CloudOff,
  Database,
  Download,
  ExternalLink,
  FileCheck2,
  FolderOpen,
  HardDrive,
  KeyRound,
  Link2,
  Link2Off,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
  Archive,
} from 'lucide-react';
import { api } from '../services/api';
import type {
  BackupHistoryEntry,
  BackupStatusResponse,
  CloudConnectBegin,
  CloudConnectOutcome,
  CloudProviderId,
  CloudProviderOption,
  CloudStatusInfo,
  RemoteBackupFile,
} from '../types';

/**
 * Backup Center — the owner's view of local + customer-owned-cloud backups.
 *
 * Nothing here is decorative: every control calls the endpoint that really does
 * the job, and the wording only ever claims what the server confirmed. The
 * server is the one that decides a backup is "verified" (it re-reads the file it
 * wrote and re-checksums it) and "protected" (it re-reads the customer's own
 * cloud folder after an upload). This component reports those answers.
 *
 * The design system is the rest of the admin area's: white cards on the stone
 * canvas, amber for the primary action, Lucide icons, inline alert boxes instead
 * of toasts. Status is always icon + words, never colour alone.
 */

type Section = 'overview' | 'history' | 'cloud' | 'recovery' | 'automatic';

const SECTIONS: Array<{ id: Section; label: string; icon: typeof ShieldCheck }> = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'history', label: 'Backup History', icon: Clock },
  { id: 'cloud', label: 'Cloud Storage', icon: Cloud },
  { id: 'recovery', label: 'Recovery', icon: RotateCcw },
  { id: 'automatic', label: 'Automatic', icon: ShieldCheck },
];

type Tone = 'ok' | 'warn' | 'error' | 'idle';

interface BannerState {
  key: 'protected' | 'attention' | 'pending' | 'uploading' | 'failed' | 'disconnected' | 'none';
  label: string;
  message: string;
  icon: typeof ShieldCheck;
  spin?: boolean;
  tone: Tone;
}

const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  warn: 'bg-amber-50 border-amber-200 text-amber-900',
  error: 'bg-red-50 border-red-200 text-red-800',
  idle: 'bg-stone-50 border-stone-200 text-stone-700',
};

/**
 * One honest sentence about the whole system, derived from the server's state
 * rather than from "a button was clicked".
 */
function resolveBanner(status: BackupStatusResponse): BannerState {
  const cloud: CloudStatusInfo | null = status.cloud;
  const uploads = status.uploads || [];
  const hasVerified = status.counts.verified > 0;

  if (!hasVerified) {
    return {
      key: 'attention',
      label: 'No backup yet',
      message: 'This computer has no verified backup file yet. Create one now — it takes a few seconds and stays on this machine.',
      icon: ShieldAlert,
      tone: 'error',
    };
  }
  if (uploads.length > 0) {
    const first = uploads[0];
    const pct = first.totalBytes > 0 ? Math.min(99, Math.round((first.sentBytes / first.totalBytes) * 100)) : null;
    return {
      key: 'uploading',
      label: 'Uploading',
      message: `Sending ${uploads.length === 1 ? 'your backup' : `${uploads.length} backups`} to ${cloud?.label || 'your cloud storage'}${pct === null ? '…' : ` — ${pct}%${first.resumed ? ' (resumed where it stopped)' : ''}.`}`,
      icon: Cloud,
      spin: true,
      tone: 'idle',
    };
  }
  if (status.schedule?.running) {
    return {
      key: 'uploading',
      label: 'Backup in progress',
      message: status.schedule.phaseLabel || 'Reading, validating and compressing your data…',
      icon: Loader2,
      spin: true,
      tone: 'idle',
    };
  }
  switch (cloud?.state) {
    case 'protected':
      return {
        key: 'protected',
        label: 'Protected',
        message: `Your newest backup is verified here and confirmed in your own ${cloud.label} folder. That is the state you want.`,
        icon: ShieldCheck,
        tone: 'ok',
      };
    case 'pending':
      return {
        key: 'pending',
        label: 'Backup pending',
        message: cloud.headline,
        icon: Clock,
        tone: 'warn',
      };
    case 'uploading':
      return { key: 'uploading', label: 'Uploading', message: cloud.headline, icon: Cloud, spin: true, tone: 'idle' };
    case 'failed':
      return { key: 'failed', label: 'Backup failed', message: cloud.headline, icon: AlertTriangle, tone: 'error' };
    case 'attention':
      return { key: 'attention', label: 'Attention required', message: cloud.headline, icon: ShieldAlert, tone: 'error' };
    case 'disconnected':
      return {
        key: 'disconnected',
        label: 'Cloud disconnected',
        message: 'Backups are safe on this computer, but nothing is stored off-site yet. Connect your own Google Drive, OneDrive or Dropbox folder and the app will copy verified backups there.',
        icon: CloudOff,
        tone: 'warn',
      };
    default:
      return {
        key: 'none',
        label: 'Verified locally',
        message: 'Your latest backup is verified on this computer.',
        icon: CheckCircle2,
        tone: 'idle',
      };
  }
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '—';
  const abs = new Date(at).toLocaleString();
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return `just now · ${abs}`;
  if (minutes < 60) return `${minutes} min ago · ${abs}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago · ${abs}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago · ${abs}`;
}

function formatFuture(iso: string | null | undefined): string {
  if (!iso) return '—';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '—';
  const minutes = Math.round((at - Date.now()) / 60000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

const CLOUD_STATUS_TEXT: Record<string, string> = {
  pending: 'Waiting to be sent',
  uploading: 'Uploading',
  uploaded: 'Sent, not confirmed yet',
  verified: 'Confirmed in your cloud folder',
  failed: 'Needs attention',
};

const TRIGGER_TEXT: Record<string, string> = {
  manual: 'You created it',
  daily: 'Automatic (nightly)',
  'startup-catchup': 'Automatic (missed run)',
  'pre-restore': 'Safety copy before a restore',
  initial: 'First backup',
};

/** Small shared shell so every card in this screen looks the same. */
const Card: React.FC<{ title: string; subtitle?: string; icon?: typeof ShieldCheck; action?: React.ReactNode; children: React.ReactNode; tone?: Tone }> = ({
  title,
  subtitle,
  icon: Icon,
  action,
  children,
}) => (
  <section className="bg-white rounded-3xl p-5 sm:p-6 border border-stone-200 shadow-xs space-y-4">
    <header className="flex items-start justify-between gap-3 border-b border-stone-100 pb-3">
      <div>
        <h3 className="font-bold text-base text-stone-900 flex items-center gap-2">
          {Icon ? <Icon className="w-5 h-5 text-amber-700" /> : null}
          <span>{title}</span>
        </h3>
        {subtitle ? <p className="text-xs text-stone-500 mt-0.5">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
    {children}
  </section>
);

const InlineAlert: React.FC<{ tone: Tone; children: React.ReactNode; icon?: typeof ShieldCheck }> = ({ tone, children, icon: Icon }) => (
  <div className={`p-3 rounded-xl border text-xs font-semibold flex items-start gap-2 ${TONE_CLASS[tone]}`}>
    {Icon ? <Icon className="w-4 h-4 mt-0.5 shrink-0" /> : null}
    <div className="min-w-0 flex-1 space-y-2 overflow-wrap-anywhere">{children}</div>
  </div>
);

const Button: React.FC<{
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  icon?: typeof ShieldCheck;
  type?: 'button' | 'submit';
}> = ({ children, onClick, disabled, busy, variant = 'secondary', icon: Icon, type = 'button' }) => {
  const palette =
    variant === 'primary'
      ? 'bg-amber-600 hover:bg-amber-700 disabled:bg-stone-300 text-white'
      : variant === 'danger'
        ? 'bg-white hover:bg-red-50 disabled:bg-stone-100 text-red-700 border border-red-200'
        : 'bg-white hover:bg-stone-50 disabled:bg-stone-100 text-stone-700 border border-stone-200';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className={`py-2 px-3.5 rounded-xl font-bold text-xs flex items-center gap-1.5 shadow-xs transition-colors disabled:cursor-not-allowed ${palette}`}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : Icon ? <Icon className="w-4 h-4" /> : null}
      <span>{children}</span>
    </button>
  );
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className="block">
    <span className="block text-xs font-bold text-stone-700 mb-1">{label}</span>
    {children}
    {hint ? <span className="block text-[11px] text-stone-500 mt-1">{hint}</span> : null}
  </label>
);

const inputClass =
  'w-full px-3 py-2 rounded-xl border border-stone-200 bg-white text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500';

export const AdminBackup: React.FC<{ onRefresh?: () => void }> = ({ onRefresh }) => {
  const [section, setSection] = useState<Section>('overview');
  const [status, setStatus] = useState<BackupStatusResponse | null>(null);
  const [history, setHistory] = useState<BackupHistoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Backup now
  const [note, setNote] = useState('');
  const [password, setPassword] = useState('');

  // Cloud
  const [providers, setProviders] = useState<CloudProviderOption[] | null>(null);
  const [remoteFiles, setRemoteFiles] = useState<RemoteBackupFile[] | null>(null);
  const [connect, setConnect] = useState<{ begin: CloudConnectBegin; outcome: CloudConnectOutcome | null } | null>(null);

  // Recovery
  const [restoreTarget, setRestoreTarget] = useState<BackupHistoryEntry | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPassword, setImportPassword] = useState('');
  const [fileInputKey, setFileInputKey] = useState(0);

  // Settings (automatic)
  const [enabled, setEnabled] = useState(true);
  const [dailyTime, setDailyTime] = useState('02:30');
  const [retention, setRetention] = useState({ daily: 14, weekly: 12, monthly: 12 });
  const [localDir, setLocalDir] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextHistory] = await Promise.all([api.adminBackupStatus(), api.adminBackupHistory()]);
      setStatus(nextStatus);
      setHistory(nextHistory.backups);
      setLoadError(null);
      return nextStatus;
    } catch (error: any) {
      setLoadError(error?.message || 'Backup status could not be read.');
      return null;
    }
  }, []);

  // Config fields are seeded from the server once, then only overwritten when the
  // owner is not typing in them — otherwise a background refresh would eat keystrokes.
  const settingsDirty = useRef(false);
  const applyConfigToForm = useCallback((response: BackupStatusResponse | null) => {
    if (!response || settingsDirty.current) return;
    setEnabled(response.config.schedule.enabled);
    setDailyTime(response.config.schedule.dailyTime || '02:30');
    setRetention({ ...response.config.retention });
    setLocalDir(response.config.localDir || '');
  }, []);

  useEffect(() => {
    void refresh().then(applyConfigToForm);
  }, [refresh, applyConfigToForm]);

  // Live progress while a backup or an upload is running; a calm poll otherwise.
  useEffect(() => {
    const active = Boolean(status?.schedule?.running) || (status?.uploads?.length || 0) > 0;
    const id = window.setInterval(() => void refresh(), active ? 1200 : 20000);
    return () => window.clearInterval(id);
  }, [status?.schedule?.running, status?.uploads?.length, refresh]);

  // Cloud tab data on demand (a provider list never changes on its own).
  const loadCloud = useCallback(async () => {
    try {
      const [list, remote] = await Promise.all([
        api.adminCloudProviders(),
        status?.cloud?.state && status.cloud.state !== 'disconnected' ? api.adminCloudRemote() : Promise.resolve({ files: [] as RemoteBackupFile[] }),
      ]);
      setProviders(list.providers);
      setRemoteFiles(remote.files);
    } catch (error: any) {
      setProviders(null);
      setRemoteFiles(null);
      setMessage({ tone: 'error', text: error?.message || 'Your cloud storage could not be read.' });
    }
  }, [status?.cloud?.state]);

  useEffect(() => {
    if (section === 'cloud') void loadCloud();
  }, [section, loadCloud]);

  // Poll the sign-in result after the owner returns from the provider's page.
  useEffect(() => {
    if (!connect || connect.outcome?.state === 'connected' || connect.outcome?.state === 'failed' || connect.outcome?.state === 'expired') return;
    let stopped = false;
    const tick = async () => {
      try {
        const outcome = await api.adminCloudConnectResult(connect.begin.state);
        if (stopped) return;
        setConnect((current) => (current ? { ...current, outcome } : current));
        if (outcome.state === 'connected') {
          await refresh();
          await loadCloud();
        }
      } catch {
        /* the tab just keeps waiting; the callback page already told the owner what happened */
      }
    };
    const id = window.setInterval(tick, 2000);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [connect?.begin.state, connect?.outcome?.state, refresh, loadCloud]);

  /** Runs one owner action, then re-reads the truth from the server. */
  const run = useCallback(
    async (key: string, fn: () => Promise<{ message?: string | null; tone?: Tone } | void>) => {
      setBusy(key);
      setMessage(null);
      try {
        const outcome = (await fn()) as { message?: string | null; tone?: Tone } | undefined;
        if (outcome?.message) setMessage({ tone: outcome.tone || 'ok', text: outcome.message });
        await refresh();
        if (section === 'cloud') await loadCloud();
        onRefresh?.();
      } catch (error: any) {
        setMessage({ tone: 'error', text: error?.message || 'That did not work. Nothing was deleted.' });
      } finally {
        setBusy(null);
      }
    },
    [refresh, loadCloud, section, onRefresh],
  );

  const banner = useMemo(() => (status ? resolveBanner(status) : null), [status]);
  const desktop = typeof window !== 'undefined' && Boolean((window as any).nagoriDesktop?.isDesktop);
  const encryptionOn = status?.config?.encryption?.mode === 'password';

  if (!status) {
    return (
      <div className="space-y-4 max-w-5xl mx-auto">
        <Card title="Backup & Recovery" subtitle="Loading this machine's backup state" icon={ShieldCheck}>
          <div className="flex items-center gap-2 text-xs font-semibold text-stone-500 py-6">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Reading the backup folder…</span>
          </div>
          {loadError ? <InlineAlert tone="error" icon={AlertTriangle}>{loadError}</InlineAlert> : null}
        </Card>
      </div>
    );
  }

  const cloud = status.cloud;
  const nextRun = status.schedule;

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      {/* ── the single honest status line ── */}
      {banner ? (
        <div className={`rounded-3xl border p-5 sm:p-6 shadow-xs flex flex-wrap items-start gap-4 ${TONE_CLASS[banner.tone]}`}>
          <div className="flex items-center gap-3 min-w-[15rem] flex-1">
            <banner.icon className={`w-7 h-7 shrink-0 ${banner.spin ? 'animate-spin' : ''}`} />
            <div className="min-w-0">
              <p className="text-sm font-black uppercase tracking-wide">{banner.label}</p>
              <p className="text-xs font-semibold opacity-90 mt-0.5">{banner.message}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={Database} busy={busy === 'create'} onClick={() => void run('create', async () => {
              const result = await api.adminBackupCreate({ note: note.trim() || undefined, password: password || null });
              setPassword('');
              setNote('');
              return {
                tone: 'ok',
                message: result.cloud === 'queued' ? result.message : `Backup complete — ${result.record.file.split('/').pop()} verified on this computer (${formatBytes(result.record.bytes)}).`,
              };
            })}>
              Back up now
            </Button>
            {cloud?.action ? (
              <Button
                icon={cloud.action.kind === 'retry' ? RefreshCw : Link2}
                busy={busy === 'cloud-action'}
                onClick={() =>
                  void run('cloud-action', async () => {
                    if (cloud.action?.kind === 'retry') {
                      const summary = await api.adminBackupUpload();
                      return {
                        tone: summary.failed > 0 ? 'warn' : 'ok',
                        message:
                          summary.verified > 0
                            ? `${summary.verified} backup ${summary.verified === 1 ? 'copy is' : 'copies are'} confirmed in your cloud folder.`
                            : summary.reason || summary.results[0]?.detail || 'Still waiting for your cloud storage — your local backup is safe.',
                      };
                    }
                    setSection('cloud');
                    return { tone: 'idle', message: cloud.action.kind === 'encryption' ? 'Turn on encryption below first — the app will not upload an unprotected copy of your sales data to any cloud.' : `Choose ${cloud.action.provider ? '' : 'your '}account and reconnect.` };
                  })
                }
              >
                {cloud.action.label}
              </Button>
            ) : null}
            {cloud?.state === 'uploading' ? null : (
              <Button icon={RefreshCw} busy={busy === 'refresh'} onClick={() => void run('refresh', async () => ({ tone: 'idle', message: null }))}>
                Re-check
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {/* ── section nav ── */}
      <nav className="flex flex-wrap gap-1.5">
        {SECTIONS.map((item) => {
          const Icon = item.icon;
          const isActive = section === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              className={`py-2 px-3 rounded-xl text-xs font-bold flex items-center gap-1.5 border transition-colors cursor-pointer ${
                isActive ? 'bg-stone-900 text-white border-stone-900' : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{item.label}</span>
              {item.id === 'history' && status.counts.total ? (
                <span className="ml-0.5 px-1.5 rounded-full bg-stone-100 text-stone-600 text-[10px] font-black">{status.counts.total}</span>
              ) : null}
              {item.id === 'cloud' && status.waitingForCloud > 0 ? (
                <span className="ml-0.5 px-1.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-black">{status.waitingForCloud}</span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {message ? (
        <InlineAlert tone={message.tone} icon={message.tone === 'error' ? AlertTriangle : CheckCircle2}>
          <span>{message.text}</span>
        </InlineAlert>
      ) : null}

      {loadError ? <InlineAlert tone="error" icon={AlertTriangle}>{loadError}</InlineAlert> : null}

      {section === 'overview' ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card title="Newest verified backup" icon={FileCheck2}>
              {status.newest ? (
                <dl className="grid grid-cols-2 gap-y-2 gap-x-3 text-xs">
                  <Field2 label="Taken">{formatWhen(status.newest.createdAt)}</Field2>
                  <Field2 label="Why">{TRIGGER_TEXT[status.newest.trigger] || status.newest.trigger}</Field2>
                  <Field2 label="Folder">{status.newest.file.split('/').pop()}</Field2>
                  <Field2 label="Class">{status.newest.backupClass}</Field2>
                  <Field2 label="Size">{formatBytes(status.newest.bytes)}</Field2>
                  <Field2 label="Encryption">{status.newest.encrypted ? 'AES-256-GCM' : 'Not encrypted'}</Field2>
                  <Field2 label="Rows stored">{Object.values(status.newest.recordCounts).reduce((sum: number, value: number) => sum + value, 0)}</Field2>
                  <Field2 label="Source">{status.newest.databaseProvider === 'postgres' ? 'PostgreSQL' : 'Local file'}</Field2>
                  <Field2 label="Cloud copy">
                    {status.newest.cloud ? `${CLOUD_STATUS_TEXT[status.newest.cloud.status] || status.newest.cloud.status}` : 'Local only'}
                  </Field2>
                  <Field2 label="Age">{status.ageHours === null ? '—' : `${status.ageHours} h`}</Field2>
                </dl>
              ) : (
                <p className="text-xs text-stone-500">No verified backup exists yet. Use “Back up now” above — nothing is claimed until the file has been read back and checked.</p>
              )}
            </Card>

            <Card title="Where copies live" icon={HardDrive} subtitle="This app never stores your backups on its own servers.">
              <div className="space-y-3 text-xs">
                <div className="p-3 rounded-xl bg-stone-50 border border-stone-200">
                  <p className="font-bold text-stone-800 flex items-center gap-1.5">
                    <FolderOpen className="w-4 h-4 text-stone-500" /> This computer
                  </p>
                  <p className="font-mono text-[11px] text-stone-600 mt-1 overflow-wrap-anywhere">{status.location.dir}</p>
                  <p className="mt-1 text-stone-600">
                    {status.counts.verified} verified · {status.counts.damaged} damaged · {status.counts.missing} missing
                    {status.storage?.freeBytes !== null && status.storage?.freeBytes !== undefined ? ` · ${formatBytes(status.storage.freeBytes)} free on this disk` : ''}
                  </p>
                  {status.location.writable === false ? (
                    <p className="mt-1 font-bold text-red-700">This folder cannot be written to — automatic backups will fail until that changes.</p>
                  ) : null}
                </div>
                <div className={`p-3 rounded-xl border ${cloud?.provider ? 'bg-emerald-50/60 border-emerald-200' : 'bg-stone-50 border-stone-200'}`}>
                  <p className="font-bold text-stone-800 flex items-center gap-1.5">
                    {cloud?.provider ? <Cloud className="w-4 h-4 text-emerald-700" /> : <CloudOff className="w-4 h-4 text-stone-400" />}
                    {cloud?.provider ? `${cloud.label} (your account)` : 'No cloud folder connected'}
                  </p>
                  {cloud?.provider ? (
                    <>
                      <p className="mt-1 text-stone-700">Account: {cloud.accountLabel || 'not shared by the provider'}</p>
                      <p className="text-stone-700">Folder: {cloud.folderLabel || cloud.folderPath}</p>
                      <p className="text-stone-700">
                        {cloud.uploadedCount} confirmed · {cloud.pendingCount} waiting · {cloud.failedCount} needing attention
                      </p>
                      {cloud.quota?.accountLabel ? <p className="text-stone-600 mt-1">{cloud.quota.accountLabel}</p> : null}
                      {cloud.quotaError ? <p className="text-stone-500 mt-1">Storage space could not be read right now: {cloud.quotaError}</p> : null}
                    </>
                  ) : (
                    <p className="mt-1 text-stone-600">
                      Your own Google Drive, OneDrive or Dropbox. Opening a connection asks the provider for permission to store files this app creates — it never
                      reads the rest of your account, and our servers never hold a copy.
                    </p>
                  )}
                </div>
                <div className="p-3 rounded-xl bg-stone-50 border border-stone-200">
                  <p className="font-bold text-stone-800 flex items-center gap-1.5">
                    <KeyRound className="w-4 h-4 text-stone-500" /> Encryption key storage
                  </p>
                  <p className="mt-1 text-stone-600">{status.credentials.detail}</p>
                </div>
              </div>
            </Card>
          </div>

          <Card
            title="Make a backup right now"
            icon={Database}
            subtitle="Snapshot → validate → compress → encrypt → write → verify → (cloud copy). Nothing is called a backup until it has been read back."
          >
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
              <Field label="Note (optional)" hint="Shown in the history, e.g “before menu change”.">
                <input className={inputClass} value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} placeholder="End of evening close" />
              </Field>
              <Field
                label={encryptionOn ? 'Backup password (only if asked)' : 'No password needed'}
                hint={
                  encryptionOn
                    ? 'The app normally remembers this key on your computer. Type it if the password was set on another machine.'
                    : 'Backups are stored unencrypted on this computer. Turn on encryption in the Automatic tab to also copy them to your cloud storage.'
                }
              >
                <input
                  className={inputClass}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={encryptionOn ? 'Only if the key is not remembered' : 'Encryption is off'}
                  disabled={!encryptionOn}
                />
              </Field>
              <Button
                variant="primary"
                icon={Database}
                busy={busy === 'create-2'}
                onClick={() =>
                  void run('create-2', async () => {
                    const result = await api.adminBackupCreate({ note: note.trim() || undefined, password: password || null });
                    setPassword('');
                    setNote('');
                    return {
                      tone: 'ok',
                      message:
                        result.cloud === 'queued'
                          ? 'Backup complete on this computer and confirmed as verified; the copy to your cloud storage has started.'
                          : `Backup complete — ${result.record.file.split('/').pop()} is verified (${formatBytes(result.record.bytes)}, ${result.durationMs} ms).`,
                    };
                  })
                }
              >
                Create backup
              </Button>
            </div>
            {status.schedule.running && status.schedule.phaseLabel ? (
              <p className="text-xs font-semibold text-stone-600 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> {status.schedule.phaseLabel}
              </p>
            ) : null}
            {status.waitingForCloud > 0 && cloud?.provider ? (
              <InlineAlert tone="warn" icon={Clock}>
                <span>
                  {status.waitingForCloud} verified {status.waitingForCloud === 1 ? 'backup is' : 'backups are'} still waiting for {cloud.label}. They stay on this
                  computer meanwhile — the app retries on its own, and “Send now” is in the Cloud Storage tab.
                </span>
              </InlineAlert>
            ) : null}
          </Card>
        </>
      ) : null}

      {section === 'history' ? (
        <Card
          title="Backup history"
          icon={Clock}
          subtitle="Every file this app wrote in the backup folder. Manual, safety and imported copies are never pruned automatically."
          action={
            <Button icon={RefreshCw} busy={busy === 'history'} onClick={() => void run('history', async () => undefined)}>
              Refresh
            </Button>
          }
        >
          {!history || history.length === 0 ? (
            <p className="text-xs text-stone-500">No backup files yet.</p>
          ) : (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-left text-xs border-collapse min-w-[46rem]">
                <thead>
                  <tr className="text-stone-500 font-bold">
                    <th className="py-2 px-2">Taken</th>
                    <th className="py-2 px-2">Folder</th>
                    <th className="py-2 px-2">Contents</th>
                    <th className="py-2 px-2">State</th>
                    <th className="py-2 px-2">Cloud</th>
                    <th className="py-2 px-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry) => {
                    const counts = entry.recordCounts;
                    return (
                      <tr key={entry.id} className="border-t border-stone-100 align-top">
                        <td className="py-2.5 px-2">
                          <p className="font-bold text-stone-800">{formatWhen(entry.createdAt)}</p>
                          <p className="text-stone-500">{TRIGGER_TEXT[entry.trigger] || entry.trigger}</p>
                          {entry.note ? <p className="text-stone-500 italic">“{entry.note}”</p> : null}
                        </td>
                        <td className="py-2.5 px-2">
                          <p className="font-mono text-[11px] text-stone-600 break-all">{entry.file}</p>
                          <p className="text-stone-500">{formatBytes(entry.bytes)}</p>
                        </td>
                        <td className="py-2.5 px-2 text-stone-600">
                          {counts.orders} orders · {counts.products} products · {counts.tables} tables · {counts.categories} categories
                        </td>
                        <td className="py-2.5 px-2">
                          <StatePill entry={entry} />
                        </td>
                        <td className="py-2.5 px-2 text-stone-600">
                          {entry.cloud ? (
                            <>
                              <p>{CLOUD_STATUS_TEXT[entry.cloud.status] || entry.cloud.status}</p>
                              <p className="text-stone-500">{entry.cloud.provider}</p>
                              {entry.cloud.error ? <p className="text-red-600 font-semibold">{entry.cloud.error}</p> : null}
                            </>
                          ) : (
                            <span className="text-stone-400">not sent</span>
                          )}
                        </td>
                        <td className="py-2.5 px-2">
                          <div className="flex flex-wrap gap-1.5 justify-end">
                            <Button
                              icon={CheckCircle2}
                              busy={busy === `verify-${entry.id}`}
                              onClick={() =>
                                void run(`verify-${entry.id}`, async () => {
                                  const result = await api.adminBackupVerify(entry.id, password || null);
                                  setPassword('');
                                  return { tone: result.verified ? 'ok' : 'error', message: result.message };
                                })
                              }
                            >
                              Verify
                            </Button>
                            <Button
                              icon={Download}
                              busy={busy === `download-${entry.id}`}
                              onClick={() =>
                                void run(`download-${entry.id}`, async () => {
                                  await api.adminBackupDownload(entry.id, entry.file.split('/').pop() || 'backup.rdbak');
                                  return { tone: 'ok', message: `${entry.file.split('/').pop()} was copied to your browser's downloads folder.` };
                                })
                              }
                            >
                              Download
                            </Button>
                            {!entry.missing && !entry.damaged && entry.verified ? (
                              <Button icon={RotateCcw} onClick={() => setRestoreTarget(entry)}>
                                Restore
                              </Button>
                            ) : null}
                            <Button
                              variant="danger"
                              icon={Trash2}
                              busy={busy === `delete-${entry.id}`}
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    `Delete ${entry.file.split('/').pop()} from this computer?\n\nAny copy in your cloud folder stays there (it is your file to keep). A restore safety copy and your newest verified backup cannot be deleted.`,
                                  )
                                ) {
                                  return;
                                }
                                void run(`delete-${entry.id}`, async () => {
                                  const result = await api.adminBackupDelete(entry.id);
                                  return { tone: result.ok ? 'ok' : 'warn', message: result.message };
                                });
                              }}
                            >
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {section === 'cloud' ? (
        <>
          <Card
            title="Your own cloud storage"
            icon={Cloud}
            subtitle="Connect the account you want to pay for and control. The app stores only its own files inside the backup folder it creates for this restaurant."
          >
            {!providers ? (
              <p className="text-xs font-semibold text-stone-500 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Checking which providers this installation can talk to…
              </p>
            ) : (
              <ul className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {providers.map((provider) => (
                  <li key={provider.id} className={`p-4 rounded-2xl border ${provider.isCurrent ? 'border-emerald-300 bg-emerald-50/50' : 'border-stone-200 bg-white'}`}>
                    <p className="font-black text-sm text-stone-900 flex items-center gap-2">
                      {provider.isCurrent ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <Cloud className="w-4 h-4 text-stone-400" />}
                      {provider.label}
                    </p>
                    <p className="text-[11px] text-stone-600 mt-1.5 leading-snug">{provider.accessSummary}</p>
                    <p className="text-[11px] mt-2 font-semibold">
                      {provider.clientConfigured ? (
                        <span className="text-emerald-700">Ready to connect</span>
                      ) : (
                        <span className="text-amber-700">Needs an OAuth client for this installation</span>
                      )}
                    </p>
                    {!provider.clientConfigured ? (
                      <p className="text-[11px] text-stone-500 mt-1">
                        Create your own app in {provider.label}'s developer console and set {provider.envVarNames.join(' and ')} in the app's environment, then reload.
                        Docs: <span className="font-mono">docs/BACKUP.md</span>.
                      </p>
                    ) : null}
                    {provider.isCurrent ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <Button icon={RefreshCw} busy={busy === 'test'} onClick={() => void run('test', async () => {
                          const result = await api.adminCloudTest();
                          return { tone: result.ok ? 'ok' : 'error', message: result.message };
                        })}>
                          Test connection
                        </Button>
                        <Button
                          variant="danger"
                          icon={Link2Off}
                          busy={busy === 'disconnect'}
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Disconnect ${provider.label}?\n\nYour existing backup files stay in your ${provider.label} folder — nothing is deleted. Automatic backups continue on this computer.`,
                              )
                            ) {
                              return;
                            }
                            void run('disconnect', async () => {
                              const result = await api.adminCloudDisconnect();
                              return { tone: 'ok', message: result.message };
                            });
                          }}
                        >
                          Disconnect
                        </Button>
                      </div>
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <Button
                          variant={provider.clientConfigured ? 'primary' : 'secondary'}
                          icon={Link2}
                          busy={connect?.begin.provider === provider.id}
                          onClick={() =>
                            void run(`connect-${provider.id}`, async () => {
                              const begun = await api.adminCloudConnect(provider.id);
                              setConnect({ begin: begun, outcome: null });
                              return { tone: 'idle', message: null };
                            })
                          }
                        >
                          Connect {provider.label}
                        </Button>
                        {provider.supportsDeviceCode ? (
                          <Button
                            icon={KeyRound}
                            busy={connect?.begin.provider === provider.id}
                            onClick={() =>
                              void run(`connect-${provider.id}-code`, async () => {
                                // No browser redirect at all: useful on a till whose
                                // loopback port or network makes the redirect awkward.
                                const begun = await api.adminCloudConnect(provider.id, { deviceCode: true });
                                setConnect({ begin: begun, outcome: null });
                                return { tone: 'idle', message: null };
                              })
                            }
                          >
                            Sign in with a code instead
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {connect ? (
              <div className="p-4 rounded-2xl border border-amber-200 bg-amber-50 space-y-3">
                <p className="text-xs font-bold text-stone-800">
                  {connect.begin.label} sign-in
                  {connect.outcome?.state === 'connected' ? ' — connected' : connect.outcome?.state === 'failed' ? ' — not connected' : ''}
                </p>
                <p className="text-xs text-stone-700">{connect.outcome?.message || connect.begin.instructions}</p>
                {connect.begin.usesRedirect ? (
                  <div className="text-[11px] text-stone-600">
                    <p>Your {connect.begin.label} app must be told to return to exactly this address (select it to copy):</p>
                    <code className="select-all block mt-1 px-2 py-1.5 rounded-lg bg-white border border-stone-200 font-mono text-[11px] text-stone-800 overflow-wrap-anywhere">
                      {connect.begin.redirectUri}
                    </code>
                  </div>
                ) : null}
                {connect.begin.usesRedirect ? (
                  <a
                    href={connect.begin.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 py-2 px-3.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-xs transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Open the {connect.begin.label} sign-in page
                  </a>
                ) : connect.begin.deviceCode ? (
                  <div className="space-y-1">
                    <p className="text-xs text-stone-700">
                      Open <span className="font-mono">{connect.begin.deviceCode.verificationUri}</span> on any device and type this code:
                    </p>
                    <p className="text-2xl font-black tracking-widest text-stone-900 select-all">{connect.begin.deviceCode.userCode}</p>
                    <p className="text-[11px] text-stone-500">The code expires in {Math.round(connect.begin.deviceCode.expiresIn / 60)} minutes. This window finishes by itself.</p>
                  </div>
                ) : null}
                {connect.outcome?.state !== 'connected' && connect.outcome?.state !== 'failed' && connect.outcome?.state !== 'expired' ? (
                  <p className="text-[11px] font-semibold text-stone-600 flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Waiting for you to finish in the browser…
                  </p>
                ) : null}
                <div className="flex gap-1.5">
                  {connect.outcome?.state === 'failed' || connect.outcome?.state === 'expired' ? (
                    <Button icon={RefreshCw} onClick={() => setConnect(null)}>
                      Start again
                    </Button>
                  ) : null}
                  <Button
                    onClick={() => setConnect(null)}
                  >
                    Close
                  </Button>
                </div>
                <p className="text-[11px] text-stone-500">
                  The sign-in happens between your browser and {connect.begin.label}. This app receives one short-lived code once and keeps the resulting access
                  grant in your computer's own credential store — never in a database, never in a log, never on our servers.
                </p>
              </div>
            ) : null}

            {cloud?.state === 'disconnected' ? (
              <InlineAlert tone="warn" icon={CloudOff}>
                <span>No cloud folder is connected, so verified backups live only on this computer. Local backups keep running either way.</span>
              </InlineAlert>
            ) : cloud && !cloud.clientConfigured ? (
              <InlineAlert tone="error" icon={AlertTriangle}>
                <span>
                  {cloud.label} is still listed as connected, but this installation no longer has its sign-in client configured ({providers?.find((item) => item.id === cloud.provider)?.envVarNames.join(
                    ' and ',
                  ) || 'the provider environment variables'}). Automatic backups keep running locally; cloud copies are paused until the client is configured again.
                </span>
              </InlineAlert>
            ) : null}

            {cloud?.retired && cloud.retired.length > 0 ? (
              <InlineAlert tone="idle" icon={Archive}>
                <span>
                  {cloud.retired
                    .map((entry) => `${entry.label}: ${entry.folderLabel || 'its backup folder'}`)
                    .join(' · ')}{' '}
                    — those files are still yours and are never deleted by this app. Switching providers keeps the old history visible.
                </span>
              </InlineAlert>
            ) : null}
          </Card>

          <Card
            title="Files in your cloud folder"
            icon={FolderOpen}
            subtitle="Listed straight from the connected account. A file that exists only there is what you would use on a new computer."
            action={
              <div className="flex gap-1.5">
                <Button
                  icon={Upload}
                  busy={busy === 'upload'}
                  disabled={!cloud?.provider}
                  onClick={() =>
                    void run('upload', async () => {
                      const summary = await api.adminBackupUpload();
                      return {
                        tone: summary.verified > 0 ? 'ok' : summary.failed > 0 ? 'error' : 'warn',
                        message:
                          summary.verified > 0
                            ? `${summary.verified} ${summary.verified === 1 ? 'backup is' : 'backups are'} confirmed in your cloud folder.`
                            : summary.reason || summary.results[0]?.detail || 'Nothing was sent — the copies already in the cloud are up to date.',
                      };
                    })
                  }
                >
                  Send pending copies now
                </Button>
                <Button icon={RefreshCw} onClick={() => void loadCloud()}>
                  Re-list
                </Button>
              </div>
            }
          >
            {!cloud?.provider ? (
              <p className="text-xs text-stone-500">Connect a provider above to list its backup folder.</p>
            ) : remoteFiles === null ? (
              <p className="text-xs font-semibold text-stone-500 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Listing {cloud.label}…
              </p>
            ) : remoteFiles.length === 0 ? (
              <p className="text-xs text-stone-500">The folder is empty — the next verified backup will be written into it.</p>
            ) : (
              <ul className="divide-y divide-stone-100">
                {remoteFiles.map((file) => (
                  <li key={file.id} className="py-2.5 flex flex-wrap items-center gap-3">
                    <div className="min-w-[16rem] flex-1">
                      <p className="font-bold text-xs text-stone-800 break-all">{file.name}</p>
                      <p className="text-[11px] text-stone-500">
                        {formatBytes(file.bytes)} · {file.modifiedAt ? formatWhen(file.modifiedAt) : 'date unknown'}
                        {file.onlyInCloud ? ' · only in the cloud (no local copy)' : file.knownLocally ? ' · matches a local backup' : ''}
                      </p>
                    </div>
                    <div className="flex gap-1.5">
                      <Button
                        icon={ArrowDownToLine}
                        busy={busy === `remote-import-${file.id}`}
                        onClick={() =>
                          void run(`remote-import-${file.id}`, async () => {
                            const result = await api.adminCloudRemoteImport(file.id, password || null);
                            setPassword('');
                            return { tone: result.foreignRestaurant ? 'warn' : 'ok', message: result.message };
                          })
                        }
                      >
                        Bring onto this computer
                      </Button>
                      <Button
                        variant="danger"
                        icon={Trash2}
                        busy={busy === `remote-delete-${file.id}`}
                        onClick={() => {
                          if (!window.confirm(`Delete ${file.name} from your ${cloud.label} folder?\n\nThis removes your off-site copy of it. The local file (if any) is untouched.`)) {
                            return;
                          }
                          void run(`remote-delete-${file.id}`, async () => {
                            const result = await api.adminCloudRemoteDelete(file.id, file.onlyInCloud);
                            return { tone: result.ok ? 'ok' : 'warn', message: result.message };
                          });
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}

      {section === 'recovery' ? (
        <>
          <Card title="Restore from a backup" icon={RotateCcw} subtitle="Restoring replaces everything in the app. It never starts without a safety copy of the current state.">
            {!history || history.length === 0 ? (
              <p className="text-xs text-stone-500">There is nothing to restore yet.</p>
            ) : (
              <ul className="divide-y divide-stone-100 text-xs">
                {history
                  .filter((entry) => entry.verified && !entry.missing && !entry.damaged)
                  .slice(0, 5)
                  .map((entry) => (
                    <li key={entry.id} className="py-2 flex items-center gap-3">
                      <span className="flex-1 font-semibold text-stone-800">{formatWhen(entry.createdAt)}</span>
                      <span className="text-stone-500">{formatBytes(entry.bytes)}</span>
                      <Button icon={RotateCcw} onClick={() => setRestoreTarget(entry)}>
                        Restore this
                      </Button>
                    </li>
                  ))}
              </ul>
            )}
            {nextRun.needsAttention ? (
              <InlineAlert tone="warn" icon={AlertTriangle}>
                <span>{nextRun.attentionMessage}</span>
              </InlineAlert>
            ) : null}
          </Card>

          <Card
            title="Bring in a backup file"
            icon={ArrowUpFromLine}
            subtitle="A .rdbak file from another computer, a USB stick or your own cloud folder. It is treated as untrusted until every check passes, and importing never changes your live data."
          >
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3 items-end">
              <Field label="Backup file">
                <input
                  key={fileInputKey}
                  type="file"
                  accept=".rdbak,application/octet-stream"
                  className={inputClass}
                  onChange={(event) => setImportFile(event.target.files?.[0] || null)}
                />
              </Field>
              <Field label="Password (if encrypted)">
                <input className={inputClass} type="password" autoComplete="off" value={importPassword} onChange={(event) => setImportPassword(event.target.value)} placeholder="The backup password" />
              </Field>
              <Button
                variant="primary"
                icon={FileCheck2}
                disabled={!importFile}
                busy={busy === 'import'}
                onClick={() =>
                  void run('import', async () => {
                    if (!importFile) return { tone: 'error', message: 'Choose the backup file first.' };
                    const result = await api.adminBackupImportFile(importFile, importPassword || null);
                    setImportFile(null);
                    setImportPassword('');
                    setFileInputKey((key) => key + 1);
                    return { tone: result.foreignRestaurant ? 'warn' : 'ok', message: result.message };
                  })
                }
              >
                Import and verify
              </Button>
            </div>
            <p className="text-[11px] text-stone-500">
              The app checks the format version, structure, checksums, encryption metadata, which restaurant the file belongs to, and refuses oversized or
              malformed files before anything is written.
            </p>
          </Card>

          <Card title="New computer or after a disaster" icon={HardDrive}>
            <ol className="text-xs text-stone-700 space-y-2 list-decimal list-inside">
              <li>Install this app and start it once, so its data folder exists.</li>
              <li>
                Set the same backup password. Without it the encrypted copies cannot be opened — that is the point of encrypting them.
                {!encryptionOn ? ' (This installation has encryption off, so cloud copies were never allowed.)' : ''}
              </li>
              <li>Open Backup &amp; Recovery → Cloud Storage, reconnect the account that holds your folder.</li>
              <li>Your existing files are listed under “Files in your cloud folder”. Use “Bring onto this computer” on the newest one.</li>
              <li>Check the counts it reports, then press Restore. The order numbering continues from the restored data and never rolls back.</li>
            </ol>
            <p className="text-[11px] text-stone-500">
              Nothing in this flow needs the old machine or any server of ours. If the cloud account itself is gone, the same steps work from a downloaded{' '}
              <span className="font-mono">.rdbak</span> file.
            </p>
            {desktop ? (
              <div className="flex gap-1.5">
                <Button
                  icon={FolderOpen}
                  busy={busy === 'reveal'}
                  onClick={() =>
                    void run('reveal', async () => {
                      const bridge = (window as any).nagoriDesktop;
                      const result = await bridge?.revealBackupFolder?.(status.location.dir);
                      if (!result) return { tone: 'error', message: 'This dialog is only available in the desktop app.' };
                      return { tone: result.ok ? 'idle' : 'error', message: result.ok ? null : result.message };
                    })
                  }
                >
                  Open the backup folder
                </Button>
              </div>
            ) : (
              <p className="text-[11px] text-stone-500">
                On this machine the files live in <span className="font-mono break-all">{status.location.dir}</span> — open it with your file manager to copy a{' '}
                <span className="font-mono">.rdbak</span> file to a USB stick.
              </p>
            )}
          </Card>
        </>
      ) : null}

      {section === 'automatic' ? (
        <>
          <Card title="Automatic backups" icon={Activity} subtitle="One run a day at the time you choose, plus a catch-up run if the machine was off. The point of sale keeps working while they run.">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <Field label="Nightly backups">
                <select
                  className={inputClass}
                  value={enabled ? 'on' : 'off'}
                  onChange={(event) => {
                    settingsDirty.current = true;
                    setEnabled(event.target.value === 'on');
                  }}
                >
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </Field>
              <Field label="Time (24-hour)" hint="Local time on this computer.">
                <input
                  className={inputClass}
                  value={dailyTime}
                  inputMode="numeric"
                  onChange={(event) => {
                    settingsDirty.current = true;
                    setDailyTime(event.target.value);
                  }}
                  placeholder="02:30"
                />
              </Field>
              <Button
                variant="primary"
                icon={CheckCircle2}
                busy={busy === 'schedule'}
                onClick={() =>
                  void run('schedule', async () => {
                    const saved = await api.adminBackupSaveConfig({ schedule: { enabled, dailyTime } });
                    settingsDirty.current = false;
                    return { tone: 'ok', message: `Saved. Next automatic backup ${formatFuture(saved.schedule.nextRunAt)}.` };
                  })
                }
              >
                Save schedule
              </Button>
            </div>

            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-y-2 gap-x-3 text-xs pt-1">
              <Field2 label="Next run">{nextRun.enabled ? `${formatFuture(nextRun.nextRunAt)} · ${nextRun.dailyTime}` : 'Switched off'}</Field2>
              <Field2 label="Last run">{formatWhen(nextRun.lastRunAt)}</Field2>
              <Field2 label="Outcome">{nextRun.lastOutcome === 'success' ? 'Succeeded' : nextRun.lastOutcome === 'failure' ? 'Failed' : 'Not run yet'}</Field2>
              <Field2 label="Consecutive failures">{nextRun.consecutiveFailures}</Field2>
            </dl>
            {nextRun.running && nextRun.phaseLabel ? (
              <p className="text-xs font-semibold text-stone-600 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> {nextRun.phaseLabel}
              </p>
            ) : null}
            {nextRun.lastOutcome === 'failure' ? (
              <InlineAlert tone="error" icon={AlertTriangle}>
                <span>The last automatic backup did not finish: {nextRun.lastError || 'no reason was recorded'}.</span>
              </InlineAlert>
            ) : null}
            {!nextRun.hasVerifiedBackup ? (
              <InlineAlert tone="warn" icon={AlertTriangle}>
                <span>No verified backup exists yet, so there is nothing to fall back on. Create one before relying on the nightly run.</span>
              </InlineAlert>
            ) : null}
          </Card>

          <Card title="How many copies are kept" icon={Clock} subtitle="Older automatic copies are pruned; the manual, safety and imported ones are never touched. The newest verified point is always kept.">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
              {(['daily', 'weekly', 'monthly'] as const).map((key) => (
                <Field key={key} label={`${key[0].toUpperCase()}${key.slice(1)} kept`}>
                  <input
                    className={inputClass}
                    type="number"
                    min={0}
                    max={key === 'daily' ? 365 : 120}
                    value={retention[key]}
                    onChange={(event) => {
                      settingsDirty.current = true;
                      setRetention({ ...retention, [key]: Math.max(0, Math.min(365, Number(event.target.value) || 0)) });
                    }}
                  />
                </Field>
              ))}
              <Button
                variant="primary"
                icon={CheckCircle2}
                busy={busy === 'retention'}
                onClick={() =>
                  void run('retention', async () => {
                    await api.adminBackupSaveConfig({ retention });
                    settingsDirty.current = false;
                    return { tone: 'ok', message: 'Retention updated. The newest verified backup is always kept.' };
                  })
                }
              >
                Save retention
              </Button>
            </div>
          </Card>

          <Card
            title="Backup password (encryption)"
            icon={KeyRound}
            subtitle="Required before any copy may leave this computer. It encrypts the files with AES-256-GCM; the app never stores the password itself."
          >
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
              <Field label={encryptionOn ? 'Current password' : 'Choose a password'} hint={encryptionOn ? 'Needed to re-wrap the existing key. Your backups stay readable.' : 'At least 8 characters. If it is lost, the backups cannot be opened.'}>
                <input className={inputClass} type="password" autoComplete="new-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
              </Field>
              <Field label="New password">
                <input className={inputClass} type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
              </Field>
              <Button
                variant="primary"
                icon={KeyRound}
                busy={busy === 'encryption'}
                disabled={!newPassword}
                onClick={() =>
                  void run('encryption', async () => {
                    const saved = await api.adminBackupSaveConfig({ encryption: { action: 'set', password: newPassword, currentPassword: currentPassword || null } });
                    setNewPassword('');
                    setCurrentPassword('');
                    return { tone: 'ok', message: saved.encryption?.message || 'Encryption updated.' };
                  })
                }
              >
                {encryptionOn ? 'Change password' : 'Turn on encryption'}
              </Button>
            </div>
            <p className="text-[11px] text-stone-500">
              Changing the password re-wraps the same key, so every existing backup file still opens. Cloud uploads are refused while encryption is off — an
              unprotected copy of your sales data never leaves this machine.
            </p>
            {encryptionOn ? (
              <div className="flex gap-1.5">
                <Button
                  variant="danger"
                  icon={AlertTriangle}
                  busy={busy === 'clear-encryption'}
                  onClick={() => {
                    if (!window.confirm('Turn encryption off?\n\nExisting backup files stay encrypted (they still need the password). New backups will not be encrypted, and cloud copies will stop until it is turned back on.')) {
                      return;
                    }
                    void run('clear-encryption', async () => {
                      const saved = await api.adminBackupSaveConfig({ encryption: { action: 'clear', currentPassword: currentPassword || null, password: '' } });
                      setCurrentPassword('');
                      return { tone: 'warn', message: saved.encryption?.message || 'Encryption is off for new backups.' };
                    });
                  }}
                >
                  Turn off encryption for new backups
                </Button>
              </div>
            ) : null}
          </Card>

          <Card title="Where the files are written" icon={FolderOpen} subtitle="Default is your computer's own application-data folder, outside the app's install folder so updates never touch it.">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3 items-end">
              <Field label="Backup folder" hint="Must already exist. Leave it empty to use the default.">
                <input className={inputClass} value={localDir} onChange={(event) => { settingsDirty.current = true; setLocalDir(event.target.value); }} placeholder={status.config.defaultLocalDir} />
              </Field>
              {desktop ? (
                <Button
                  icon={FolderOpen}
                  busy={busy === 'pick'}
                  onClick={() =>
                    void run('pick', async () => {
                      const bridge = (window as any).nagoriDesktop;
                      const picked = await bridge?.pickBackupFolder?.();
                      if (!picked) return { tone: 'error', message: 'Folder picking is only available in the desktop app.' };
                      if (!picked.ok) return { tone: 'error', message: picked.message || 'No folder was chosen.' };
                      setLocalDir(picked.path || '');
                      return { tone: 'idle', message: 'Now press Save so the app starts writing there.' };
                    })
                  }
                >
                  Choose folder…
                </Button>
              ) : null}
              <Button
                variant="primary"
                icon={CheckCircle2}
                busy={busy === 'folder'}
                onClick={() =>
                  void run('folder', async () => {
                    const saved = await api.adminBackupSaveConfig({ localDir: localDir.trim() });
                    settingsDirty.current = false;
                    return { tone: 'ok', message: `Backups will be written to ${saved.location.dir}.` };
                  })
                }
              >
                Save folder
              </Button>
            </div>
            <p className="text-[11px] text-stone-500">
              Existing files are not moved or deleted when this changes — the old folder keeps whatever is in it, and the history list only shows the current
              folder. The subfolders daily / weekly / monthly / manual are created inside it automatically.
            </p>
          </Card>
        </>
      ) : null}

      {restoreTarget ? (
        <RestoreDialog
          entry={restoreTarget}
          encryptionOn={encryptionOn}
          busy={busy === 'restore'}
          onCancel={() => setRestoreTarget(null)}
          onConfirm={async (confirmPassword, acknowledge) => {
            setBusy('restore');
            try {
              const result = await api.adminBackupRestore({
                recordId: restoreTarget.id,
                password: confirmPassword || null,
                acknowledgeForeignRestaurant: acknowledge,
              });
              setMessage({ tone: 'ok', text: result.message });
              setRestoreTarget(null);
              setPassword('');
              await refresh();
              // The whole dashboard's data just changed, not just this panel's.
              onRefresh?.();
            } catch (error: any) {
              setMessage({ tone: 'error', text: error?.message || 'The restore did not happen.' });
            } finally {
              setBusy(null);
            }
          }}
        />
      ) : null}
    </div>
  );
};

const Field2: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="min-w-0">
    <dt className="text-[10px] uppercase tracking-wide font-bold text-stone-400">{label}</dt>
    <dd className="text-xs font-semibold text-stone-800 overflow-wrap-anywhere">{children}</dd>
  </div>
);

/** Icon + words for the same reason everywhere: colour never carries meaning alone. */
const StatePill: React.FC<{ entry: BackupHistoryEntry }> = ({ entry }) => {
  if (entry.missing) return <Pill icon={AlertTriangle} tone="error" text="File missing" />;
  if (entry.damaged) return <Pill icon={ShieldAlert} tone="error" text="Damaged" />;
  if (!entry.verified) return <Pill icon={AlertTriangle} tone="error" text="Not verified" />;
  if (entry.foreignRestaurant) return <Pill icon={AlertTriangle} tone="warn" text="Different restaurant" />;
  if (entry.imported) return <Pill icon={ArrowUpFromLine} tone="idle" text="Imported" />;
  if (entry.safetyFor) return <Pill icon={ShieldCheck} tone="ok" text="Safety copy" />;
  return <Pill icon={CheckCircle2} tone="ok" text="Verified" />;
};

const Pill: React.FC<{ icon: typeof ShieldCheck; tone: Tone; text: string }> = ({ icon: Icon, tone, text }) => (
  <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-bold ${TONE_CLASS[tone]}`}>
    <Icon className="w-3.5 h-3.5" />
    <span>{text}</span>
  </span>
);

const RestoreDialog: React.FC<{
  entry: BackupHistoryEntry;
  encryptionOn: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (password: string, acknowledge: boolean) => Promise<void>;
}> = ({ entry, encryptionOn, busy, onCancel, onConfirm }) => {
  const [password, setPassword] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div className="fixed inset-0 z-50 bg-stone-900/60 flex items-end sm:items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Restore this backup">
      <div className="bg-white rounded-3xl border border-stone-200 shadow-lg w-full max-w-lg p-6 space-y-4 max-h-[92vh] overflow-y-auto">
        <header className="flex items-start gap-3">
          <RotateCcw className="w-6 h-6 text-amber-700 shrink-0" />
          <div>
            <h4 className="font-black text-stone-900">Restore this backup?</h4>
            <p className="text-xs text-stone-500 mt-0.5">{formatWhen(entry.createdAt)} · {formatBytes(entry.bytes)} · {entry.file.split('/').pop()}</p>
          </div>
        </header>

        <div className="p-3 rounded-xl bg-stone-50 border border-stone-200 text-xs text-stone-700 space-y-1.5">
          <p className="font-bold text-stone-800">What happens, in this order:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>The app creates a safety backup of everything that is live right now, in the manual folder.</li>
            <li>This file is re-verified — checksum, contents and structure — before anything changes.</li>
            <li>Your data is replaced with the contents of the backup.</li>
            <li>If any step fails, the app restores the safety backup and leaves your data as it was.</li>
          </ol>
        </div>

        <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-xs text-amber-900 space-y-1">
          <p className="font-bold">Right now this file would replace:</p>
          <p>
            {entry.recordCounts.orders} orders · {entry.recordCounts.products} products · {entry.recordCounts.tables} tables · {entry.recordCounts.feedbacks} reviews ·{' '}
            {entry.recordCounts.waiterCalls} waiter calls
          </p>
          <p className="font-semibold">Anything created after this backup will no longer be in the app afterwards (the safety copy still holds it).</p>
        </div>

        {entry.foreignRestaurant ? (
          <label className="flex items-start gap-2 text-xs font-semibold text-red-700">
            <input type="checkbox" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} className="mt-0.5" />
            <span>This file was written by a different restaurant installation, and I understand it will replace everything on this computer.</span>
          </label>
        ) : null}

        {encryptionOn ? (
          <Field label="Backup password" hint="Needed to open the encrypted file.">
            <input className={inputClass} type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
        ) : null}

        <label className="flex items-start gap-2 text-xs font-bold text-stone-800">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5" />
          <span>I understand this replaces the data in the app. The safety backup will be taken first, and the app will restart its screens afterwards.</span>
        </label>

        <div className="flex flex-wrap gap-2 justify-end pt-1">
          <Button onClick={onCancel} disabled={busy}>
            Cancel — nothing changes
          </Button>
          <Button
            variant="primary"
            icon={RotateCcw}
            busy={busy}
            disabled={!confirmed || (entry.foreignRestaurant && !acknowledge)}
            onClick={() => void onConfirm(password, acknowledge)}
          >
            Take safety copy and restore
          </Button>
        </div>
      </div>
    </div>
  );
};

/**
 * The one-time "protect your data" prompt.
 *
 * Rendered by the dashboard, not by this page, so a first-time owner sees it —
 * and it is deliberately not a lock: the dialog is dismissable, the POS keeps
 * working behind it, and "Maybe later" never re-appears on the same day it was
 * dismissed. Once a verified backup exists the server stops asking entirely.
 */
export const BackupFirstRunPrompt: React.FC<{ onOpenBackup?: () => void }> = ({ onOpenBackup }) => {
  const [state, setState] = useState<{ status: BackupStatusResponse | null; dismissed: boolean }>({ status: null, dismissed: false });

  useEffect(() => {
    let alive = true;
    api
      .adminBackupStatus()
      .then((response) => {
        if (alive) setState({ status: response, dismissed: false });
      })
      .catch(() => {
        /* no prompt when the state cannot be read — the POS must not be interrupted */
      });
    return () => {
      alive = false;
    };
  }, []);

  const visible = Boolean(state.status?.needsFirstRunPrompt) && !state.dismissed;
  if (!visible || !state.status) return null;

  const close = async (action: 'dismiss' | 'complete') => {
    setState((current) => ({ ...current, dismissed: true }));
    try {
      await api.adminBackupFirstRun(action);
    } catch {
      /* the answer is remembered server-side; nothing here must fail loudly */
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-stone-900/50 flex items-end sm:items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Protect your restaurant data">
      <div className="bg-white rounded-3xl border border-stone-200 shadow-xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-start gap-3">
          <ShieldAlert className="w-7 h-7 text-amber-700 shrink-0" />
          <div>
            <h3 className="font-black text-lg text-stone-900 leading-snug">Protect your restaurant data</h3>
            <p className="text-xs text-stone-600 mt-1.5 leading-relaxed">
              Orders, bills, stock and settings live on this computer. A lost laptop or a broken disk should never mean lost sales — set up a backup now, and you
              can copy it to your own Google Drive, OneDrive or Dropbox folder so it survives even a stolen till.
            </p>
          </div>
        </div>
        <ul className="text-xs text-stone-600 space-y-1.5">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> <span>A verified backup of the current state, on this computer.</span>
          </li>
          <li className="flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 text-stone-500 shrink-0 mt-0.5" /> <span>One automatic run a day, which you can turn off any time.</span>
          </li>
        </ul>
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={() => void close('dismiss')}
            className="py-2 px-3.5 rounded-xl text-xs font-bold text-stone-600 hover:bg-stone-50 border border-stone-200 transition-colors cursor-pointer"
          >
            Maybe later
          </button>
          <button
            type="button"
            onClick={() => {
              void close('complete');
              onOpenBackup?.();
            }}
            className="py-2 px-3.5 rounded-xl text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Database className="w-4 h-4" />
            Set up backup
          </button>
        </div>
        <p className="text-[11px] text-stone-400">Closing this does not block anything — the point of sale keeps running, and the reminder waits until tomorrow.</p>
      </div>
    </div>
  );
};

export default AdminBackup;
