/**
 * Cloud subsystem facade: the routes and the scheduler talk to this, and the
 * provider-specific files stay private behind it.
 *
 * The rule that keeps this feature honest lives in the module names below:
 * `manager` owns the connection, `sync` owns the queue that copies verified local
 * backups into the customer's own storage, and `connect` owns the OAuth handoff.
 */
export * from './provider.js';
export {
  CLOUD_PROVIDERS,
  beginConnect,
  completeConnect,
  connectedProvider,
  cloudFolderSegments,
  disconnect as disconnectCloud,
  providerAvailability,
  providerFor,
  recoverInterruptedUploads,
  status as cloudStatusPayload,
  statusWithQuota,
  testConnection as testCloudConnection,
} from './manager.js';
export {
  cloudEligibility,
  currentUploads as cloudProgress,
  deleteRemoteBackup,
  describeCloudError,
  downloadRemoteToTemp,
  importRemoteBackup,
  remoteBackups as remoteBackupViews,
  syncNow,
  uploadRecord,
} from './sync.js';
export { completeConnectFromApp, getConnectResult, handleCloudCallback, startConnect } from './connect.js';
export type { BeginConnectOutcome, ConnectResult } from './connect.js';
export type { CloudStatus, ProviderAvailability } from './manager.js';
export type { SyncSummary, UploadProgressInfo } from './sync.js';
