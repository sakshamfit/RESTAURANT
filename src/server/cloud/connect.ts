/**
 * Connect-flow plumbing between the browser and the provider.
 *
 * The owner clicks a real link to the provider, the provider redirects the
 * *browser* to /api/cloud/callback (which has no admin token), and the app finds
 * out what happened by polling for the result of that state. Nothing is passed
 * through the URL of the app itself, no token ever appears in a query string, and
 * the authorization code is spent exactly once — by the callback route, not by the
 * page that shows the outcome.
 */
import type { CloudProviderId } from '../backupConfig.js';
import { CloudError, PROVIDER_LABELS, providerLabel } from './provider.js';
import { beginConnect, completeConnect } from './manager.js';
import { peekPending } from './oauth.js';
import { loadBackupConfig } from '../backupConfig.js';

interface ConnectAttempt {
  provider: CloudProviderId;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  error: string | null;
  accountLabel: string | null;
  folderLabel: string | null;
  folderPath: string | null;
}

// In-memory on purpose: a connect attempt is a minutes-long interaction with one
// browser. If the server restarts mid-flow the owner simply starts it again — the
// alternative (persisting a pending code) would store material worth less than the
// trouble it takes to leak.
const attempts = new Map<string, ConnectAttempt>();
const TTL_MS = 15 * 60_000;

function prune(): void {
  const now = Date.now();
  for (const [key, value] of attempts) {
    if (now - value.startedAt > TTL_MS) attempts.delete(key);
  }
}

export interface BeginConnectOutcome {
  ok: true;
  provider: CloudProviderId;
  label: string;
  url: string;
  state: string;
  usesRedirect: boolean;
  /** The address the provider must be told to return to — registered by the owner. */
  redirectUri: string;
  deviceCode: { userCode: string; verificationUri: string; expiresIn: number; interval: number } | null;
  instructions: string;
}

export async function startConnect(
  provider: CloudProviderId,
  redirectUri: string,
  options: { deviceCode?: boolean } = {},
): Promise<BeginConnectOutcome> {
  prune();
  const begun = await beginConnect(provider, redirectUri, { deviceCode: Boolean(options.deviceCode) });
  attempts.set(begun.state, {
    provider,
    startedAt: Date.now(),
    finishedAt: null,
    ok: null,
    error: null,
    accountLabel: null,
    folderLabel: null,
    folderPath: null,
  });
  return {
    ok: true,
    provider,
    label: PROVIDER_LABELS[provider],
    url: begun.url,
    state: begun.state,
    usesRedirect: begun.usesRedirect,
    redirectUri,
    deviceCode: begun.deviceCode
      ? {
          userCode: begun.deviceCode.userCode,
          verificationUri: begun.deviceCode.verificationUri,
          expiresIn: begun.deviceCode.expiresIn,
          interval: begun.deviceCode.interval,
        }
      : null,
    instructions: begun.instructions || 'Open the link, approve access, and return here.',
  };
}

/**
 * The provider's redirect target. Returns the outcome for the polling app and, on
 * success, performs the exchange + the write/read/delete probe. Failures land in
 * `error` as an owner-readable sentence, because the tab the owner is looking at
 * cannot show a toast.
 */
export async function handleCloudCallback(input: { code: string; state: string; error?: string }): Promise<{ ok: boolean; provider: CloudProviderId | null; message: string }> {
  prune();
  const record = attempts.get(input.state) || null;
  const restaurantId = loadBackupConfig().restaurantId;
  const pending = peekPending(input.state, restaurantId);
  const provider = record?.provider ?? pending?.provider ?? null;
  if (!provider) {
    return { ok: false, provider: null, message: 'This sign-in link is not one this app is waiting for. Start the connection again from Settings.' };
  }
  if (input.error) {
    const message =
      input.error === 'access_denied' || /access_denied|consent_required|login_required/i.test(input.error)
        ? `${providerLabel(provider)} sign-in was cancelled, so nothing was connected.`
        : `${providerLabel(provider)} reported a problem (${input.error}). Nothing was connected.`;
    finish(input.state, { ok: false, error: message });
    return { ok: false, provider, message };
  }
  try {
    const connection = await completeConnect(provider, input.code, input.state);
    finish(input.state, {
      ok: true,
      accountLabel: connection.accountLabel,
      folderLabel: connection.folderLabel,
      folderPath: connection.folderPath,
    });
    return { ok: true, provider, message: `${PROVIDER_LABELS[provider]} is connected to ${connection.folderLabel}.` };
  } catch (error) {
    const message = error instanceof CloudError ? error.message : `${providerLabel(provider)} could not finish signing in. Please try again.`;
    finish(input.state, { ok: false, error: message });
    return { ok: false, provider, message };
  }
}

function finish(state: string, patch: Partial<ConnectAttempt>): void {
  const existing = attempts.get(state);
  if (!existing) return;
  attempts.set(state, { ...existing, ...patch, finishedAt: Date.now() });
}

export interface ConnectResult {
  ok: boolean;
  state: 'pending' | 'connected' | 'failed';
  provider: CloudProviderId | null;
  message: string | null;
  accountLabel: string | null;
  folderLabel: string | null;
  folderPath: string | null;
}

export function getConnectResult(state: string): ConnectResult | null {
  const record = attempts.get(state);
  if (!record) return null;
  if (record.ok === null) return { ok: false, state: 'pending', provider: record.provider, message: null, accountLabel: null, folderLabel: null, folderPath: null };
  // Consumed once the app has seen it, so a stale success cannot re-appear later.
  const result: ConnectResult = {
    ok: record.ok,
    state: record.ok ? 'connected' : 'failed',
    provider: record.provider,
    message: record.ok ? `${PROVIDER_LABELS[record.provider]} is connected.` : record.error,
    accountLabel: record.accountLabel,
    folderLabel: record.folderLabel,
    folderPath: record.folderPath,
  };
  attempts.delete(state);
  return result;
}

/** Device-code flow has no redirect, so the app posts the code back itself. */
export async function completeConnectFromApp(provider: CloudProviderId, code: string, state: string): Promise<{ ok: true; connection: unknown }> {
  const connection = await completeConnect(provider, code, state);
  finish(state, { ok: true, accountLabel: connection.accountLabel, folderLabel: connection.folderLabel, folderPath: connection.folderPath });
  return { ok: true, connection };
}
