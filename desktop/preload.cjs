'use strict';

/**
 * The only bridge between the sandboxed renderer and the desktop shell.
 * Nothing else from Node or Electron is reachable from the web app.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nagoriDesktop', {
  isDesktop: true,
  /** App/platform metadata used by the admin "Desktop console" card. */
  getInfo: () => ipcRenderer.invoke('desktop:info'),
  /** Opens the folder that holds this machine's orders/menu database. */
  openDataFolder: () => ipcRenderer.invoke('desktop:open-data-folder'),
  /**
   * Returns a stable, opaque per-machine identifier used for license
   * binding. The renderer falls back to a localStorage-backed UUID in
   * the browser build (see services/license.ts) so the same code works
   * on both the desktop app and the web.
   */
  getMachineFingerprint: () => ipcRenderer.invoke('desktop:machine-fingerprint'),
});
