/**
 * One small cross-platform detail that only bites on Windows, and this app is
 * installed on Windows tills: renaming a file OVER an existing one fails with
 * EPERM/EBUSY when another process still holds the target — which is exactly the
 * moment an antivirus real-time scan is reading the file we just replaced, or a
 * second window has the manifest open. Losing a config write there would surface
 * as "saving your backup settings failed", so the writers below retry briefly
 * before giving up, and never leave a half-written target behind.
 *
 * The pattern is always the same: write `<target>.<pid>.tmp`, fsync-free small
 * files only, then replace. Either the old content or the new content is on disk,
 * never a mix.
 */
import fs from 'fs';

/** Blocking sleep, for synchronous writers (Atomics.wait needs no timers). */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable: proceed immediately to the next attempt */
  }
}

/**
 * Rename `tmp` onto `target`, replacing it, with a bounded retry for the
 * sharing-violation codes. On failure the original file is still intact; the temp
 * copy is removed then (its content is redundant) or kept (so nothing is lost).
 */
export function replaceFile(tmp: string, target: string): void {
  const retried = ['EPERM', 'EACCES', 'EBUSY'];
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code || '';
      if (!retried.includes(code)) break;
      sleepSync(25 * (attempt + 1));
    }
  }
  // If the previous file survived, the temp copy adds nothing and must not
  // linger (it can hold a token). If the target is gone, keep the temp: an
  // unreadable backup config is worse than a stray file in data/.
  if (fs.existsSync(target)) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing else to do */
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not replace ${target}`);
}
