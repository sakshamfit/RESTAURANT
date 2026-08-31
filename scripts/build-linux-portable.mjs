#!/usr/bin/env node
/**
 * Builds the NEXORAOSP RESTAURANT portable Linux desktop package.
 *
 *   node scripts/build-linux-portable.mjs
 *
 * Produces, in release/:
 *   nexoraosp-restaurant-<ver>-linux-x64.tar.gz   (portable — extract & run)
 *   nexoraosp-restaurant_<ver>_amd64.deb          (Debian/Ubuntu installer)
 *
 * The package bundles the production web app + the single-file Express
 * server and requires Node.js 18+ on the target machine (unlike the
 * Electron desktop build, which embeds its own runtime and is produced by
 * .github/workflows/desktop-release.yml). All data stays on the machine
 * that runs it (~/.nexoraosp-restaurant/data).
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, symlinkSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(rootDir, 'desktop');
const stageDir = path.join(desktopDir, 'app');
const portableDir = path.join(rootDir, 'portable');
const releaseDir = path.join(rootDir, 'release');
const version = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;
const pkgBase = `nexoraosp-restaurant-${version}-linux-x64`;
const buildDir = path.join(releaseDir, pkgBase);

function run(cmd, argv, opts = {}) {
  const result = spawnSync(cmd, argv, { cwd: opts.cwd ?? rootDir, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`\nCommand failed: ${cmd} ${argv.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

// 1. Ensure the web build + bundled server are staged
if (!existsSync(path.join(stageDir, 'server.cjs')) || !existsSync(path.join(stageDir, 'dist', 'index.html'))) {
  console.log('→ Staging desktop/app (web build + bundled server)');
  run('npx', ['tsx', 'scripts/build-desktop.mjs', '--stage-only']);
}

// 2. Assemble the package tree
console.log(`→ Assembling ${pkgBase}`);
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(path.join(buildDir, 'resources', 'dist'), { recursive: true });
mkdirSync(path.join(buildDir, 'resources', 'db'), { recursive: true });

cpSync(path.join(stageDir, 'server.cjs'), path.join(buildDir, 'resources', 'server.cjs'));
cpSync(path.join(stageDir, 'dist'), path.join(buildDir, 'resources', 'dist'), { recursive: true });
cpSync(path.join(rootDir, 'db', 'schema.sql'), path.join(buildDir, 'resources', 'db', 'schema.sql'));
copyFileSync(path.join(desktopDir, 'build', 'icon.png'), path.join(buildDir, 'resources', 'icon.png'));
copyFileSync(path.join(portableDir, 'launcher.cjs'), path.join(buildDir, 'launcher.cjs'));
copyFileSync(path.join(portableDir, 'nexoraosp-restaurant'), path.join(buildDir, 'nexoraosp-restaurant'));
copyFileSync(path.join(portableDir, 'nexoraosp-restaurant.desktop'), path.join(buildDir, 'nexoraosp-restaurant.desktop'));
copyFileSync(path.join(portableDir, 'install.sh'), path.join(buildDir, 'install.sh'));
chmodSync(path.join(buildDir, 'nexoraosp-restaurant'), 0o755);
chmodSync(path.join(buildDir, 'install.sh'), 0o755);

// 3. Portable tarball
console.log('→ Building portable tarball');
run('tar', ['-czf', path.join(releaseDir, `${pkgBase}.tar.gz`), '-C', releaseDir, pkgBase]);

// 4. Debian package (dpkg-deb needs no root)
console.log('→ Building .deb');
const debDir = path.join(releaseDir, `nexoraosp-restaurant_${version}_amd64`);
rmSync(debDir, { recursive: true, force: true });
const debRoot = path.join(debDir, 'opt', 'nexoraosp-restaurant');
cpSync(buildDir, debRoot, { recursive: true });
rmSync(path.join(debRoot, 'install.sh'), { force: true });
rmSync(path.join(debRoot, 'nexoraosp-restaurant.desktop'), { force: true });
mkdirSync(path.join(debDir, 'DEBIAN'), { recursive: true });
mkdirSync(path.join(debDir, 'usr', 'bin'), { recursive: true });
mkdirSync(path.join(debDir, 'usr', 'share', 'applications'), { recursive: true });
mkdirSync(path.join(debDir, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps'), { recursive: true });
writeFileSync(path.join(debDir, 'DEBIAN', 'control'), [
  'Package: nexoraosp-restaurant',
  'Version: 1.0.0',
  'Section: misc',
  'Priority: optional',
  'Architecture: amd64',
  'Depends: nodejs (>= 18)',
  'Maintainer: NEXORAOSP RESTAURANT <admin@nexoraosp.com>',
  'Description: NEXORAOSP RESTAURANT staff console',
  ' QR-based restaurant ordering with live order tracking, waiter call alerts,',
  ' customer reviews and a full admin dashboard. All data stays on this machine.',
  '',
].join('\n'));
writeFileSync(path.join(debDir, 'usr', 'share', 'applications', 'nexoraosp-restaurant.desktop'), [
  '[Desktop Entry]',
  'Version=1.0',
  'Type=Application',
  'Name=NEXORAOSP RESTAURANT',
  'GenericName=Restaurant Staff Console',
  'Comment=Live orders, waiter calls and menu management',
  'Exec=/opt/nexoraosp-restaurant/nexoraosp-restaurant',
  'Icon=nexoraosp-restaurant',
  'Terminal=false',
  'Categories=Office;Business;',
  'StartupNotify=false',
  '',
].join('\n'));
copyFileSync(path.join(desktopDir, 'build', 'icon.png'), path.join(debDir, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps', 'nexoraosp-restaurant.png'));
try {
  symlinkSync('/opt/nexoraosp-restaurant/nexoraosp-restaurant', path.join(debDir, 'usr', 'bin', 'nexoraosp-restaurant'));
} catch {
  copyFileSync(path.join(debRoot, 'nexoraosp-restaurant'), path.join(debDir, 'usr', 'bin', 'nexoraosp-restaurant'));
}
run('dpkg-deb', ['--build', '--root-owner-group', debDir, path.join(releaseDir, `nexoraosp-restaurant_${version}_amd64.deb`)]);
rmSync(debDir, { recursive: true, force: true });
rmSync(buildDir, { recursive: true, force: true });

console.log('\n✓ Linux desktop package ready in release/:');
console.log(`  ${pkgBase}.tar.gz`);
console.log(`  nexoraosp-restaurant_${version}_amd64.deb`);
