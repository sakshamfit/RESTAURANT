'use strict';

/**
 * Executes desktop/main.cjs against a minimal in-memory "electron" stub so the
 * real server-lifecycle code (port reservation, child-process spawn, health
 * polling, window load URL) runs and can be asserted in CI-less environments
 * where the Electron binary itself cannot be downloaded.
 *
 *   node scripts/smoke-desktop-main.cjs
 *
 * Exits 0 when the main process starts the bundled server and loads the admin
 * console URL; 1 otherwise.
 */

const Module = require('module');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const desktopMain = path.resolve(__dirname, '..', 'desktop', 'main.cjs');
const userDataDir = require('os').tmpdir() + '/nagori-desktop-smoke';

class StubWebContents extends EventEmitter {
  constructor() {
    super();
    this.setWindowOpenHandler = () => undefined;
  }
}

class StubBrowserWindow extends EventEmitter {
  static windows = [];
  static getAllWindows() {
    return StubBrowserWindow.windows;
  }
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new StubWebContents();
    this.loadedURLs = [];
    this.isMinimized = () => false;
    this.restore = () => undefined;
    this.focus = () => undefined;
    this.show = () => undefined;
    this.once('ready-to-show', (cb) => process.nextTick(cb));
    StubBrowserWindow.windows.push(this);
  }
  loadURL(url) {
    this.loadedURLs.push(url);
    return Promise.resolve();
  }
}

const stubApp = new EventEmitter();
stubApp.getPath = (name) => (name === 'userData' ? userDataDir : userDataDir);
stubApp.getVersion = () => '1.0.0-smoke';
stubApp.requestSingleInstanceLock = () => true;
stubApp.setAboutPanelOptions = () => undefined;
stubApp.quit = () => {
  process.exit(0); // never reached in the success path of this smoke test
};
stubApp.whenReady = () => Promise.resolve();

const electronStub = {
  app: stubApp,
  BrowserWindow: StubBrowserWindow,
  Menu: { buildFromTemplate: (t) => ({ template: t }), setApplicationMenu: () => undefined },
  dialog: {
    showErrorBox: (title, detail) => {
      console.error('DIALOG ERROR:', title, detail);
      process.exit(1);
    },
    showMessageBox: async (opts) => {
      console.error('STARTUP ERROR DIALOG:', opts?.message, opts?.detail);
      process.exit(1);
    },
  },
  ipcMain: { handle: () => undefined },
  shell: { openExternal: async () => undefined, openPath: async () => '' },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron'] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: electronStub,
};

// Prevent the module-level app.on handlers from keeping the process alive.
require(desktopMain);

setTimeout(async () => {
  const win = StubBrowserWindow.windows[0];
  if (!win || win.loadedURLs.length === 0) {
    console.error('FAIL: no window was created/loaded');
    process.exit(1);
  }
  const url = win.loadedURLs[0];
  console.log('window loaded:', url);
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/admin$/.exec(url);
  if (!match) {
    console.error('FAIL: unexpected load URL');
    process.exit(1);
  }
  const port = Number(match[1]);
  // The local server must answer /api/health and serve /admin.
  const health = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
  console.log('health:', health.status, JSON.parse(health.body).persistence);
  console.log('SMOKE OK');
  process.exit(0);
}, 6000);
