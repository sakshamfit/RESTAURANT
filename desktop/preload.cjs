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
});
