/** Bridge exposed by the packaged desktop app (see desktop/preload.cjs). */
export interface NagoriDesktopInfo {
  isDesktop: boolean;
  platform: string;
  arch: string;
  appVersion: string;
  electronVersion: string;
  serverPort: number | null;
  dataDir: string;
}

export interface NagoriDesktopBridge {
  isDesktop: boolean;
  getInfo: () => Promise<NagoriDesktopInfo>;
  /** Opens the folder holding this machine's local orders/menu data. */
  openDataFolder: () => Promise<string>;
}

declare global {
  interface Window {
    nagoriDesktop?: NagoriDesktopBridge;
  }
}

export {};
