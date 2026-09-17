/**
 * Resolves the best base URL for QR codes.
 * Priority:
 * 1. settings.qrBaseUrl / publicBaseUrl (admin-configured override)
 * 2. desktopInfo.lanUrls[0] (Electron desktop app)
 * 3. server network API bestBaseUrl (which already prefers LAN over loopback)
 * 4. window.location.origin if it's NOT loopback
 * 5. LAN URL from health/network if available
 * 6. Fallback to window.location.origin (loopback) with warning
 */

export interface NetworkInfo {
  port: number;
  localUrl: string;
  lanUrls: Array<{ url: string; address: string; interface: string }>;
  bestBaseUrl: string;
  baseSource: string;
  customBaseUrl?: string | null;
  requestOrigin?: string;
}

let cachedNetwork: NetworkInfo | null = null;
let cachedAt = 0;
const CACHE_TTL = 30_000;

export async function fetchNetworkInfo(force = false): Promise<NetworkInfo | null> {
  const now = Date.now();
  if (!force && cachedNetwork && now - cachedAt < CACHE_TTL) return cachedNetwork;
  try {
    const res = await fetch('/api/network', { cache: 'no-store' });
    if (!res.ok) throw new Error('network api failed');
    const data = (await res.json()) as NetworkInfo;
    cachedNetwork = data;
    cachedAt = now;
    return data;
  } catch {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) throw new Error('health failed');
      const data = await res.json();
      if (data.lanUrls || data.qrBaseUrl) {
        const info: NetworkInfo = {
          port: data.port || 3000,
          localUrl: data.localUrl || `http://127.0.0.1:${data.port || 3000}`,
          lanUrls: data.lanUrls || [],
          bestBaseUrl: data.qrBaseUrl || data.lanUrls?.[0]?.url || window.location.origin,
          baseSource: data.qrBaseSource || 'health',
          customBaseUrl: data.qrBaseUrl || null,
        };
        cachedNetwork = info;
        cachedAt = now;
        return info;
      }
    } catch {
      // ignore
    }
    return null;
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    const h = u.hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1' || h === '0.0.0.0';
  } catch {
    return false;
  }
}

/**
 * Given all possible sources, pick the best base URL for QR.
 */
export function pickBestQrBaseUrl(opts: {
  settingsQrBaseUrl?: string;
  desktopLanUrl?: string;
  desktopLocalUrl?: string;
  networkInfo?: NetworkInfo | null;
  windowOrigin?: string;
}): { baseUrl: string; source: string; isLoopback: boolean } {
  const windowOrigin = opts.windowOrigin || (typeof window !== 'undefined' ? window.location.origin : '');

  // 1. Settings override
  if (opts.settingsQrBaseUrl && opts.settingsQrBaseUrl.trim()) {
    const cleaned = opts.settingsQrBaseUrl.trim().replace(/\/$/, '');
    return { baseUrl: cleaned, source: 'settings.qrBaseUrl', isLoopback: isLoopbackOrigin(cleaned) };
  }

  // 2. Desktop LAN
  if (opts.desktopLanUrl) {
    return { baseUrl: opts.desktopLanUrl.replace(/\/$/, ''), source: 'desktop.lanUrls', isLoopback: isLoopbackOrigin(opts.desktopLanUrl) };
  }

  // 3. Network API bestBaseUrl
  if (opts.networkInfo?.bestBaseUrl) {
    const b = opts.networkInfo.bestBaseUrl.replace(/\/$/, '');
    // If bestBaseUrl is still loopback but we have lanUrls, prefer lan
    if (isLoopbackOrigin(b) && opts.networkInfo.lanUrls?.length) {
      return { baseUrl: opts.networkInfo.lanUrls[0].url.replace(/\/$/, ''), source: 'network.lanUrls', isLoopback: false };
    }
    return { baseUrl: b, source: `network.${opts.networkInfo.baseSource}`, isLoopback: isLoopbackOrigin(b) };
  }

  // 4. Network lanUrls directly
  if (opts.networkInfo?.lanUrls?.length) {
    return { baseUrl: opts.networkInfo.lanUrls[0].url.replace(/\/$/, ''), source: 'network.lanUrls', isLoopback: false };
  }

  // 5. Window origin if not loopback
  if (windowOrigin && !isLoopbackOrigin(windowOrigin)) {
    return { baseUrl: windowOrigin.replace(/\/$/, ''), source: 'window.origin', isLoopback: false };
  }

  // 6. Desktop localUrl as last resort before loopback window
  if (opts.desktopLocalUrl) {
    const isLoop = isLoopbackOrigin(opts.desktopLocalUrl);
    if (!isLoop) {
      return { baseUrl: opts.desktopLocalUrl.replace(/\/$/, ''), source: 'desktop.localUrl', isLoopback: false };
    }
  }

  // 7. Fallback to window origin (even if loopback) — we have to show something
  if (windowOrigin) {
    return { baseUrl: windowOrigin.replace(/\/$/, ''), source: 'window.origin (loopback fallback)', isLoopback: true };
  }

  return { baseUrl: 'http://127.0.0.1:3000', source: 'hardcoded-fallback', isLoopback: true };
}

export function buildOrderUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/order/${token}`;
}
