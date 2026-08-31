/**
 * Client-side license service.
 *
 * The renderer's license flow is intentionally minimal — it just talks to
 * the existing `/api/license/*` endpoints that the same server exposes.
 * There is no separate "license module" running in the browser; the heavy
 * lifting (JWT signing/verification, fingerprint persistence, the actual
 * license file on disk) all happens server-side and is reached via the same
 * `fetchWithRetry` helper used by everything else.
 *
 * In the desktop app, the renderer also reads the machine fingerprint from
 * `window.nagoriDesktop` when available, so the same JS file works on both
 * the web build and the packaged Electron app.
 */

/**
 * Client-side license service.
 *
 * The renderer's license flow is intentionally minimal — it just talks to
 * the existing `/api/license/*` endpoints that the same server exposes.
 * There is no separate "license module" running in the browser; the heavy
 * lifting (JWT signing/verification, fingerprint persistence, the actual
 * license file on disk) all happens server-side and is reached via the
 * same retry policy used by everything else in services/api.ts.
 *
 * In the desktop app, the renderer also reads the machine fingerprint from
 * `window.nagoriDesktop` when available, so the same JS file works on both
 * the web build and the packaged Electron app.
 */

// We re-implement a thin client-side wrapper rather than depending on the
// internal symbol in services/api.ts. It mirrors the exact retry policy
// there: reads retry up to 3× on infrastructure hiccups, mutations retry
// at most once and only on transient 5xx / "starting up" responses.
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url: string, init: RequestInit & { retryDelayMs?: number } = {}): Promise<Response> {
  const { retryDelayMs, ...fetchInit } = init;
  const method = (fetchInit.method || 'GET').toUpperCase();
  const isRead = method === 'GET';
  const mutationRetryDelay = retryDelayMs ?? 1200;
  let lastResponse: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response | null = null;
    let networkError: unknown = null;
    const canRetryMore = attempt < MAX_ATTEMPTS;
    try {
      response = await fetch(url, fetchInit);
    } catch (error) {
      networkError = error;
    }
    if (networkError !== null) {
      lastError = networkError;
      lastResponse = null;
      if (canRetryMore) {
        await sleep(attempt === 1 ? (isRead ? 800 : mutationRetryDelay) : 2000);
        continue;
      }
      throw networkError;
    }
    lastResponse = response;
    lastError = null;
    const isServerHiccup = response!.status >= 500 && response!.status <= 504;
    if (!isServerHiccup) return response!;
    if (!canRetryMore) return response!;
    if (isRead) {
      await sleep(attempt === 1 ? 800 : 2000);
      continue;
    }
    const contentType = response!.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const bodyText = await response!.clone().text().catch(() => '');
      if (!/starting up/i.test(bodyText)) return response!;
    }
    await sleep(mutationRetryDelay);
  }
  if (lastError) throw lastError;
  return lastResponse as Response;
}

const API_BASE = '/api';

export type LicenseState =
  | 'not-required'
  | 'missing'
  | 'invalid'
  | 'expired'
  | 'active';

export interface LicenseStatusPayload {
  state: LicenseState;
  reason?: string;
  gracePeriodEndsAt?: number | null;
  payload?: {
    keyId: string;
    cafeName: string;
    email: string;
    plan: string;
    iat: number;
    exp: number | null;
    fingerprint: string;
    activated: boolean;
  };
  serverCheckedAt?: number | null;
}

export interface LicenseStatusResponse {
  licenseRequired: boolean;
  status: LicenseStatusPayload;
}

export interface ActivateResponse {
  ok: boolean;
  token?: string;
  payload?: LicenseStatusPayload['payload'];
  error?: string;
  errorCode?: 'INVALID_KEY' | 'KEY_REVOKED' | 'KEY_BOUND_TO_OTHER_MACHINE' | 'NETWORK_ERROR' | 'SERVER_ERROR';
}

/**
 * Returns a stable per-machine identifier. In the desktop app this comes
 * from the Electron main process (which uses `os` + machine-id). In the web
 * build, we fall back to a localStorage-backed UUID so the same browser
 * always reports the same fingerprint to the license server — this is what
 * makes "use the same license on two devices at once" deliberately fail
 * with a clear "already bound to another machine" error.
 */
export function getMachineFingerprint(): string {
  if (typeof window === 'undefined') return 'server';
  // Desktop: synchronously read the cached fingerprint populated by the
  // renderer after the first IPC call (see useFingerprintBootstrap below).
  if (window.nagoriDesktop?.isDesktop) {
    const cached = (window as any).__nagoriFingerprint as string | undefined;
    if (cached) return cached;
  }
  // Web fallback: a per-browser UUID stored in localStorage. Stable across
  // reloads; different across browsers/devices (which is what we want).
  const STORAGE_KEY = 'nagori_machine_fingerprint';
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing && existing.length >= 16) return existing;
    // crypto.randomUUID is available in every browser we support; the
    // fallback is a Math.random + timestamp combo for ancient environments.
    const fresh = typeof crypto !== 'undefined' && crypto.randomUUID
      ? `web-${crypto.randomUUID()}`
      : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // Private-mode browsers — make a session-only one.
    return `web-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Resolve the real machine fingerprint (desktop) and cache it on window.
 * Called once on app boot; safe to call repeatedly. Returns the value
 * that `getMachineFingerprint()` will subsequently return synchronously.
 */
export async function useFingerprintBootstrap(): Promise<string> {
  if (typeof window === 'undefined') return 'server';
  if (!window.nagoriDesktop?.isDesktop) {
    return getMachineFingerprint();
  }
  try {
    const fp = await window.nagoriDesktop.getMachineFingerprint();
    (window as any).__nagoriFingerprint = fp;
    return fp;
  } catch {
    return getMachineFingerprint();
  }
}

export const licenseService = {
  async getStatus(): Promise<LicenseStatusResponse> {
    const res = await fetchWithRetry(`${API_BASE}/license/status`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error('Unable to read license status from the server.');
    }
    return res.json();
  },

  async activate(input: { licenseKey: string; email: string; cafeName: string }): Promise<ActivateResponse> {
    const res = await fetchWithRetry(`${API_BASE}/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, fingerprint: getMachineFingerprint() }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Activation request failed.');
    }
    return res.json();
  },

  async rebind(input: { licenseKey: string; email: string }): Promise<ActivateResponse> {
    const res = await fetchWithRetry(`${API_BASE}/license/rebind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, newFingerprint: getMachineFingerprint() }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Rebind request failed.');
    }
    return res.json();
  },

  async heartbeat(): Promise<{ changed: boolean; status: LicenseStatusPayload }> {
    const res = await fetchWithRetry(`${API_BASE}/license/heartbeat`, { method: 'POST' });
    if (!res.ok) {
      throw new Error('Heartbeat failed.');
    }
    return res.json();
  },

  async deactivate(): Promise<{ ok: boolean; status: LicenseStatusPayload }> {
    const res = await fetchWithRetry(`${API_BASE}/license/deactivate`, { method: 'POST' });
    if (!res.ok) {
      throw new Error('Deactivation failed.');
    }
    return res.json();
  },
};
