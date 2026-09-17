import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { replaceFile } from './atomicFile.js';
import crypto from 'crypto';
import { dataDir } from './backupConfig.js';

/**
 * Secure storage for cloud-provider credentials (OAuth refresh tokens, access
 * tokens, and — only when the owner supplied one — an OAuth client secret).
 *
 * Priority, highest first:
 *   1. macOS keychain          (`security` CLI, per-user, encrypted at rest)
 *   2. Windows DPAPI           (CurrentUser scope, machine+user bound)
 *   3. Secret Service          (`secret-tool`, GNOME/KWallet)
 *   4. 0600 file next to the data dir — LAST resort, reported as not secure.
 *
 * Hard rules this module exists to enforce:
 *   • tokens never go into data/restaurant.json (they would be copied into
 *     every backup and into the business database),
 *   • tokens never go into localStorage (the renderer must not be able to read
 *     or exfiltrate them — the UI only ever sees `credentialStore` metadata),
 *   • secrets are never written to stdout/stderr or returned by an API route.
 *
 * All calls are synchronous and small: they run from the local Express process
 * during connect/refresh, never per request.
 */

export interface CloudCredential {
  accessToken?: string | null;
  /** ISO timestamp; `refreshToken` is what actually survives a restart. */
  expiresAt?: string | null;
  refreshToken?: string | null;
  scope?: string | null;
  accountLabel?: string | null;
  /** Only for providers whose client is confidential (Google web credentials). */
  clientSecret?: string | null;
  /** Raw code-verifier etc. kept for the lifetime of one connect attempt. */
  extra?: Record<string, string> | null;
}

export type CredentialBackendKind = 'keychain' | 'dpapi' | 'secret-service' | 'file' | 'none';

export interface CredentialBackendInfo {
  kind: CredentialBackendKind;
  /** true when the OS keeps the secret encrypted under the user's login. */
  secure: boolean;
  detail: string;
}

const SERVICE_NAME = 'com.nexoraosp.restaurant.backup';
const SECRET_TOOL_SERVICE = 'nexoraosp-restaurant-backup';

function fileBackendDir(): string {
  return path.join(dataDir(), 'cloud-credentials');
}

function entryName(provider: string, restaurantId: string): string {
  return `${provider}__${restaurantId}`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function run(cmd: string, args: string[], input?: string): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  try {
    const res = spawnSync(cmd, args, {
      encoding: 'utf8',
      input,
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    if (res.error) return { ok: false, stdout: '', stderr: String((res.error as Error).message), status: -1 };
    return { ok: res.status === 0, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim(), status: res.status };
  } catch (error) {
    // A missing binary must never take the POS down — degrade to the fallback.
    return { ok: false, stdout: '', stderr: (error as Error)?.message || String(error), status: -1 };
  }
}

function isDarwin() {
  return process.platform === 'darwin';
}
function isWin32() {
  return process.platform === 'win32';
}

const POWERSHELL_PROTECT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Security
$raw = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($raw)
$entropy = [Text.Encoding]::UTF8.GetBytes('nexoraosp-restaurant-backup-v1')
if ($env:NEXORA_CRED_ENTROPY) { $entropy = [Convert]::FromBase64String($env:NEXORA_CRED_ENTROPY) }
$out = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($out)
`;

let cachedBackend: CredentialBackendKind | null = null;

/**
 * Probes once per process which secure store this machine actually has. A
 * keychain/Secret Service can also be present-but-unusable (locked keychain,
 * headless session with no bus), so the probe writes+reads+deletes a canary.
 */
export function detectBackend(): CredentialBackendKind {
  if (cachedBackend) return cachedBackend;
  const probeKey = '__probe__';
  if (isDarwin()) {
    const write = run('security', ['add-generic-password', '-U', '-a', probeKey, '-s', SERVICE_NAME, '-w', 'probe']);
    const read = run('security', ['find-generic-password', '-a', probeKey, '-s', SERVICE_NAME, '-w']);
    run('security', ['delete-generic-password', '-a', probeKey, '-s', SERVICE_NAME]);
    if (write.ok && read.ok && read.stdout === 'probe') return (cachedBackend = 'keychain');
  }
  if (isWin32()) {
    // DPAPI through PowerShell: no external dependency, user-scoped, and the
    // ciphertext is useless to another machine or another Windows user.
    const res = powershell(POWERSHELL_PROTECT, JSON.stringify({ probe: true }));
    if (res.ok && /^[A-Za-z0-9+/=]+$/.test(res.stdout)) return (cachedBackend = 'dpapi');
  }
  if (!isWin32() && !isDarwin()) {
    const write = run('secret-tool', ['store', '--label=NEXORAOSP Restaurant backup', 'service', SECRET_TOOL_SERVICE, 'account', probeKey], 'probe\n');
    const read = run('secret-tool', ['lookup', 'service', SECRET_TOOL_SERVICE, 'account', probeKey]);
    run('secret-tool', ['clear', 'service', SECRET_TOOL_SERVICE, 'account', probeKey]);
    if (write.ok && read.ok && read.stdout === 'probe') return (cachedBackend = 'secret-service');
  }
  return (cachedBackend = 'file');
}

export function credentialBackendInfo(): CredentialBackendInfo {
  const kind = detectBackend();
  switch (kind) {
    case 'keychain':
      return { kind, secure: true, detail: 'macOS Keychain' };
    case 'dpapi':
      return { kind, secure: true, detail: 'Windows credential store (DPAPI, current user)' };
    case 'secret-service':
      return { kind, secure: true, detail: 'OS secret service (GNOME Keyring / KWallet)' };
    case 'file':
      return {
        kind,
        secure: false,
        detail: `Encrypted local file not available — tokens are kept in ${fileBackendDir()} with owner-only (0600) permissions`,
      };
    default:
      return { kind: 'none', secure: false, detail: 'No credential store available' };
  }
}


const POWERSHELL_UNPROTECT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Security
$raw = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($raw.Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('nexoraosp-restaurant-backup-v1')
if ($env:NEXORA_CRED_ENTROPY) { $entropy = [Convert]::FromBase64String($env:NEXORA_CRED_ENTROPY) }
$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Text.Encoding]::UTF8.GetString($plain)
`;

/**
 * Extra entropy for DPAPI, generated once per installation and kept beside the
 * ciphertext with owner-only permissions: a stolen credential file alone (e.g.
 * copied off the machine, or restored by ransomware) is not decryptable.
 */
function entropyBytes(): string | null {
  const file = path.join(dataDir(), '.credential-entropy');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first use */
  }
  const value = crypto.randomBytes(32).toString('base64');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 });
    return value;
  } catch {
    return null;
  }
}

function powershell(script: string, input: string): { ok: boolean; stdout: string } {
  const entropy = entropyBytes();
  try {
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      input,
      timeout: 20000,
      windowsHide: true,
      // Entropy travels as an env var, never as an argv entry, so it cannot be
      // read out of a process listing by another account on the machine.
      env: entropy ? { ...process.env, NEXORA_CRED_ENTROPY: entropy } : process.env,
    });
    if (res.status !== 0) return { ok: false, stdout: '' };
    return { ok: true, stdout: (res.stdout || '').trim() };
  } catch {
    return { ok: false, stdout: '' };
  }
}

function filePath(provider: string, restaurantId: string): string {
  return path.join(fileBackendDir(), `${entryName(provider, restaurantId)}.json`);
}

function writeFallback(payload: string, target: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(path.dirname(target), 0o700);
  replaceFile(tmp, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
}

export function saveCredential(provider: string, restaurantId: string, credential: CloudCredential): { ok: boolean; backend: CredentialBackendInfo } {
  const payload = JSON.stringify(credential);
  const account = entryName(provider, restaurantId);
  const backend = detectBackend();
  try {
    if (backend === 'keychain') {
      const res = run('security', ['add-generic-password', '-U', '-a', account, '-s', SERVICE_NAME, '-w', payload]);
      if (res.ok) return { ok: true, backend: credentialBackendInfo() };
      console.warn('[backup] Keychain write failed, falling back to the protected file:', res.stderr);
    } else if (backend === 'secret-service') {
      const res = run('secret-tool', ['store', '--label=NEXORAOSP Restaurant cloud backup', 'service', SECRET_TOOL_SERVICE, 'account', account], `${payload}\n`);
      if (res.ok) return { ok: true, backend: credentialBackendInfo() };
      console.warn('[backup] Secret Service write failed, falling back to the protected file:', res.stderr);
    } else if (backend === 'dpapi') {
      const res = powershell(POWERSHELL_PROTECT, payload);
      if (res.ok && res.stdout) {
        writeFallback(JSON.stringify({ v: 1, dpapi: res.stdout }), filePath(provider, restaurantId));
        return { ok: true, backend: credentialBackendInfo() };
      }
      console.warn('[backup] DPAPI protection failed, falling back to the protected file.');
    }
    writeFallback(payload, filePath(provider, restaurantId));
    return { ok: true, backend: credentialBackendInfo() };
  } catch (error) {
    console.error('[backup] Could not persist cloud credentials:', (error as Error)?.message || error);
    return { ok: false, backend: credentialBackendInfo() };
  }
}

export function readCredential(provider: string, restaurantId: string): CloudCredential | null {
  const account = entryName(provider, restaurantId);
  const backend = detectBackend();
  let raw: string | null = null;
  try {
    if (backend === 'keychain') {
      const res = run('security', ['find-generic-password', '-a', account, '-s', SERVICE_NAME, '-w']);
      if (res.ok && res.stdout) raw = res.stdout;
    } else if (backend === 'secret-service') {
      const res = run('secret-tool', ['lookup', 'service', SECRET_TOOL_SERVICE, 'account', account]);
      if (res.ok && res.stdout) raw = res.stdout;
    } else if (backend === 'dpapi') {
      const stored = fs.readFileSync(filePath(provider, restaurantId), 'utf8');
      const parsed = JSON.parse(stored) as { dpapi?: string };
      if (parsed?.dpapi) {
        const res = powershell(POWERSHELL_UNPROTECT, parsed.dpapi);
        if (res.ok && res.stdout) raw = res.stdout;
      }
    }
    if (raw === null) {
      raw = fs.readFileSync(filePath(provider, restaurantId), 'utf8');
    }
    return JSON.parse(raw) as CloudCredential;
  } catch {
    return null;
  }
}

export function clearCredential(provider: string, restaurantId: string): void {
  const account = entryName(provider, restaurantId);
  const backend = detectBackend();
  if (backend === 'keychain') run('security', ['delete-generic-password', '-a', account, '-s', SERVICE_NAME]);
  else if (backend === 'secret-service') run('secret-tool', ['clear', 'service', SECRET_TOOL_SERVICE, 'account', account]);
  try {
    fs.rmSync(filePath(provider, restaurantId), { force: true });
  } catch {
    /* nothing stored */
  }
}

// ── backup data key ──────────────────────────────────────────────────────────
// The AES key that encrypts backups is a random 256-bit value, wrapped under
// the owner's password in the backup config (so the password can be rotated or
// re-entered) and ALSO kept here, so an unattended 02:30 backup can encrypt
// without anyone typing anything. The plaintext password is never stored, and
// the key never travels to the cloud or into a backup file.

const DATA_KEY_PROVIDER = 'backup-data-key';

export function saveBackupDataKey(restaurantId: string, keyHex: string): boolean {
  return saveCredential(DATA_KEY_PROVIDER, restaurantId, { extra: { dataKey: keyHex } }).ok;
}

export function readBackupDataKey(restaurantId: string): Buffer | null {
  const stored = readCredential(DATA_KEY_PROVIDER, restaurantId);
  const value = typeof stored?.extra?.dataKey === 'string' ? stored.extra.dataKey : '';
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return Buffer.from(value, 'hex');
}

export function clearBackupDataKey(restaurantId: string): void {
  clearCredential(DATA_KEY_PROVIDER, restaurantId);
}
