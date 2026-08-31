import {
  Product,
  CafeTable,
  Order,
  CafeCategory,
  CafeSettings,
  OrderStatus,
  PaymentStatus,
  SalesSummary,
} from '../types';

const API_BASE = '/api';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type FetchWithRetryInit = RequestInit & {
  /** Delay before a mutation's single retry (placeOrder needs > 3s to clear the backend per-IP throttle). */
  retryDelayMs?: number;
};

function newClientRequestId(): string {
  try {
    return `ordreq-${crypto.randomUUID()}`;
  } catch {
    return `ordreq-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * fetch() with automatic recovery from transient backend failures — the
 * reality of a serverless deployment. A cold Vercel instance answers 503 for
 * a moment while it boots, infrastructure hiccups surface as 500/502/504
 * with an HTML body, and mobile networks drop connections mid-request.
 *
 * - Reads (GET) are always safe to retry: up to 3 attempts.
 * - Mutations are retried at most once, and only on infrastructure-style
 *   failures: a network error before a response, an HTML 5xx from the
 *   platform, or the backend's own "backend is still starting up" 503.
 *   A JSON business error from the app (400/401/404/500-with-error-body)
 *   is never retried — the caller sees it immediately.
 * - Place Order sends a clientRequestId so the backend replays the first
 *   result instead of creating a duplicate when a retry is needed.
 */
async function fetchWithRetry(url: string, init: FetchWithRetryInit = {}): Promise<Response> {
  const { retryDelayMs, ...fetchInit } = init;
  const method = (fetchInit.method || 'GET').toUpperCase();
  const isRead = method === 'GET';
  const maxAttempts = isRead ? 3 : 2;
  const mutationRetryDelay = retryDelayMs ?? 1200;
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response | null = null;
    let networkError: unknown = null;
    const canRetryMore = attempt < maxAttempts;

    try {
      response = await fetch(url, fetchInit);
    } catch (error) {
      // Network-level failure: no response at all (cold-start blip, dropped
      // mobile connection, DNS hiccup).
      networkError = error;
    }

    if (networkError !== null) {
      lastError = networkError;
      lastResponse = null;
      if (canRetryMore) {
        await sleep(attempt === 1 ? (isRead ? 800 : mutationRetryDelay) : 2000);
        continue;
      }
      throw networkError;
    }

    lastResponse = response;
    lastError = null;

    const isServerHiccup = response!.status >= 500 && response!.status <= 504;
    if (!isServerHiccup) return response!;
    if (!canRetryMore) return response!;

    if (isRead) {
      await sleep(attempt === 1 ? 800 : 2000);
      continue;
    }

    // Mutations: retry only infrastructure failures — an HTML 5xx from the
    // platform or the backend's own "still starting up" 503. A JSON error
    // body produced by the app itself is surfaced immediately.
    const contentType = response!.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const bodyText = await response!.clone().text().catch(() => '');
      if (!/starting up/i.test(bodyText)) return response!;
    }
    await sleep(mutationRetryDelay);
  }

  if (lastError) throw lastError;
  return lastResponse as Response;
}

function getAuthHeader() {
  const token = localStorage.getItem('nagori_admin_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Shape of the backend /api/health payload. */
export interface BackendHealth {
  status: string;
  app: string;
  deploySha?: string | null;
  persistence: 'postgres' | 'file';
  postgresConfigured: boolean;
  storage: 'database' | 'local-json-file';
  postgres?: {
    host: string;
    status: 'connected' | 'unavailable' | 'not-configured';
    error: { message: string; code?: string; phase: string; at: string; hint?: string } | null;
    recoveryAttempts: number;
    lastProbeAt: string | null;
  };
  dataFile?: string;
  ephemeral?: boolean;
  /** True when the request is being served by the packaged desktop app. */
  isDesktop?: boolean;
  /** Loopback URL the staff console window was loaded from (desktop only). */
  localUrl?: string | null;
  /** Every LAN IPv4 the desktop server is also listening on. */
  lanUrls?: Array<{ url: string; address: string; interface: string }>;
  /** License state — null when licenses aren't enforced on this build. */
  licenseRequired?: boolean;
  trialDays?: number;
  trialAvailable?: boolean;
  license?: {
    state: 'not-required' | 'missing' | 'invalid' | 'expired' | 'active';
    reason?: string;
    gracePeriodEndsAt?: number | null;
    payload?: {
      keyId: string;
      cafeName: string;
      email: string;
      plan: string;
      iat: number;
      exp: number | null;
      fingerprint: string;
      activated: boolean;
    };
  };
  /** Process uptime — near-zero on every check means requests keep cold-starting. */
  nodeUptimeSeconds?: number;
  /** Vercel region that served the request (e.g. "iad1"), when deployed there. */
  region?: string | null;
  timestamp: string;
}

export const api = {
  // Backend health & diagnostics
  async getHealth(): Promise<BackendHealth> {
    const res = await fetchWithRetry(`${API_BASE}/health`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error('Backend health check failed.');
    }
    return res.json();
  },

  // Public Customer APIs
  async getPublicTables(): Promise<{ tables: CafeTable[] }> {
    const res = await fetchWithRetry(`${API_BASE}/public/tables`);
    if (!res.ok) {
      throw new Error('Failed to load tables list.');
    }
    return res.json();
  },

  async getTableMenu(token: string): Promise<{
    table: CafeTable;
    settings: CafeSettings;
    categories: CafeCategory[];
    products: Product[];
  }> {
    const res = await fetchWithRetry(`${API_BASE}/table/${encodeURIComponent(token)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to load table menu.');
    }
    return res.json();
  },

  async getTableOrders(token: string): Promise<{
    table: CafeTable;
    orders: Order[];
  }> {
    const res = await fetchWithRetry(`${API_BASE}/table/${encodeURIComponent(token)}/orders`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to load table order history.');
    }
    return res.json();
  },

  async placeOrder(payload: {
    tableToken: string;
    customerName: string;
    customerPhone?: string;
    specialInstructions?: string;
    items: {
      productId: string;
      variantId?: string;
      quantity: number;
    }[];
  }): Promise<{ success: boolean; order: Order; message: string }> {
    // One id per cart submission: every automatic retry of THIS call carries
    // the same id, and the backend replays the first result — a flaky network
    // can never silently double-place the order.
    const clientRequestId = newClientRequestId();
    const res = await fetchWithRetry(`${API_BASE}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, clientRequestId }),
      // The backend throttles submissions to one per IP every 3s; retrying
      // sooner would bounce off with 429 instead of succeeding.
      retryDelayMs: 3500,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to submit order.');
    }
    const data = await res.json();
    return data;
  },

  async trackOrder(orderId: string): Promise<{ order: Order }> {
    const res = await fetchWithRetry(`${API_BASE}/orders/track/${encodeURIComponent(orderId)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Order not found.');
    }
    return res.json();
  },

  /**
   * Fetch every order placed from this device, by the order IDs the phone
   * saved when submitting them (read-only). Works across tables and past
   * visits, so "My Orders" always shows the customer their own history.
   */
  async getMyOrdersByIds(ids: string[]): Promise<{ orders: Order[] }> {
    const res = await fetchWithRetry(`${API_BASE}/orders/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to load your orders.');
    }
    return res.json();
  },

  async callWaiter(payload: {
    tableToken?: string;
    tableId?: string;
    tableNumber: number;
    tableName: string;
    customerName?: string;
  }): Promise<{ success: boolean; call: any; message: string }> {
    const res = await fetchWithRetry(`${API_BASE}/waiter-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to call waiter.');
    }
    const data = await res.json();
    return data;
  },

  async submitFeedback(payload: {
    orderId?: string;
    orderNumber?: string;
    tableNumber: number;
    tableName: string;
    customerName: string;
    rating: number;
    comment: string;
  }): Promise<{ success: boolean; feedback: any; message: string }> {
    const res = await fetchWithRetry(`${API_BASE}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to submit rating & feedback.');
    }
    const data = await res.json();
    return data;
  },

  // Admin Waiter Calls & Feedbacks
  async adminGetWaiterCalls(): Promise<{ calls: any[] }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/waiter-calls`, {
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) throw new Error('Failed to load waiter calls.');
    return res.json();
  },

  async adminAttendWaiterCall(id: string): Promise<{ success: boolean; call: any }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/waiter-calls/${encodeURIComponent(id)}/attend`, {
      method: 'PATCH',
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) throw new Error('Failed to update waiter call.');
    const data = await res.json();
    return data;
  },

  async adminGetFeedbacks(): Promise<{
    feedbacks: any[];
    averageRating: number;
    totalFeedbacks: number;
    ratingDistribution: Record<number, number>;
  }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/feedbacks`, {
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) throw new Error('Failed to load feedbacks.');
    return res.json();
  },

  // Admin Authentication
  async adminLogin(email: string, password: string): Promise<{ success: boolean; token: string }> {
    let res: Response;
    try {
      res = await fetchWithRetry(`${API_BASE}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      throw new Error('Cannot reach the server. Please check your connection and that the backend is running, then try again.');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (err?.error) throw new Error(err.error);
      // No JSON error body → the backend API is missing (static hosting, wrong port, proxy error).
      throw new Error(
        `Login service is currently unavailable (HTTP ${res.status}). The server may still be starting up — please wait a moment and try again. If the problem persists, restart the app with "npm run dev".`
      );
    }
    const data = await res.json();
    if (data.token) {
      localStorage.setItem('nagori_admin_token', data.token);
    }
    return data;
  },

  async adminGetMe(): Promise<{ email: string; cafeName: string }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/me`, {
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) {
      throw new Error('Session expired.');
    }
    return res.json();
  },

  async adminLogout(): Promise<void> {
    try {
      await fetchWithRetry(`${API_BASE}/admin/logout`, {
        method: 'POST',
        headers: { ...getAuthHeader() },
      });
    } catch {
      // Ignore
    }
    localStorage.removeItem('nagori_admin_token');
  },

  // Admin Orders
  async adminGetOrders(status?: string, tableId?: string): Promise<{ orders: Order[] }> {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    if (tableId) params.append('tableId', tableId);

    const res = await fetchWithRetry(`${API_BASE}/admin/orders?${params.toString()}`, {
      headers: { ...getAuthHeader() },
      cache: 'no-store',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to fetch orders.');
    }
    return res.json();
  },

  /**
   * Read every table's orders with no table/status filter. The hotel dashboard
   * uses this source to detect incoming orders from Table 1, Table 2, Table 3,
   * and tables added later without touching any saved order data.
   */
  async adminGetAllTableOrders(): Promise<{ orders: Order[] }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/orders?scope=all-tables`, {
      headers: { ...getAuthHeader() },
      cache: 'no-store',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to fetch all table orders.');
    }
    return res.json();
  },

  async adminUpdateOrderStatus(
    orderId: string,
    status: OrderStatus,
    cancellationReason?: string
  ): Promise<{ success: boolean; order: Order }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader(),
      },
      body: JSON.stringify({ status, cancellationReason }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to update order status.');
    }
    const data = await res.json();
    return data;
  },

  async adminUpdatePaymentStatus(
    orderId: string,
    paymentStatus: PaymentStatus
  ): Promise<{ success: boolean; order: Order }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/orders/${orderId}/payment`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader(),
      },
      body: JSON.stringify({ paymentStatus }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to update payment status.');
    }
    const data = await res.json();
    return data;
  },

  // Admin Products
  async adminGetProducts(): Promise<{ products: Product[] }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/products`, {
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to fetch products.');
    }
    return res.json();
  },

  async adminAddProduct(product: Partial<Product>): Promise<{ success: boolean; product: Product }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader(),
      },
      body: JSON.stringify(product),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to add product.');
    }
    return res.json();
  },

  async adminEditProduct(id: string, product: Partial<Product>): Promise<{ success: boolean; product: Product }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/products/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader(),
      },
      body: JSON.stringify(product),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to update product.');
    }
    return res.json();
  },

  async adminToggleProductAvailability(id: string): Promise<{ success: boolean; product: Product }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/products/${id}/availability`, {
      method: 'PATCH',
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to toggle availability.');
    }
    return res.json();
  },

  async adminDeleteProduct(id: string): Promise<{ success: boolean }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/products/${id}`, {
      method: 'DELETE',
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to delete product.');
    }
    return res.json();
  },

  // Admin Tables
  async adminGetTables(): Promise<{ tables: (CafeTable & { activeOrder?: Order | null })[] }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/tables`, {
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to fetch tables.');
    }
    return res.json();
  },

  async adminAddTable(tableNumber: number, name?: string): Promise<{ success: boolean; table: CafeTable }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader(),
      },
      body: JSON.stringify({ tableNumber, name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to add table.');
    }
    return res.json();
  },

  async adminToggleTable(id: string): Promise<{ success: boolean; table: CafeTable }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/tables/${id}/toggle`, {
      method: 'PATCH',
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to toggle table.');
    }
    return res.json();
  },

  async adminRegenerateToken(id: string): Promise<{ success: boolean; table: CafeTable }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/tables/${id}/regenerate-token`, {
      method: 'PATCH',
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to regenerate token.');
    }
    return res.json();
  },

  async adminDeleteTable(id: string): Promise<{ success: boolean }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/tables/${id}`, {
      method: 'DELETE',
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to delete table.');
    }
    return res.json();
  },

  // Admin Categories
  async adminGetCategories(): Promise<{ categories: CafeCategory[] }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/categories`, {
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) throw new Error('Failed to fetch categories.');
    return res.json();
  },

  async adminAddCategory(name: string): Promise<{ success: boolean; category: CafeCategory }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/categories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader(),
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error('Failed to add category.');
    return res.json();
  },

  async adminEditCategory(id: string, name: string): Promise<{ success: boolean; category: CafeCategory; updatedProductsCount?: number }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/categories/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader(),
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to update category.');
    }
    return res.json();
  },

  async adminDeleteCategory(id: string): Promise<{ success: boolean }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/categories/${id}`, {
      method: 'DELETE',
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) throw new Error('Failed to delete category.');
    return res.json();
  },

  // Admin Reports
  async adminGetReports(range = 'today', startDate?: string, endDate?: string): Promise<{ summary: SalesSummary }> {
    const params = new URLSearchParams({ range });
    // Day boundaries must follow the operator's local calendar day so "Today"
    // resets at their 12:00 AM even when the server runs in UTC.
    params.append('tzOffsetMinutes', String(new Date().getTimezoneOffset()));
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);

    const res = await fetchWithRetry(`${API_BASE}/admin/reports?${params.toString()}`, {
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to load reports.');
    }
    return res.json();
  },

  // Admin Settings
  async adminGetSettings(): Promise<{ settings: CafeSettings; adminEmail: string }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/settings`, {
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) throw new Error('Failed to load settings.');
    return res.json();
  },

  async adminUpdateSettings(settings: Partial<CafeSettings>): Promise<{ success: boolean; settings: CafeSettings }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader(),
      },
      body: JSON.stringify(settings),
    });
    if (!res.ok) throw new Error('Failed to update settings.');
    return res.json();
  },

  async adminChangePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean; message: string }> {
    const res = await fetchWithRetry(`${API_BASE}/admin/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader(),
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to change password.');
    }
    return res.json();
  },

  /** Returns the most recent admin audit log entries. Newest first. */
  async adminGetAudit(limit = 200): Promise<{ entries: Array<{ ts: string; admin: string; fingerprint: string; method: string; path: string }> }> {
    const res = await fetchWithRetry(String.raw`${API_BASE}/admin/audit?limit=${Math.max(1, Math.min(1000, limit))}`, {
      headers: { ...getAuthHeader() },
    });
    if (!res.ok) throw new Error('Failed to read audit log.');
    return res.json();
  },
};

// Helper to create direct WhatsApp link for instant messaging
export function generateWhatsAppOrderUrl(order: Order, phone: string, cafeName: string, currency = '₹'): string {
  const itemsText = order.items
    .map((item) => `• ${item.quantity} × ${item.productName}${item.variantName ? ` (${item.variantName})` : ''} - ${currency}${item.totalPrice}`)
    .join('%0A');

  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const message = `*🔥 NEW ORDER — ${encodeURIComponent(cafeName.toUpperCase())}*%0A%0A` +
    `*Order ID:* ${order.orderNumber}%0A` +
    `*Customer:* ${encodeURIComponent(order.customerName)}%0A` +
    `*Table:* ${encodeURIComponent(order.tableName)}%0A%0A` +
    `*Items:*%0A${itemsText}%0A%0A` +
    `*TOTAL:* ${currency}${order.totalAmount}%0A` +
    `*Payment:* ${order.paymentStatus.toUpperCase()}`;

  return `https://wa.me/${cleanPhone}?text=${message}`;
}
