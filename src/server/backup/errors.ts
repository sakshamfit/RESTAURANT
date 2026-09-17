/**
 * Single error type for the backup subsystem. Every failure carries a sentence
 * an owner can act on, a machine-readable `kind` the UI branches on, and the
 * HTTP status the API returns. Nothing in this subsystem throws raw Error
 * objects at the route layer.
 */



export class BackupError extends Error {
  status: number;
  /** Stable machine-readable reason the UI branches on. */
  kind: string;
  constructor(message: string, kind = 'backup-failed', status = 400) {
    super(message);
    this.name = 'BackupError';
    this.kind = kind;
    this.status = status;
  }
}


let cachedAppVersion: string | null = null;
