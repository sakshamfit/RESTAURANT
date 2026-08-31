/**
 * Mints license keys in the format NEX-XXXX-XXXX-XXXX. The X chars come
 * from an unambiguous alphabet (no 0/O/1/I) so they can be read off
 * paper / over the phone without a 2nd guess.
 */
import { randomBytes } from 'crypto';

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomChunk(length: number): string {
  // Pull entropy from crypto.randomBytes; reject biased output.
  const out: string[] = [];
  while (out.length < length) {
    const bytes = randomBytes(length * 2);
    for (const b of bytes) {
      if (b < KEY_ALPHABET.length) {
        out.push(KEY_ALPHABET[b]);
        if (out.length === length) break;
      }
    }
  }
  return out.join('');
}

export function generateLicenseKey(): string {
  return ['NEX', randomChunk(4), randomChunk(4), randomChunk(4)].join('-');
}
