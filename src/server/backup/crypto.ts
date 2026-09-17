/**
 * Data-key resolution for encrypted backups.
 *
 * The AES-256 key is a random 32-byte value generated when the owner sets their
 * backup password; it is wrapped under scrypt(password) in the config and also
 * kept in the OS credential store, so an unattended 02:30 backup can encrypt
 * without anyone typing anything. The password itself is never stored, and the
 * key never enters a backup file or the cloud.
 */

import { createEncryptionConfig, keyMatchesPassword, loadBackupConfig, rewrapDataKey, unwrapDataKey, updateBackupConfig, type BackupEncryptionConfig } from '../backupConfig.js';
import { clearBackupDataKey, readBackupDataKey, saveBackupDataKey } from '../credentials.js';
import { BackupError } from './errors.js';
import type { AppSnapshot } from '../seed.js';

/** Resolves the data key: OS credential store first, else unwrap with password. */
export function resolveBackupDataKey(password?: string | null): { key: Buffer | null; source: 'keychain' | 'password' | 'none' } {
  const config = loadBackupConfig();
  const encryption = config.encryption;
  if (!encryption || encryption.mode !== 'password') return { key: null, source: 'none' };
  // A typed password is always checked, even when a key is cached: typing the
  // wrong one must never quietly succeed via the cache.
  if (password) {
    if (!keyMatchesPassword(encryption, password)) {
      throw new BackupError('That backup password does not match this installation.', 'password-mismatch', 401);
    }
    const cached = readBackupDataKey(config.restaurantId);
    if (cached) return { key: cached, source: 'keychain' };
    const key = encryption.wrappedKey ? unwrapDataKey(encryption, password) : null;
    if (key) {
      // Cache it in the OS store so unattended nightly backups can encrypt.
      saveBackupDataKey(config.restaurantId, key.toString('hex'));
      return { key, source: 'password' };
    }
    throw new BackupError('The stored backup key could not be unlocked with that password.', 'decrypt', 401);
  }
  const stored = readBackupDataKey(config.restaurantId);
  if (stored) return { key: stored, source: 'keychain' };
  throw new BackupError(
    'Backups are encrypted and this session has not unlocked the backup key yet. Enter your backup encryption password, then retry.',
    'password-required',
    401
  );
}

/**
 * Turning encryption on. The new data key is written to the config wrapped under
 * the password, and also cached in the OS credential store — without that cache a
 * 02:30 nightly backup could not encrypt anything, because nobody is there to type
 * the password. The password itself is never stored anywhere.
 */
export function enableBackupEncryption(password: string): { config: BackupEncryptionConfig; cached: boolean } {
  const created = createEncryptionConfig(password);
  updateBackupConfig((current) => ({ ...current, encryption: created.config }));
  const cached = saveBackupDataKey(loadBackupConfig().restaurantId, created.dataKey.toString('hex'));
  return { config: created.config, cached };
}

/**
 * Changing the password re-wraps the *same* data key. Re-randomising it instead
 * would leave every backup already written unreadable, which is the opposite of
 * what "change my backup password" means.
 */
export function changeBackupPassword(currentPassword: string, newPassword: string): { changed: boolean; cached: boolean; message: string } {
  const config = loadBackupConfig();
  if (!config.encryption || config.encryption.mode !== 'password') {
    throw new BackupError('Backup encryption is not on yet, so there is no password to change.', 'config', 400);
  }
  const rotated = rewrapDataKey(config.encryption, currentPassword, newPassword);
  if (!rotated) {
    throw new BackupError('That current password is not the one your backups are encrypted with.', 'password-mismatch', 401);
  }
  updateBackupConfig((current) => ({ ...current, encryption: rotated.config }));
  const cached = saveBackupDataKey(loadBackupConfig().restaurantId, rotated.dataKey.toString('hex'));
  return { changed: true, cached, message: 'Backup password changed. Existing backup files still open with this app; nothing was re-encrypted.' };
}

/**
 * Turning encryption off stops future encryption and forgets the cached key. It
 * never rewrites existing files: they stay encrypted (and stay restorable with the
 * password that protected them), which is the only honest meaning of "off".
 */
export function disableBackupPassword(password: string | null): { cleared: boolean; message: string } {
  const config = loadBackupConfig();
  if (!config.encryption || config.encryption.mode !== 'password') {
    throw new BackupError('Backup encryption is already off.', 'config', 400);
  }
  if (!keyMatchesPassword(config.encryption, String(password || ''))) {
    throw new BackupError('Enter your current backup password to turn encryption off.', 'password-mismatch', 401);
  }
  updateBackupConfig((current) => ({
    ...current,
    encryption: { mode: 'none', kdf: 'scrypt', salt: '', verifier: '', wrappedKey: null, updatedAt: new Date().toISOString() },
  }));
  clearBackupDataKey(config.restaurantId);
  return {
    cleared: true,
    message: 'Backup encryption is off for new backups. Existing encrypted files still need the old password to open, and cloud copies stop until it is on again.',
  };
}
