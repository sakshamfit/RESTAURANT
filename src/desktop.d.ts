/** Bridge exposed by the packaged desktop app (see desktop/preload.cjs). */
export interface NagoriDesktopInfo {
  isDesktop: boolean;
  platform: string;
  arch: string;
  appVersion: string;
  electronVersion: string;
  serverPort: number | null;
  dataDir: string;
  /** Loopback URL the staff window is loaded from. */
  localUrl: string | null;
  /**
   * Every LAN IPv4 the bundled server is also listening on. Customer phones
   * on the same Wi-Fi open the menu at the first one — the printed QR codes
   * point at this address.
   */
  lanUrls: Array<{ url: string; address: string; interface: string }>;
}

export interface NagoriDesktopBridge {
  isDesktop: boolean;
  getInfo: () => Promise<NagoriDesktopInfo>;
  /** Opens the folder holding this machine's local orders/menu data. */
  openDataFolder: () => Promise<string>;
  /** Stable per-machine identifier used to bind a license. */
  getMachineFingerprint: () => Promise<string>;
  /**
   * Auto-update. `getUpdateState` returns a snapshot (no UI); the
   * `checkForUpdates` call shows the same native dialog as the
   * Console → Check for updates menu item, so the renderer can offer
   * "Check for updates" buttons anywhere it wants.
   */
  getUpdateState: () => Promise<{ available: boolean; currentVersion?: string; latestVersion?: string; reason?: string; error?: string }>;
  checkForUpdates: () => Promise<void>;
}

declare global {
  interface Window {
    nagoriDesktop?: NagoriDesktopBridge;
  }
}

export {};
