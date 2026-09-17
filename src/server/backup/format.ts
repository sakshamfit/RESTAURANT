/**
 * The `.rdbak` container. A short plaintext envelope (metadata needed to
 * locate/verify a backup without any key) followed by the stored payload:
 *
 *   RDBAK1 | uint16 headerLen | header JSON | blob = gzip(payload) [AES-256-GCM]
 *
 * A binary envelope rather than a JSON text file keeps compression/encryption
 * intact, avoids base64 inflation on the customer's cloud quota, and lets a
 * damaged file be detected from its own metadata before anything is decrypted.
 *
 * Integrity: `header.checksum = sha256(blob)`, `header.contentSha256 =
 * sha256(payload)`. When encrypted, the header is also the GCM AAD, so editing a
 * size, a count or the restaurant id in the envelope is a decryption failure
 * instead of a silently restored lie.
 */

import crypto from 'crypto';
import fs from 'fs';
import zlib from 'zlib';
import type { AppSnapshot } from '../seed.js';
import { BackupError } from './errors.js';
import { applicationVersion, assertSizeLimit, MAX_BACKUP_BYTES, MAX_DECODED_BYTES, scrubSecrets, sha256, validateSnapshot } from './integrity.js';
import { BACKUP_FORMAT_VERSION, BACKUP_MAGIC, BackupHeader, BackupPayload } from './types.js';

export const GCM_IV_BYTES = 12;

export const GCM_TAG_BYTES = 16;

/** Magic + uint16 header length: the fixed part of every container. */
const HEADER_LEAD_BYTES = BACKUP_MAGIC.length + 2;


export interface Container {
  header: BackupHeader;
  headerBytes: Buffer;
  blob: Buffer;
}

/**
 * Key-sorted JSON, used only to derive the authenticated-metadata bytes that
 * go into AES-GCM as AAD. Both sides of the format can rebuild it from the
 * header alone, so the header's actual serialization stays free to change.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * The part of the header the ciphertext authenticates: everything except the
 * two digest fields, which cannot exist before the bytes they cover do.
 */

/**
 * The part of the header the ciphertext authenticates: everything except the
 * two digest fields, which cannot exist before the bytes they cover do.
 */
export function authMaterial(header: BackupHeader): Buffer {
  // Round-tripped through JSON on purpose: `JSON.stringify` drops `undefined`
  // values, and the header read back from disk has those keys absent entirely.
  // Canonicalising both sides the same way is what keeps the AAD stable — an
  // earlier draft hashed `note: undefined` on write and `note` (absent) on
  // read, which made every un-noted backup fail its own verification.
  const normalized = JSON.parse(JSON.stringify({ ...header, contentSha256: '', checksum: '' })) as BackupHeader;
  return Buffer.from(canonicalize(normalized), 'utf8');
}

/**
 * Keys whose values must never reach a backup file. Backups are copied into
 * whoever's cloud account is connected and sometimes onto a brand-new machine,
 * so connection secrets belong to the installation, not to the business data.
 * (DATABASE_URL, the JWT secret and OAuth material never live in the store at
 * all — this also catches `settings.whatsappApiToken` and anything similar.)
 */

export function buildContainer(header: BackupHeader, blob: Buffer): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  if (headerBytes.length > 0xffff) throw new BackupError('Backup header is unexpectedly large.', 'format', 500);
  const lengthPrefix = Buffer.allocUnsafe(2);
  lengthPrefix.writeUInt16BE(headerBytes.length, 0);
  return Buffer.concat([Buffer.from(BACKUP_MAGIC, 'ascii'), lengthPrefix, headerBytes, blob]);
}

export function parseContainer(buffer: Buffer): Container {
  const magicLength = BACKUP_MAGIC.length;
  if (!buffer || buffer.length < magicLength + 2) throw new BackupError('Backup file is truncated.', 'corrupt');
  if (buffer.subarray(0, magicLength).toString('ascii') !== BACKUP_MAGIC) {
    throw new BackupError('This is not a NEXORAOSP RESTAURANT backup (.rdbak) file.', 'format');
  }
  const headerLength = buffer.readUInt16BE(magicLength);
  const headerStart = magicLength + 2;
  if (buffer.length < headerStart + headerLength) throw new BackupError('Backup file is truncated.', 'corrupt');
  const headerBytes = buffer.subarray(headerStart, headerStart + headerLength);
  let header: BackupHeader;
  try {
    header = JSON.parse(headerBytes.toString('utf8')) as BackupHeader;
  } catch {
    throw new BackupError('Backup header could not be parsed — the file is damaged.', 'corrupt');
  }
  if (header.backupVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      `Backup format v${header.backupVersion} cannot be read by this version (it understands v${BACKUP_FORMAT_VERSION}).`,
      'version'
    );
  }
  return { header, headerBytes, blob: buffer.subarray(headerStart + headerLength) };
}

/**
 * COMPRESS → ENCRYPT → HASH. `dataKey` (32 bytes) is resolved by the caller;
 * when it is null the archive is stored unencrypted, which is fine for the
 * local folder and refused for cloud upload by backupProtection.ts.
 */

/**
 * COMPRESS → ENCRYPT → HASH. `dataKey` (32 bytes) is resolved by the caller;
 * when it is null the archive is stored unencrypted, which is fine for the
 * local folder and refused for cloud upload by backupProtection.ts.
 */
export function encodeBackup(snapshot: AppSnapshot, meta: Omit<BackupHeader,
  'backupVersion' | 'applicationVersion' | 'payloadBytes' | 'archiveBytes' | 'cipherBytes' | 'contentSha256' | 'checksum' | 'encryption' | 'scrubbedSecretFields'
>, dataKey: Buffer | null): { buffer: Buffer; header: BackupHeader } {
  const { value: cleanSnapshot, removed } = scrubSecrets(snapshot);
  const payload = Buffer.from(JSON.stringify(cleanSnapshot), 'utf8');
  const archive = zlib.gzipSync(payload, { level: 9 });
  if (archive.length > MAX_BACKUP_BYTES) {
    throw new BackupError('The restaurant data is too large for one backup file — reduce history or split the store.', 'size', 413);
  }

  const header: BackupHeader = {
    ...meta,
    backupVersion: BACKUP_FORMAT_VERSION,
    applicationVersion: applicationVersion(),
    payloadBytes: payload.length,
    archiveBytes: archive.length,
    cipherBytes: archive.length,
    contentSha256: '',
    checksum: '',
    encryption: { mode: 'none' },
    scrubbedSecretFields: removed,
  };

  let blob = archive;
  if (dataKey) {
    if (dataKey.length !== 32) throw new BackupError('Backup data key must be 32 bytes.', 'encrypt', 500);
    const iv = crypto.randomBytes(GCM_IV_BYTES);
    header.encryption = { mode: 'aes-256-gcm', kdf: 'scrypt-wrapped-key', iv: iv.toString('base64') };
    header.cipherBytes = archive.length + GCM_TAG_BYTES;
    // AAD = the authenticated header material, so editing sizes, counts,
    // timestamps or the restaurant id in the plaintext envelope is a decryption
    // failure rather than a silently restored lie.
    const aad = authMaterial(header);
    const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(archive), cipher.final()]);
    blob = Buffer.concat([encrypted, cipher.getAuthTag()]);
  }

  header.contentSha256 = sha256(payload);
  header.checksum = sha256(blob);

  return { buffer: buildContainer(header, blob), header };
}

/** Resolves the data key: OS credential store first, else unwrap with password. */

/** VERIFY: hash → decrypt → decompress → hash → structural revalidation. */
export function decodeBackup(buffer: Buffer, dataKey: Buffer | null): BackupPayload {
  // Ceiling before parsing: a backup bigger than this is either not a backup or a
  // corrupted length field, and parseContainer would happily trust both.
  assertSizeLimit(buffer.length, MAX_BACKUP_BYTES, 'backup file');
  const { header, blob } = parseContainer(buffer);
  if (blob.length !== header.cipherBytes) {
    throw new BackupError('Backup is incomplete: the stored data does not match the recorded size.', 'corrupt');
  }
  if (sha256(blob) !== header.checksum) {
    throw new BackupError('Backup checksum mismatch — this file was altered or damaged. Nothing on this computer was changed.', 'checksum');
  }
  let archive = blob;
  if (header.encryption.mode === 'aes-256-gcm') {
    if (!dataKey) throw new BackupError('This backup is encrypted. Enter your backup encryption password to open it.', 'password-required', 401);
    if (blob.length <= GCM_TAG_BYTES) throw new BackupError('Encrypted backup is truncated.', 'corrupt');
    const cipherText = blob.subarray(0, blob.length - GCM_TAG_BYTES);
    const tag = blob.subarray(blob.length - GCM_TAG_BYTES);
    let plain: Buffer;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(header.encryption.iv || '', 'base64'));
      decipher.setAuthTag(tag);
      decipher.setAAD(authMaterial(header));
      plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    } catch {
      throw new BackupError('Decryption failed: wrong password, or the file was modified after it was written.', 'decrypt');
    }
    archive = plain;
  } else if (dataKey && header.encryption.mode === 'none') {
    // Allowed on purpose: unencrypted local backups stay readable forever.
  }

  let payload: Buffer;
  try {
    // maxOutputLength is the zip-bomb guard: a 4 MB file must not be able to ask
    // for gigabytes of RAM on a restaurant till.
    payload = zlib.gunzipSync(archive, { maxOutputLength: MAX_DECODED_BYTES });
  } catch (error) {
    if ((error as Error)?.message?.includes('maxOutputLength')) {
      throw new BackupError(`Backup expands to more than ${Math.round(MAX_DECODED_BYTES / 1024 / 1024)} MB, which this app will not restore.`, 'size', 413);
    }
    throw new BackupError('Backup data could not be decompressed — the file is damaged.', 'corrupt');
  }
  if (sha256(payload) !== header.contentSha256) {
    throw new BackupError('Backup content hash mismatch — restoring it would load wrong data, so it was refused.', 'content-hash');
  }
  let snapshot: AppSnapshot;
  try {
    snapshot = JSON.parse(payload.toString('utf8')) as AppSnapshot;
  } catch {
    throw new BackupError('Backup payload is not valid JSON.', 'corrupt');
  }
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) throw new BackupError(`Backup failed validation: ${validation.problems.join(' ')}`, 'validate');
  return { header, snapshot };
}

/** Read only the plaintext header of a buffer. Never throws — callers use it on
 * files they have no reason to trust yet (listing, cloud verification). */
export function peekHeader(buffer: Buffer): BackupHeader | null {
  try {
    return parseContainer(buffer).header;
  } catch {
    return null;
  }
}

/**
 * Read the header of a file from disk without touching the payload: 6 magic
 * bytes, a 2-byte length, then at most that many bytes of JSON. Used to verify a
 * download against the manifest before an encrypted file is ever decrypted, and
 * to confirm the restaurant identity of a backup on a new computer.
 */
export function peekHeaderFromFile(file: string): BackupHeader | null {
  let handle: number | null = null;
  try {
    handle = fs.openSync(file, 'r');
    const lead = Buffer.alloc(HEADER_LEAD_BYTES);
    if (fs.readSync(handle, lead, 0, lead.length, 0) !== lead.length) return null;
    if (lead.subarray(0, BACKUP_MAGIC.length).toString('latin1') !== BACKUP_MAGIC) return null;
    const headerLength = lead.readUInt16BE(BACKUP_MAGIC.length);
    if (headerLength <= 0 || headerLength > MAX_BACKUP_BYTES) return null;
    const raw = Buffer.alloc(headerLength);
    if (fs.readSync(handle, raw, 0, headerLength, HEADER_LEAD_BYTES) !== headerLength) return null;
    const header = JSON.parse(raw.toString('utf8')) as BackupHeader;
    if (typeof header.backupVersion !== 'number' || typeof header.createdAt !== 'string') return null;
    return header;
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* already closed */
      }
    }
  }
}
