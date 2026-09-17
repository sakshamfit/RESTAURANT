/**
 * Backup subsystem facade. Routes and the desktop layer import from here only;
 * the modules below are the internal structure (format / integrity / crypto /
 * manifest / retention / service / restore / scheduler).
 *
 * Design rule that shapes the whole folder: backups are built from the
 * *existing* store abstraction (PostgreSQL or data/restaurant.json), never from
 * raw database files, and the customer's cloud account is only ever a
 * destination — this app never hosts a copy of anyone's data.
 */
export * from './types.js';
export * from './errors.js';
export * from './integrity.js';
export * from './crypto.js';
export * from './format.js';
export * from './manifest.js';
export * from './retention.js';
export * from './service.js';
export * from './restore.js';
export * from './scheduler.js';
