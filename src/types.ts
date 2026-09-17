export type OrderStatus = 'new' | 'accepted' | 'ready' | 'completed' | 'cancelled';
export type PaymentStatus = 'unpaid' | 'paid' | 'refunded';

export interface ProductVariant {
  id: string;
  name: string; // e.g. "Half", "Full", "Regular", "Large"
  price: number;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  category: string;
  image: string;
  isAvailable: boolean;
  isVeg?: boolean; // true = Veg 🟢, false = Non-Veg 🔴
  hasVariants: boolean;
  basePrice?: number; // Used if hasVariants is false
  variants?: ProductVariant[]; // Used if hasVariants is true
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerFeedback {
  id: string;
  orderId?: string;
  orderNumber?: string;
  tableNumber: number;
  tableName: string;
  customerName: string;
  rating: number; // 1 to 5 stars
  comment: string;
  createdAt: string;
}

export interface WaiterCall {
  id: string;
  tableId?: string;
  tableNumber: number;
  tableName: string;
  customerName?: string;
  status: 'pending' | 'attended';
  createdAt?: string;
  calledAt?: string;
  attendedAt?: string;
}

export interface CafeTable {
  id: string;
  tableNumber: number;
  name: string; // e.g. "Table 1", "Outdoor 2", etc.
  token: string; // Permanent unguessable token
  isActive: boolean;
  createdAt: string;
}

export interface CartItem {
  productId: string;
  productName: string;
  variantId?: string;
  variantName?: string;
  price: number;
  quantity: number;
  image: string;
}

export interface OrderItem {
  id: string;
  productId: string;
  productName: string;
  variantId?: string;
  variantName?: string;
  unitPrice: number; // Historical price snapshotted at order time
  quantity: number;
  totalPrice: number;
}

export interface OrderTimeline {
  createdAt: string;
  acceptedAt?: string;
  readyAt?: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface Order {
  id: string;
  orderNumber: string; // e.g. "NT-1042"
  tableId: string;
  tableNumber: number;
  tableName: string;
  customerName: string;
  customerPhone?: string;
  specialInstructions?: string;
  items: OrderItem[];
  subtotal: number;
  tax: number;
  totalAmount: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  timeline: OrderTimeline;
  cancellationReason?: string;
  whatsappNotificationSent: boolean;
  whatsappNotificationError?: string;
}

export interface CafeCategory {
  id: string;
  name: string;
  icon?: string;
  displayOrder: number;
}

export interface CafeSettings {
  cafeName: string;
  tagline: string;
  address: string;
  phone: string;
  whatsappNumber: string;
  currency: string;
  upiId?: string;
  enableWhatsAppAlerts: boolean;
  whatsappApiUrl?: string;
  whatsappApiToken?: string;
  enableSoundAlerts: boolean;
  /** Optional override for QR codes: e.g. https://mycafe.com or http://192.168.1.42:3000 */
  qrBaseUrl?: string;
  /** Alias for qrBaseUrl, for backwards compat */
  publicBaseUrl?: string;
}

export interface SalesSummary {
  totalRevenue: number;
  totalOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  pendingOrders: number;
  averageOrderValue: number;
  paidAmount: number;
  unpaidAmount: number;
  topSellingItems: {
    name: string;
    variant?: string;
    quantity: number;
    revenue: number;
  }[];
  recentOrders: Order[];
}

/* ── Backup, cloud storage and disaster recovery ──────────────────────────────
 * Mirrors of the payloads served by /api/admin/backup/* and /api/admin/cloud/*
 * (src/server/backupRoutes.ts). They live here, next to the other shared shapes,
 * so the admin UI and the API client cannot drift from the server. Nothing in
 * this section is used by the store, the database, or the bill printing code.
 */

export type BackupClass = 'daily' | 'weekly' | 'monthly' | 'manual';
export type BackupTrigger = 'manual' | 'daily' | 'startup-catchup' | 'pre-restore' | 'initial';
export type CloudProviderId = 'google-drive' | 'onedrive' | 'dropbox';
export type BackupCloudStatus = 'pending' | 'uploading' | 'uploaded' | 'verified' | 'failed';
export type CloudProtectionState = 'protected' | 'uploading' | 'pending' | 'failed' | 'attention' | 'disconnected';

export interface BackupRecordCounts {
  categories: number;
  tables: number;
  products: number;
  orders: number;
  feedbacks: number;
  waiterCalls: number;
}

export interface BackupCloudState {
  provider: CloudProviderId;
  status: BackupCloudStatus;
  remoteId?: string | null;
  remotePath?: string | null;
  remoteBytes?: number;
  remoteHash?: string | null;
  attempts?: number;
  lastAttemptAt?: string | null;
  uploadedAt?: string | null;
  verifiedAt?: string | null;
  nextAttemptAt?: string | null;
  error?: string | null;
}

/** One row of the backup history (GET /api/admin/backup/history). */
export interface BackupHistoryEntry {
  id: string;
  /** Class-relative file name, e.g. "daily/restaurant-2026-05-01-023000.rdbak". */
  file: string;
  folder: BackupClass;
  createdAt: string;
  trigger: BackupTrigger;
  backupClass: BackupClass;
  bytes: number;
  verified: boolean;
  missing: boolean;
  damaged: boolean;
  encrypted: boolean;
  foreignRestaurant: boolean;
  imported: boolean;
  safetyFor: string | null;
  note: string;
  recordCounts: BackupRecordCounts;
  databaseProvider: 'postgres' | 'file';
  verifiedAt: string | null;
  cloud: BackupCloudState | null;
}

export interface BackupLocationInfo {
  dir: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
}

export interface CredentialBackendInfo {
  kind: string;
  secure: boolean;
  detail: string;
}

export interface BackupScheduleStatus {
  running: boolean;
  phase: string | null;
  phaseLabel: string | null;
  startedAt: string | null;
  recordId: string | null;
  cloud: { state: string; detail: string | null } | null;
  enabled: boolean;
  dailyTime: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTrigger: BackupTrigger | null;
  lastOutcome: 'success' | 'failure' | null;
  lastError: string | null;
  consecutiveFailures: number;
  catchupDue: boolean;
  hasVerifiedBackup: boolean;
  needsAttention: boolean;
  attentionMessage: string | null;
}

export interface CloudQuota {
  usedBytes: number | null;
  limitBytes: number | null;
  accountLabel: string | null;
}

/** One in-flight or resumable cloud upload (GET /api/admin/backup/status → uploads). */
export interface CloudUploadProgress {
  recordId: string;
  provider: string;
  sentBytes: number;
  totalBytes: number;
  resumed: boolean;
  startedAt: string;
}

export interface CloudStatusInfo {
  state: CloudProtectionState;
  headline: string;
  action: { kind: 'reconnect' | 'connect' | 'retry' | 'encryption'; label: string; provider?: CloudProviderId } | null;
  provider: CloudProviderId | null;
  label: string | null;
  accountLabel: string | null;
  folderLabel: string | null;
  folderPath: string | null;
  connectedAt: string | null;
  clientConfigured: boolean;
  quota: CloudQuota | null;
  quotaError?: string | null;
  pendingCount: number;
  failedCount: number;
  uploadedCount: number;
  lastUploadedAt: string | null;
  nextAttemptAt: string | null;
  retired: Array<{ provider: CloudProviderId; label: string; folderLabel: string | null; supersededAt: string | null }>;
}

export interface BackupConfigPublic {
  restaurantId: string;
  localDir: string;
  defaultLocalDir: string;
  retention: { daily: number; weekly: number; monthly: number };
  schedule: {
    enabled: boolean;
    dailyTime: string;
    lastDailyRunAt: string | null;
    lastRunAt: string | null;
    lastTrigger: BackupTrigger | null;
    lastOutcome: 'success' | 'failure' | null;
    lastError: string | null;
    consecutiveFailures: number;
  };
  encryption: { mode: 'password' | 'none'; kdf: 'scrypt'; updatedAt: string; hasWrappedKey: boolean } | null;
  cloud: {
    provider: CloudProviderId;
    connectedAt: string;
    folderLabel: string | null;
    folderPath: string | null;
    accountLabel: string | null;
    clientId: string | null;
  } | null;
  retiredCloud: Array<{ provider: CloudProviderId; folderLabel: string | null; connectedAt: string; supersededAt: string | null }>;
  firstRun: { promptedAt: string | null; dismissedAt: string | null; remindAfter: string | null };
}

/** GET /api/admin/backup/status — everything the Backup Center overview needs. */
export interface BackupStatusResponse {
  ok: boolean;
  config: BackupConfigPublic;
  location: BackupLocationInfo;
  storage: { freeBytes: number; totalBytes: number } | null;
  credentials: CredentialBackendInfo;
  counts: { total: number; verified: number; damaged: number; missing: number };
  newest: {
    id: string;
    file: string;
    createdAt: string;
    trigger: BackupTrigger;
    backupClass: BackupClass;
    bytes: number;
    encrypted: boolean;
    recordCounts: BackupRecordCounts;
    cloud: BackupCloudState | null;
  } | null;
  ageHours: number | null;
  schedule: BackupScheduleStatus;
  cloud: CloudStatusInfo;
  uploads: CloudUploadProgress[];
  waitingForCloud: number;
  needsFirstRunPrompt: boolean;
  needsAttention: boolean;
}

export interface CloudProviderOption {
  id: CloudProviderId;
  label: string;
  accessSummary: string;
  clientConfigured: boolean;
  envVarNames: string[];
  connected: boolean;
  isCurrent: boolean;
  supportsDeviceCode: boolean;
}

/** POST /api/admin/cloud/<provider>/connect */
export interface CloudConnectBegin {
  ok: boolean;
  provider: CloudProviderId;
  label: string;
  url: string;
  state: string;
  usesRedirect: boolean;
  /** Register exactly this address in the provider's console. */
  redirectUri: string;
  deviceCode: { userCode: string; verificationUri: string; expiresIn: number; interval: number } | null;
  instructions: string;
}

/** Polled from GET /api/admin/cloud/connect-result */
export interface CloudConnectOutcome {
  ok: boolean;
  state: 'pending' | 'connected' | 'failed' | 'expired';
  provider: CloudProviderId | null;
  message: string | null;
  accountLabel: string | null;
  folderLabel: string | null;
  folderPath: string | null;
}

/** A backup file living in the customer's own cloud folder. */
export interface RemoteBackupFile {
  id: string;
  name: string;
  bytes: number;
  modifiedAt: string | null;
  hash: string | null;
  hashKind: 'md5' | 'sha256' | 'quickxor' | 'none';
  knownLocally: boolean;
  onlyInCloud: boolean;
  localRecordId: string | null;
}

export interface CloudSyncSummary {
  ok: boolean;
  attempted: number;
  uploaded: number;
  verified: number;
  pending: number;
  failed: number;
  skipped: number;
  reason: string | null;
  results: Array<{ recordId: string; outcome: string; detail: string | null }>;
  cloud: CloudStatusInfo;
}
