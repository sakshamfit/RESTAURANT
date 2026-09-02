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

const flags = ['--win', '--linux', '--mac', '--dir'].filter((f) => args.includes(f));
// `--publish never|always|onTag` is passed through with its value (a bare
// `--publish` alone would make electron-builder try to publish to GitHub).
const publishIndex = args.indexOf('--publish');
const publishArgs =
  publishIndex >= 0 ? ['--publish', args[publishIndex + 1] === 'never' || args[publishIndex + 1] === 'always' || args[publishIndex + 1] === 'onTag' ? args[publishIndex + 1] : 'never'] : [];
const stageOnly = args.includes('--stage-only');
const skipBuild = args.includes('--skip-build');

// On Windows, npm/npx are .cmd shims, so these must run through a shell.
// Arguments are quoted so paths containing spaces survive the shell.
function quoteArg(arg) {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

function run(cmd, argv, opts = {}) {
  const result = spawnSync(cmd, argv.map(quoteArg), {
    cwd: opts.cwd ?? rootDir,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    const why = result.error ? ` (${result.error.message})` : '';
    console.error(`\nCommand failed: ${cmd} ${argv.join(' ')}${why}`);
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

console.log('→ 3/4  Staging web assets, schema and build settings');
// Copy the browser build (index.html + assets) but not the node server bundle.
cpSync(path.join(rootDir, 'dist', 'index.html'), path.join(stageDir, 'dist', 'index.html'));
if (existsSync(path.join(rootDir, 'dist', 'assets'))) {
  cpSync(path.join(rootDir, 'dist', 'assets'), path.join(stageDir, 'dist', 'assets'), { recursive: true });
}
cpSync(path.join(rootDir, 'db', 'schema.sql'), path.join(stageDir, 'db', 'schema.sql'));

// ── Bake vendor / license configuration into the staged app ─────────────────
// The packaged app cannot see the environment of the machine that BUILT the
// installer (env vars are not embedded by electron-builder), so the
// distribution settings — the license gate, the license-server URL, the
// signing secret, and the admin password/email — are written into
// desktop/app/build-env.json. desktop/main.cjs merges this file into the
// bundled server's environment on every launch. The file lives in the
// git-ignored desktop/app/ staging folder and only ever ships inside the
// installer; the signing secret must match the license server's
// LICENSE_SIGNING_SECRET exactly or activations fail with a signature error.
const BAKE_KEYS = [
  'LICENSE_REQUIRED',
  'LICENSE_API_BASE',
  'LICENSE_PUBLIC_KEY',
  'LICENSE_SIGNING_SECRET',
  'LICENSE_ALLOW_SELF_ISSUE',
  'LICENSE_TRIAL_DAYS',
  'ADMIN_PASSWORD',
  'ADMIN_EMAIL',
  'ADMIN_SESSION_SECRET',
  'DATABASE_URL',
  'DIRECT_URL',
];
const baked = {};
for (const key of BAKE_KEYS) {
  const value = process.env[key];
  if (value !== undefined && value !== '') baked[key] = value;
}
// Distributed builds verify license JWTs with the RSA PUBLIC key only; the
// private key never leaves the license server. The public key ships with
// the repo (license-keys/public.pem) so CI needs no secret at all. Explicit
// LICENSE_PUBLIC_KEY env (with literal \n escapes) still wins.
if (baked.LICENSE_REQUIRED === 'true' && !baked.LICENSE_PUBLIC_KEY) {
  const publicKeyPath = path.join(rootDir, 'license-keys', 'public.pem');
  if (existsSync(publicKeyPath)) {
    baked.LICENSE_PUBLIC_KEY = readFileSync(publicKeyPath, 'utf8').trim();
  }
}
writeFileSync(path.join(stageDir, 'build-env.json'), JSON.stringify(baked, null, 2) + '\n');
if (baked.LICENSE_REQUIRED === 'true') {
  console.log(`   baked license gate: REQUIRED, API=${baked.LICENSE_API_BASE || '(unset!)'}, trial=${baked.LICENSE_TRIAL_DAYS ?? '14'}d, self-issue=${baked.LICENSE_ALLOW_SELF_ISSUE || 'false'}`);
  if (!baked.LICENSE_PUBLIC_KEY) {
    console.error('   ⚠ LICENSE_REQUIRED=true but no license public key — set LICENSE_PUBLIC_KEY or keep license-keys/public.pem in the repo. The app could not verify license tokens. Aborting.');
    process.exit(1);
  }
  if (baked.LICENSE_SIGNING_SECRET) {
    console.warn('   ⚠ LICENSE_SIGNING_SECRET is set — prefer the RSA public key (license-keys/public.pem) so the installer never contains a signing secret.');
  }
} else {
  console.log('   license gate not enabled (LICENSE_REQUIRED is not "true") — this installer is an open build.');
}

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
run('npx', ['electron-builder', ...flags, ...publishArgs], { cwd: desktopDir });
console.log('\n✓ Desktop installers written to release/');
