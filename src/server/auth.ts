import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// ── Single admin account ────────────────────────────────────────────────────
// There is exactly one admin and exactly one password. Nothing cloud-based:
// credentials live in data/admin.json (scrypt-hashed), created on first start
// from ADMIN_PASSWORD (or the built-in default). It can also be changed from
// Admin → Café Settings → Update Password, which writes data/admin.json.
const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@nagoritea.com';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '9852120609@';
const DATA_DIR =
  process.env.DATA_DIR ||
  (process.env.VERCEL ? '/tmp/restaurant-data' : path.join(process.cwd(), 'data'));
const CREDENTIALS_FILE = path.join(DATA_DIR, 'admin.json');

type AdminCredential = {
  email: string;
  passwordHash: string;
  passwordSalt: string;
  updatedAt: string;
};

let cached: AdminCredential | null = null;
let persistent = true;

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function randomSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}

async function writeCredentials(credential: AdminCredential): Promise<void> {
  if (!persistent) return;
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmpPath = `${CREDENTIALS_FILE}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(credential, null, 2), 'utf8');
    await fs.promises.rename(tmpPath, CREDENTIALS_FILE);
  } catch (error) {
    persistent = false;
    console.warn('[auth] Credential file not writable; keeping password in memory.', (error as Error)?.message || error);
  }
}

/** Loads (or first-time creates) the credentials. Must be called once at startup. */
export async function initAdminAuth(): Promise<void> {
  if (cached) return;
  try {
    const raw = await fs.promises.readFile(CREDENTIALS_FILE, 'utf8');
    cached = JSON.parse(raw) as AdminCredential;
    if (!cached?.passwordHash || !cached?.passwordSalt) throw new Error('Invalid credential file.');
  } catch {
    const salt = randomSalt();
    cached = {
      email: DEFAULT_ADMIN_EMAIL,
      passwordHash: hashPassword(DEFAULT_ADMIN_PASSWORD, salt),
      passwordSalt: salt,
      updatedAt: new Date().toISOString(),
    };
    await writeCredentials(cached);
    console.log(`[auth] Created single admin account (${CREDENTIALS_FILE}).`);
  }
}

export function getAdminEmail(): string {
  return cached?.email || DEFAULT_ADMIN_EMAIL;
}

export function verifyAdminPassword(password: string): boolean {
  if (!cached || !password) return false;
  const given = Buffer.from(hashPassword(password, cached.passwordSalt), 'hex');
  const expected = Buffer.from(cached.passwordHash, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export async function changeAdminPassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; message: string }> {
  if (!verifyAdminPassword(currentPassword)) {
    return { ok: false, message: 'Current password is incorrect.' };
  }
  if (!newPassword || newPassword.length < 6) {
    return { ok: false, message: 'New password must be at least 6 characters.' };
  }
  const salt = randomSalt();
  cached = {
    ...(cached as AdminCredential),
    passwordHash: hashPassword(newPassword, salt),
    passwordSalt: salt,
    updatedAt: new Date().toISOString(),
  };
  await writeCredentials(cached as AdminCredential);
  return { ok: true, message: 'Password updated.' };
}

/** Stable HMAC key for admin session tokens. Survives restarts (data/admin.json). */
export function getAdminSessionSecret(): string {
  const envSecret = process.env.ADMIN_SESSION_SECRET || '';
  if (envSecret.length >= 16) return envSecret;
  return crypto
    .createHash('sha256')
    .update(`nagori-chai-admin-session-v2:${getAdminEmail()}`)
    .digest('hex');
}
