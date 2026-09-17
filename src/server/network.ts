import os from 'os';

/**
 * Returns non-internal IPv4 addresses with priority sorting.
 * Physical adapters (en0, eth0, wlan0) first, virtual (docker, vmware, veth, etc) last.
 * Also prioritizes private LAN ranges: 192.168.x > 10.x > 172.16-31.x > others.
 */
export interface LanAddress {
  address: string;
  interface: string;
  priority: number;
}

export function getLanAddresses(): LanAddress[] {
  const interfaces = os.networkInterfaces();
  const out: LanAddress[] = [];
  const seen = new Set<string>();

  for (const name of Object.keys(interfaces)) {
    const infos = interfaces[name] || [];
    for (const info of infos) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (seen.has(info.address)) continue;
      // Skip link-local 169.254.x.x unless it's the only option
      // We'll still collect but give low priority
      seen.add(info.address);

      const isVirtual = /virtual|vmware|hyper-v|hyperv|docker|wsl|veth|tunnel|utun|tap|tun|loopback|pseudo|bridge|br-/i.test(name);
      const isLinkLocal = info.address.startsWith('169.254.');
      
      let rangePriority = 10;
      if (info.address.startsWith('192.168.')) rangePriority = 0;
      else if (info.address.startsWith('10.')) rangePriority = 1;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(info.address)) rangePriority = 2;
      else if (isLinkLocal) rangePriority = 100;

      // Combined priority: virtual adapters get +50, link-local +100, range priority matters
      const priority = (isVirtual ? 50 : 0) + rangePriority + (isLinkLocal ? 100 : 0);

      out.push({
        address: info.address,
        interface: name,
        priority,
      });
    }
  }

  out.sort((a, b) => a.priority - b.priority);
  return out;
}

export function buildLanUrls(port: number): Array<{ url: string; address: string; interface: string }> {
  return getLanAddresses().map((entry) => ({
    url: `http://${entry.address}:${port}`,
    address: entry.address,
    interface: entry.interface,
  }));
}

/**
 * Picks the best base URL for QR codes.
 * - If APP_URL env is set (e.g. https://mycafe.com or https://xyz.ngrok.io), use it.
 * - If DESKTOP_LAN_URLS env exists (from Electron main), use first entry.
 * - Otherwise compute from os.networkInterfaces() + current port.
 * - Fallback to request's origin if needed.
 */
export function getBestBaseUrl(opts: {
  port?: number;
  requestOrigin?: string;
  appUrlEnv?: string;
  desktopLanUrlsEnv?: string;
}): { baseUrl: string; lanUrls: Array<{ url: string; address: string; interface: string }>; source: string } {
  const port = opts.port || Number(process.env.PORT || 3000);
  const appUrl = opts.appUrlEnv || process.env.APP_URL || process.env.PUBLIC_URL || '';
  
  if (appUrl) {
    const cleaned = appUrl.replace(/\/$/, '');
    return {
      baseUrl: cleaned,
      lanUrls: buildLanUrls(port),
      source: 'APP_URL',
    };
  }

  // Desktop app passes LAN urls via env
  if (opts.desktopLanUrlsEnv || process.env.DESKTOP_LAN_URLS) {
    try {
      const raw = opts.desktopLanUrlsEnv || process.env.DESKTOP_LAN_URLS || '[]';
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.url) {
        return {
          baseUrl: parsed[0].url,
          lanUrls: parsed,
          source: 'DESKTOP_LAN_URLS',
        };
      }
    } catch {
      // ignore parse error
    }
  }

  const lanUrls = buildLanUrls(port);
  if (lanUrls.length > 0) {
    return {
      baseUrl: lanUrls[0].url,
      lanUrls,
      source: 'lan',
    };
  }

  // Fallback to request origin if it's not loopback, or to localhost as last resort
  if (opts.requestOrigin) {
    try {
      const u = new URL(opts.requestOrigin);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '::1') {
        return {
          baseUrl: opts.requestOrigin,
          lanUrls: [],
          source: 'request-origin',
        };
      }
    } catch {
      // ignore
    }
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    lanUrls: [],
    source: 'loopback-fallback',
  };
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '::ffff:127.0.0.1';
}
