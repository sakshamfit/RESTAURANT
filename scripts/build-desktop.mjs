#!/usr/bin/env node
/**
 * Stages and packages the Nagori Chai Point desktop console.
 *
 *   node scripts/build-desktop.mjs               → stage + package (current OS)
 *   node scripts/build-desktop.mjs --win         → package Windows installer
 *   node scripts/build-desktop.mjs --linux       → package Linux AppImage/deb
 *   node scripts/build-desktop.mjs --stage-only  → just (re)build desktop/app/
 *
 * The desktop app is fully self-contained: a Vite web build + a single
 * esbuild-bundled Express server (app/server.cjs) are staged into desktop/app
 * and wrapped by Electron (desktop/main.cjs). No cloud services are required;
 * the app stores its data on the local machine.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(rootDir, 'desktop');
const stageDir = path.join(desktopDir, 'app');
const args = process.argv.slice(2);

const flags = ['--win', '--linux', '--mac', '--dir', '--publish'].filter((f) => args.includes(f));
const stageOnly = args.includes('--stage-only');
const skipBuild = args.includes('--skip-build');

function run(cmd, argv, opts = {}) {
  const result = spawnSync(cmd, argv, { cwd: opts.cwd ?? rootDir, stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    console.error(`\nCommand failed: ${cmd} ${argv.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

console.log('→ 1/4  Web build (Vite)');
if (!skipBuild) run('npx', ['vite', 'build']);

console.log('→ 2/4  Bundling the self-contained server');
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(path.join(stageDir, 'dist'), { recursive: true });
mkdirSync(path.join(stageDir, 'db'), { recursive: true });
run('npx', [
  'esbuild',
  'server.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node20',
  '--external:vite',
  '--external:pg-native',
  '--outfile=' + path.join(stageDir, 'server.cjs'),
]);

console.log('→ 3/4  Staging web assets and schema');
// Copy the browser build (index.html + assets) but not the node server bundle.
cpSync(path.join(rootDir, 'dist', 'index.html'), path.join(stageDir, 'dist', 'index.html'));
if (existsSync(path.join(rootDir, 'dist', 'assets'))) {
  cpSync(path.join(rootDir, 'dist', 'assets'), path.join(stageDir, 'dist', 'assets'), { recursive: true });
}
cpSync(path.join(rootDir, 'db', 'schema.sql'), path.join(stageDir, 'db', 'schema.sql'));

// Keep the desktop package version in lock-step with the root one.
const rootVersion = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;
const desktopPkgPath = path.join(desktopDir, 'package.json');
const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, 'utf8'));
if (desktopPkg.version !== rootVersion) {
  desktopPkg.version = rootVersion;
  writeFileSync(desktopPkgPath, JSON.stringify(desktopPkg, null, 2) + '\n');
  console.log(`   synced desktop version to ${rootVersion}`);
}

if (stageOnly) {
  console.log('✓ Staged desktop/app — run `npm --prefix desktop start` to launch it.');
  process.exit(0);
}

console.log('→ 4/4  Installing desktop toolchain and running electron-builder');
if (!existsSync(path.join(desktopDir, 'node_modules', '.bin'))) {
  run('npm', ['install', '--no-audit', '--no-fund'], { cwd: desktopDir });
}
run('npx', ['electron-builder', ...(flags.length ? flags : [])], { cwd: desktopDir });
console.log('\n✓ Desktop installers written to release/');
