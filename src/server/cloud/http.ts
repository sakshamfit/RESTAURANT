/**
 * The one HTTP client the cloud providers use.
 *
 * It exists so that the three provider files stay about their APIs, and so the
 * behaviours every destination needs are implemented exactly once: a hard
 * timeout (a hanging provider must never hold a backup open), one token refresh
 * and retry on an expired access token, error classification into something the
 * owner can act on, `Retry-After` honouring, and no secrets in any message that
 * could end up in a log or the UI.
 */
import { classifyHttpError, classifyTransportError, CloudError, providerLabel, type CloudProviderId } from './provider.js';

export interface CloudHttpOptions {
  provider: CloudProviderId;
  /** Default per-request timeout; uploads pass a longer one. */
  timeoutMs?: number;
  /**
   * Returns a usable access token, refreshing it if needed. Called before every
   * request, and again when a request comes back 401 — a refresh is attempted
   * once per request, never in a loop.
   */
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  /** Test seam: providers are exercised against fakes with no network at all. */
  fetchImpl?: typeof fetch;
}

export interface CloudRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as application/x-www-form-urlencoded (OAuth endpoints). */
  form?: Record<string, string | undefined>;
  /** Sent verbatim (upload chunks, multipart bodies). */
  body?: Buffer | Uint8Array | string;
  /** Do not throw on a non-2xx status; the caller inspects `status`. */
  allowFailure?: boolean;
  /** `binary` keeps the response bytes intact (downloads); default is text. */
  expect?: 'text' | 'binary';
  timeoutMs?: number;
  /** Number of bytes to read for an error body before giving up. */
  maxErrorBytes?: number;
}

export interface CloudResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  json: <T = any>() => T;
  buffer: () => Buffer;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY = 4000;

export class CloudHttp {
  private inflightRefresh: Promise<string> | null = null;

  constructor(private readonly options: CloudHttpOptions) {}

  get provider(): CloudProviderId {
    return this.options.provider;
  }

  private async token(): Promise<string> {
    return this.options.getAccessToken();
  }

  /**
   * Refresh at most once per wave of 401s: a backup pipeline that touches a
   * dozen endpoints must not fire a dozen refresh requests, because several
   * providers rotate refresh tokens and concurrent refreshes invalidate each
   * other.
   */
  private async refreshed(): Promise<string> {
    if (!this.inflightRefresh) {
      const pending = this.options.getAccessToken({ forceRefresh: true }).finally(() => {
        if (this.inflightRefresh === pending) this.inflightRefresh = null;
      });
      this.inflightRefresh = pending;
    }
    return this.inflightRefresh;
  }

  private buildUrl(request: CloudRequest): string {
    if (!request.query) return request.url;
    const url = new URL(request.url);
    for (const [key, value] of Object.entries(request.query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private bodyFor(request: CloudRequest): { body?: string | Buffer | Uint8Array; contentType?: string } {
    if (request.json !== undefined) return { body: JSON.stringify(request.json), contentType: 'application/json' };
    if (request.form) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(request.form)) {
        if (value !== undefined) params.set(key, value);
      }
      return { body: params.toString(), contentType: 'application/x-www-form-urlencoded' };
    }
    if (request.body !== undefined) return { body: request.body };
    return {};
  }

  async send(request: CloudRequest): Promise<CloudResponse> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new CloudError('This runtime cannot reach the internet, so cloud backup is unavailable.', 'network', { provider: this.provider });
    }
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = this.buildUrl(request);
    // GET/DELETE must not carry a body, but the shape stays the same so the code
  // below can read it unconditionally.
    const body = request.method === 'GET' || request.method === 'DELETE' ? {} : this.bodyFor(request);
    const accessToken = await this.token();

    const perform = async (token: string): Promise<{ response: Response; text: string; buffer: Buffer }> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();
      try {
        const response = await fetchImpl(url, {
          method: request.method || (body.body === undefined ? 'GET' : 'POST'),
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            ...(body.contentType ? { 'Content-Type': body.contentType } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(request.headers || {}),
          },
          ...(body.body === undefined ? {} : { body: body.body as BodyInit }),
        });
        let text = '';
        let buffer = Buffer.alloc(0);
        if (request.expect === 'binary') {
          buffer = Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
        } else {
          text = await response.text().catch(() => '');
        }
        return { response, text, buffer };
      } finally {
        clearTimeout(timer);
      }
    };

    let { response, text, buffer } = await perform(accessToken).catch((error) => {
      throw classifyTransportError(error, this.provider, timeoutMs);
    });

    // 401 is always worth one silent refresh, even when the caller asked to
    // inspect statuses itself: an expired token is not a result, it is a step.
    if (response.status === 401) {
      // Expired access token: refresh once, retry once.
      let fresh = '';
      try {
        fresh = await this.refreshed();
      } catch (error) {
        if (error instanceof CloudError) throw error;
        throw new CloudError(`${this.label()} asked this computer to sign in again, and signing in silently failed. Reconnect ${this.label()} in Settings.`, 'auth', { provider: this.provider });
      }
      ({ response, text, buffer } = await perform(fresh).catch((error) => {
        throw classifyTransportError(error, this.provider, timeoutMs);
      }));
    }

    const headers = response.headers;
    const ok = response.ok;
    if (!ok && !request.allowFailure) {
      throw classifyHttpError(response.status, text.slice(0, MAX_ERROR_BODY), this.provider, {
        retryAfterSeconds: retryAfterSeconds(headers),
      });
    }
    const rawText = text;
    return {
      status: response.status,
      ok,
      headers,
      text: rawText,
      json: <T,>(): T => {
        try {
          return JSON.parse(rawText || '{}') as T;
        } catch {
          throw new CloudError(`${this.label()} returned a response this app could not read. It will try again on the next backup.`, 'server', { provider: this.provider });
        }
      },
      buffer: () => (buffer.length ? buffer : Buffer.from(rawText, 'utf8')),
    };
  }

  async json<T = any>(request: CloudRequest): Promise<T> {
    const response = await this.send(request);
    return response.json<T>();
  }

  /**
   * Same as `json`, but a provider that rejects the request comes back as an
   * object instead of throwing — used where a missing answer is normal (e.g.
   * asking for the size of a file that may have been deleted).
   */
  async tryJson<T = any>(request: CloudRequest): Promise<T | null> {
    try {
      const response = await this.send({ ...request, allowFailure: true });
      if (!response.ok) return null;
      return response.json<T>();
    } catch {
      return null;
    }
  }

  async download(request: CloudRequest): Promise<Buffer> {
    const response = await this.send({ ...request, method: 'GET', expect: 'binary' });
    return response.buffer();
  }

  private label(): string {
    return providerLabel(this.provider);
  }
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after') || headers.get('Retry-After');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds, 86_400));
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.min(Math.round((date - Date.now()) / 1000), 86_400));
  return undefined;
}
