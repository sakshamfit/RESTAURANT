import crypto from 'crypto';
import type { CloudProviderId } from '../backupConfig.js';
import { clearCredential, readCredential, saveCredential, type CloudCredential } from '../credentials.js';
import { CloudError, type AuthorizeRequest, type OAuthSpec, type CloudTokens } from './provider.js';

/**
 * Provider-side convenience layer. Each provider file passes its `OAuthSpec`
 * plus the installation's client id, and gets the three things every cloud
 * connection needs: a URL to hand the browser, a state-checked code exchange,
 * and a token loader that refreshes on demand. Keeping the flow here is what
 * stops three near-identical OAuth implementations from drifting apart.
 */

/**
 * One shared OAuth 2.0 implementation for all three providers:
 * authorization code + PKCE (public client, so no client secret is ever
 * required or stored), optional device-code flow for machines where a browser
 * redirect back to the app is awkward, and refresh-token maintenance.
 *
 * Nothing here is provider-specific except the endpoints, which each provider
 * file supplies through `OAuthSpec`. Token material is handed to
 * `credentials.ts` (OS credential store) and never to the database,
 * `restaurant.json`, a backup file, or the browser.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh a bit early so a backup never dies on an expired access token. */
const EXPIRY_SKEW_MS = 60 * 1000;

export interface PendingAuthorization {
  provider: CloudProviderId;
  state: string;
  verifier: string;
  challenge: string;
  redirectUri: string;
  createdAt: number;
}

interface StateStore {
  pending: Map<string, PendingAuthorization>;
}

// Process-local map, plus a mirror in the credential store: a packaged desktop
// app may restart between "open the sign-in page" and the callback landing.
const stateStore: StateStore = { pending: new Map() };

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createState(): { state: string; verifier: string; challenge: string } {
  const state = base64Url(crypto.randomBytes(24));
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { state, verifier, challenge };
}

export function rememberPending(pending: PendingAuthorization, restaurantId: string): void {
  stateStore.pending.set(pending.state, pending);
  saveCredential(`oauth-pending`, restaurantId, {
    extra: {
      provider: pending.provider,
      state: pending.state,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
      createdAt: String(pending.createdAt),
    },
  });
  // Only one in-flight sign-in at a time: drop anything older than the TTL.
  for (const [key, value] of stateStore.pending) {
    if (Date.now() - value.createdAt > STATE_TTL_MS) stateStore.pending.delete(key);
  }
}

/** Read the pending record without consuming it (device codes are polled). */
export function peekPending(state: string, restaurantId: string): PendingAuthorization | null {
  const inMemory = stateStore.pending.get(state);
  if (inMemory) {
    if (Date.now() - inMemory.createdAt > STATE_TTL_MS) {
      stateStore.pending.delete(state);
      return null;
    }
    return inMemory;
  }
  void restaurantId;
  return null;
}

export function takePending(state: string, restaurantId: string): PendingAuthorization | null {
  const inMemory = stateStore.pending.get(state);
  if (inMemory) {
    stateStore.pending.delete(state);
    if (Date.now() - inMemory.createdAt > STATE_TTL_MS) return null;
    return inMemory;
  }
  const stored = readCredential('oauth-pending', restaurantId);
  const extra = stored?.extra;
  if (!extra?.state || !extra?.verifier || !extra?.provider) return null;
  clearCredential('oauth-pending', restaurantId);
  const createdAt = Number(extra.createdAt) || 0;
  if (Date.now() - createdAt > STATE_TTL_MS) return null;
  if (extra.state !== state) return null;
  return {
    provider: extra.provider as CloudProviderId,
    state,
    verifier: extra.verifier,
    challenge: '',
    redirectUri: extra.redirectUri || '',
    createdAt,
  };
}

/** Authorize URL with the client id already substituted (providers pass it in). */
export function authorizeUrlFor(spec: OAuthSpec, clientId: string, options: { state: string; challenge: string; redirectUri: string }): string {
  const url = new URL(spec.authorizeEndpoint);
  const search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: options.redirectUri,
    state: options.state,
    scope: spec.scopes.join(' '),
    ...(spec.authorizeParams || {}),
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
  });
  url.search = search.toString();
  return url.toString();
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

function toTokens(payload: RawTokenResponse, previous?: CloudTokens | null): CloudTokens {
  if (payload.error) {
    const description = payload.error_description || payload.error;
    const kind = /invalid_grant|consent|revoked|interaction_required|login_required/i.test(description) ? 'auth' : 'server';
    throw new CloudError(
      /invalid_grant|revoked/i.test(description)
        ? 'The cloud provider rejected the authorization (it was used twice, expired, or was revoked). Please connect the account again.'
        : `The cloud provider refused to sign in: ${description}`,
      kind,
      { status: kind === 'auth' ? 401 : 502 }
    );
  }
  if (!payload.access_token) throw new CloudError('The cloud provider returned no access token.', 'auth', { status: 502 });
  return {
    accessToken: payload.access_token,
    // Providers only send refresh_token on the first exchange; keep the old one.
    refreshToken: payload.refresh_token || previous?.refreshToken || null,
    expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : null,
    scope: payload.scope || previous?.scope || null,
  };
}

async function postForm(
  endpoint: string,
  form: Record<string, string>,
  options: { clientId?: string; clientSecret?: string | null; fetchImpl?: typeof fetch } = {}
): Promise<RawTokenResponse> {
  const doFetch = options.fetchImpl || fetch;
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (options.clientId && options.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`;
  }
  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: 'POST',
      headers,
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const message = String((error as Error)?.message || error);
    if (/ENOTFOUND|ECONNREFUSED|timeout|network|fetch failed|abort/i.test(message)) {
      throw new CloudError('The cloud sign-in service could not be reached. Check the internet connection and try again.', 'offline', { retryable: true });
    }
    throw new CloudError(`The cloud sign-in request failed: ${message}`, 'network', { retryable: true });
  }
  const text = await response.text();
  let payload: RawTokenResponse = {};
  try {
    payload = JSON.parse(text) as RawTokenResponse;
  } catch {
    throw new CloudError(`The cloud sign-in service answered in a way this app could not read (HTTP ${response.status}).`, 'server', { status: response.status });
  }
  if (!response.ok && !payload.error) payload.error = `http_${response.status}`;
  return payload;
}

export async function exchangeCodeForTokens(options: {
  spec: OAuthSpec;
  code: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<CloudTokens> {
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.verifier,
    ...(options.spec.tokenParams || {}),
  };
  if (options.clientSecret) form.client_secret = options.clientSecret;
  const payload = await postForm(options.spec.tokenEndpoint, form, { fetchImpl: options.fetchImpl });
  return toTokens(payload);
}

export async function refreshTokens(options: {
  spec: OAuthSpec;
  refreshToken: string;
  clientId: string;
  clientSecret?: string | null;
  fetchImpl?: typeof fetch;
  previous?: CloudTokens | null;
}): Promise<CloudTokens> {
  const form: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
    ...(options.spec.tokenParams || {}),
  };
  if (options.clientSecret) form.client_secret = options.clientSecret;
  const payload = await postForm(options.spec.tokenEndpoint, form, { fetchImpl: options.fetchImpl });
  return toTokens(payload, options.previous);
}

// ── device code flow (OneDrive / Xbox-style; used when a redirect is awkward) ─

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export async function startDeviceCode(options: {
  spec: OAuthSpec;
  clientId: string;
  fetchImpl?: typeof fetch;
}): Promise<DeviceCode> {
  const endpoint = options.spec.deviceCodeEndpoint;
  if (!endpoint) throw new CloudError('This cloud provider does not offer device-code sign-in.', 'unsupported');
  const doFetch = options.fetchImpl || fetch;
  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: options.clientId, scope: options.spec.scopes.join(' ') }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new CloudError(`Could not start device sign-in with the cloud provider: ${(error as Error)?.message || error}`, 'offline', { retryable: true });
  }
  const payload = (await response.json().catch(() => ({}))) as Partial<DeviceCode>;
  if (!payload.deviceCode || !payload.verificationUri) {
    throw new CloudError('The cloud provider did not offer a device sign-in code.', 'auth', { status: 502 });
  }
  return {
    deviceCode: payload.deviceCode,
    userCode: payload.userCode || '',
    verificationUri: payload.verificationUri,
    expiresIn: Number(payload.expiresIn) || 900,
    interval: Number(payload.interval) || 5,
  };
}

export async function pollDeviceCode(options: {
  spec: OAuthSpec;
  deviceCode: string;
  clientId: string;
  fetchImpl?: typeof fetch;
}): Promise<CloudTokens | null> {
  const payload = await postForm(
    options.spec.tokenEndpoint,
    { grant_type: 'device_code', device_code: options.deviceCode, client_id: options.clientId },
    { fetchImpl: options.fetchImpl }
  );
  if (payload.error === 'authorization_pending' || payload.error === 'slow_down') return null;
  return toTokens(payload as RawTokenResponse);
}

// ── token persistence (OS credential store) ─────────────────────────────────

const TOKEN_PROVIDER = 'cloud-tokens';

export function storeTokens(restaurantId: string, provider: CloudProviderId, tokens: CloudTokens, meta: { accountLabel?: string | null; clientSecret?: string | null } = {}): boolean {
  const credential: CloudCredential = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? null,
    expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null,
    scope: tokens.scope ?? null,
    accountLabel: meta.accountLabel ?? null,
    clientSecret: meta.clientSecret ?? null,
  };
  return saveCredential(TOKEN_PROVIDER, `${provider}__${restaurantId}`, credential).ok;
}

export function loadTokens(restaurantId: string, provider: CloudProviderId): { tokens: CloudTokens | null; clientSecret: string | null; accountLabel: string | null } {
  const stored = readCredential(TOKEN_PROVIDER, `${provider}__${restaurantId}`);
  if (!stored) return { tokens: null, clientSecret: null, accountLabel: null };
  const expiresAt = stored.expiresAt ? Date.parse(stored.expiresAt) : null;
  return {
    tokens: {
      accessToken: stored.accessToken || '',
      refreshToken: stored.refreshToken ?? null,
      expiresAt: Number.isFinite(expiresAt as number) ? (expiresAt as number) : null,
      scope: stored.scope ?? null,
    },
    clientSecret: stored.clientSecret ?? null,
    accountLabel: stored.accountLabel ?? null,
  };
}

/** Forgetting a connection drops the locally stored tokens for good. */
export function forgetTokens(restaurantId: string, provider: CloudProviderId): void {
  clearCredential(TOKEN_PROVIDER, `${provider}__${restaurantId}`);
}

/** Best-effort server-side revocation so a disconnect also invalidates tokens. */
export async function revokeToken(options: {
  revokeEndpoint: string | null;
  token: string;
  clientId: string;
  clientSecret?: string | null;
  fetchImpl?: typeof fetch;
  /** Google's revoke endpoint takes the token in the query string. */
  useQuery?: boolean;
}): Promise<void> {
  if (!options.revokeEndpoint || !options.token) return;
  const doFetch = options.fetchImpl || fetch;
  const params = new URLSearchParams({
    token: options.token,
    client_id: options.clientId,
    ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
  }).toString();
  try {
    await doFetch(options.useQuery ? `${options.revokeEndpoint}?${params}` : options.revokeEndpoint, {
      method: options.useQuery ? 'GET' : 'POST',
      headers: options.useQuery ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' },
      ...(options.useQuery ? {} : { body: params }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Losing the revoke call must not block disconnecting: the owner can also
    // revoke access from their cloud account's security page.
  }
}

/** Step 1 for redirect-based providers: build the URL and remember what to expect back. */
export function beginAuthForProvider(options: {
  spec: OAuthSpec;
  provider: CloudProviderId;
  restaurantId: string;
  clientId: string;
  redirectUri: string;
}): { url: string; state: string; verifier: string } {
  const created = createState();
  rememberPending(
    {
      provider: options.provider,
      state: created.state,
      verifier: created.verifier,
      challenge: created.challenge,
      redirectUri: options.redirectUri,
      createdAt: Date.now(),
    },
    options.restaurantId,
  );
  return {
    url: authorizeUrlFor(options.spec, options.clientId, { state: created.state, challenge: created.challenge, redirectUri: options.redirectUri }),
    state: created.state,
    verifier: created.verifier,
  };
}

/**
 * Step 2. The pending record is consumed exactly once, and the provider recorded
 * in it must match the provider being completed: that is what makes a callback
 * unusable for CSRF, unusable for replay against another provider, and unusable
 * a second time in general.
 */
export async function finishAuthForProvider(options: {
  spec: OAuthSpec;
  provider: CloudProviderId;
  restaurantId: string;
  clientId: string;
  code: string;
  state: string;
  fetchImpl?: typeof fetch;
}): Promise<CloudTokens> {
  const pending = takePending(options.state, options.restaurantId);
  if (!pending) {
    throw new CloudError('That sign-in link has already been used or has expired. Start the connection again to get a fresh link.', 'auth');
  }
  if (pending.provider !== options.provider) {
    throw new CloudError('That sign-in link belongs to a different cloud provider. Start the connection again.', 'auth');
  }
  if (!pending.verifier) {
    throw new CloudError('This sign-in was started by an older version of the app and cannot be finished. Start the connection again.', 'auth');
  }
  const stored = loadTokens(options.restaurantId, options.provider);
  const tokens = await exchangeCodeForTokens({
    spec: options.spec,
    code: options.code,
    verifier: pending.verifier,
    redirectUri: pending.redirectUri,
    clientId: options.clientId,
    clientSecret: stored.clientSecret,
    fetchImpl: options.fetchImpl,
  });
  storeTokens(options.restaurantId, options.provider, tokens, { clientSecret: stored.clientSecret, accountLabel: stored.accountLabel });
  return tokens;
}

/**
 * Device-code variant, for tenants where a redirect back to the till machine is
 * awkward. The protocol has no state parameter, so our own state exists to bind
 * the pending record and to refuse a code that lands after the owner gave up.
 */
export async function beginDeviceAuthForProvider(options: {
  spec: OAuthSpec;
  provider: CloudProviderId;
  restaurantId: string;
  clientId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ request: AuthorizeRequest; state: string }> {
  const created = createState();
  const device = await startDeviceCode({ spec: options.spec, clientId: options.clientId, fetchImpl: options.fetchImpl });
  rememberPending(
    {
      provider: options.provider,
      state: created.state,
      verifier: '',
      challenge: created.challenge,
      redirectUri: `device:${device.deviceCode}`,
      createdAt: Date.now(),
    },
    options.restaurantId,
  );
  return {
    state: created.state,
    request: {
      url: device.verificationUri,
      state: created.state,
      usesRedirect: false,
      deviceCode: {
        deviceCode: device.deviceCode,
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        expiresIn: device.expiresIn,
        interval: device.interval,
      },
    },
  };
}

/** One poll of a device-code grant; tokens arrive once the owner finishes signing in. */
export async function pollDeviceAuthForProvider(options: {
  spec: OAuthSpec;
  provider: CloudProviderId;
  restaurantId: string;
  clientId: string;
  state: string;
  deviceCode: string;
  fetchImpl?: typeof fetch;
}): Promise<CloudTokens | null> {
  const pending = peekPending(options.state, options.restaurantId);
  if (!pending || pending.provider !== options.provider || pending.redirectUri !== `device:${options.deviceCode}`) {
    throw new CloudError('That sign-in code is no longer active on this computer. Start the connection again.', 'auth');
  }
  const tokens = await pollDeviceCode({ spec: options.spec, deviceCode: options.deviceCode, clientId: options.clientId, fetchImpl: options.fetchImpl });
  if (!tokens) return null;
  takePending(options.state, options.restaurantId);
  const stored = loadTokens(options.restaurantId, options.provider);
  storeTokens(options.restaurantId, options.provider, tokens, { clientSecret: stored.clientSecret, accountLabel: stored.accountLabel });
  return tokens;
}

/** The token source every provider hands to `CloudHttp`. */
export function tokenLoaderFor(options: {
  spec: OAuthSpec;
  provider: CloudProviderId;
  restaurantId: string;
  clientId: string;
  clientSecret?: string | null;
  fetchImpl?: typeof fetch;
}): (callOptions?: { forceRefresh?: boolean }) => Promise<string> {
  return async (callOptions) => {
    const stored = loadTokens(options.restaurantId, options.provider);
    if (!stored.tokens?.accessToken) {
      throw new CloudError('This cloud account is not connected on this computer. Connect it under Cloud storage in Settings.', 'auth', { provider: options.provider });
    }
    const mustRefresh = Boolean(callOptions?.forceRefresh) || shouldRefresh(stored.tokens);
    if (!mustRefresh || !stored.tokens.refreshToken) return stored.tokens.accessToken;
    const refreshed = await refreshTokens({
      spec: options.spec,
      refreshToken: stored.tokens.refreshToken,
      clientId: options.clientId,
      clientSecret: options.clientSecret ?? stored.clientSecret,
      fetchImpl: options.fetchImpl,
      previous: stored.tokens,
    });
    storeTokens(options.restaurantId, options.provider, refreshed, { accountLabel: stored.accountLabel, clientSecret: stored.clientSecret });
    return refreshed.accessToken;
  };
}

/** Best-effort server-side revocation, then forget the locally stored tokens. */
export async function disconnectProvider(options: {
  spec: OAuthSpec;
  provider: CloudProviderId;
  restaurantId: string;
  clientId: string;
  revokeEndpoint?: string | null;
  /** Some providers (Google) want the token in the query string. */
  revokeUsesQuery?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const stored = loadTokens(options.restaurantId, options.provider);
  if (options.revokeEndpoint && stored.tokens?.refreshToken) {
    await revokeToken({
      revokeEndpoint: options.revokeEndpoint,
      token: stored.tokens.refreshToken,
      clientId: options.clientId,
      clientSecret: stored.clientSecret,
      fetchImpl: options.fetchImpl,
      useQuery: options.revokeUsesQuery,
    });
  }
  forgetTokens(options.restaurantId, options.provider);
}

export function shouldRefresh(tokens: CloudTokens | null): boolean {
  if (!tokens?.accessToken) return true;
  if (!tokens.expiresAt) return false;
  return tokens.expiresAt - Date.now() < EXPIRY_SKEW_MS;
}
