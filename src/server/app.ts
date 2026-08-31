import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
// Type-only import + explicit .js specifier: keeps the emitted ESM import (if
// any) resolvable after Vercel transpiles this file to native ESM.
import type {
  CafeCategory,
  CafeSettings,
  CafeTable,
  CustomerFeedback,
  Order,
  OrderStatus,
  PaymentStatus,
  Product,
  SalesSummary,
  WaiterCall,
} from '../types.js';
import { store, postgresConfigured, newId } from './store.js';
import { initialSettings } from './seed.js';
import {
  changeAdminPassword,
  getAdminAuthConfigurationError,
  getAdminEmail,
  getAdminSessionSecret,
  verifyAdminPassword,
} from './auth.js';
import {
  activateLicense,
  deleteLicenseFile,
  getStoredPayload,
  getTrialDays,
  heartbeat,
  isLicenseRequired,
  rebindLicense,
  verifyLicense,
  type LicenseStatus,
} from './license.js';
import { auditMiddleware } from './audit.js';

dotenv.config();

// ── Admin sessions ───────────────────────────────────────────────────────────
// There is exactly one admin and exactly one way to log in: /api/admin/login
// with the single admin password (stored in data/admin.json locally, or in the
// database when DATABASE_URL is set — no cloud auth service involved). Sessions
// are HMAC-signed tokens with a 7-day expiry, verified locally and surviving
// restarts.
const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const adminSessionSecret = getAdminSessionSecret();
const adminEmail = getAdminEmail();
const clientOrderTimestamps = new Map<string, number>();
const ORDER_THROTTLE_MS = 3000;
// Throttle state is deliberately bounded. Both maps used to keep one entry per
// client IP forever, which is a slow leak that shows up as a backend degrading
// and flapping the longer it runs. Expired entries are swept and the size capped.
const MAX_TRACKED_CLIENTS = 1000;

// Idempotency window for order submissions. The customer client attaches a
// random clientRequestId to every "Place Order" press and keeps it across
// automatic retries, so a retry after a dropped response can never create a
// second order — the server replays the first result instead.
const ORDER_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const recentOrderRequests = new Map<string, { order: Order; at: number }>();

function rememberRecentOrderRequest(key: string, order: Order) {
  const nowMs = Date.now();
  if (recentOrderRequests.size >= MAX_TRACKED_CLIENTS) {
    for (const [k, v] of recentOrderRequests) {
      if (nowMs - v.at > ORDER_IDEMPOTENCY_TTL_MS) recentOrderRequests.delete(k);
    }
  }
  if (recentOrderRequests.size >= MAX_TRACKED_CLIENTS) {
    dropOldest(recentOrderRequests, Math.ceil(MAX_TRACKED_CLIENTS / 2));
  }
  recentOrderRequests.set(key, { order, at: nowMs });
}

function dropOldest(map: Map<string, unknown>, count: number) {
  let remaining = count;
  for (const key of map.keys()) {
    if (remaining <= 0) break;
    map.delete(key);
    remaining -= 1;
  }
}

function rememberOrderAttempt(ip: string, now: number) {
  if (clientOrderTimestamps.size >= MAX_TRACKED_CLIENTS) {
    for (const [key, at] of clientOrderTimestamps) {
      if (now - at > ORDER_THROTTLE_MS) clientOrderTimestamps.delete(key);
    }
  }
  if (clientOrderTimestamps.size >= MAX_TRACKED_CLIENTS) {
    dropOldest(clientOrderTimestamps, Math.ceil(MAX_TRACKED_CLIENTS / 2));
  }
  clientOrderTimestamps.set(ip, now);
}

function signAdminToken(email: string) {
  const payload = Buffer.from(JSON.stringify({ sub: 'admin', email, iat: Date.now(), exp: Date.now() + ADMIN_SESSION_TTL_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', adminSessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyAdminToken(token: string): { email?: string } | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', adminSessionSecret).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded?.sub !== 'admin' || typeof decoded.exp !== 'number' || Date.now() > decoded.exp) return null;
    return decoded;
  } catch {
    return null;
  }
}

function passwordsMatch(password: string) {
  return verifyAdminPassword(password);
}

// Coarse login rate limit: 15 failed attempts per IP per 15 minutes.
const loginFailures = new Map<string, { count: number; windowStart: number }>();
const LOGIN_MAX_ATTEMPTS = 15;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function loginRateLimited(ip: string) {
  const entry = loginFailures.get(ip);
  if (!entry || Date.now() - entry.windowStart > LOGIN_WINDOW_MS) return false;
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(ip: string) {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (entry && now - entry.windowStart <= LOGIN_WINDOW_MS) {
    entry.count += 1;
    return;
  }
  if (loginFailures.size >= MAX_TRACKED_CLIENTS) {
    for (const [key, stale] of loginFailures) {
      if (now - stale.windowStart > LOGIN_WINDOW_MS) loginFailures.delete(key);
    }
  }
  if (loginFailures.size >= MAX_TRACKED_CLIENTS) {
    dropOldest(loginFailures, Math.ceil(MAX_TRACKED_CLIENTS / 2));
  }
  loginFailures.set(ip, { count: 1, windowStart: now });
}

function getIdentifier(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function tableMatches(table: CafeTable, rawIdentifier: string) {
  const lowerIdentifier = rawIdentifier.toLowerCase().replace(/\s+/g, '');
  return (
    table.token === rawIdentifier ||
    table.id === rawIdentifier ||
    String(table.tableNumber) === rawIdentifier ||
    table.name.toLowerCase().replace(/\s+/g, '') === lowerIdentifier ||
    lowerIdentifier === `t${table.tableNumber}` ||
    lowerIdentifier === `table${table.tableNumber}`
  );
}

function findTable(tables: CafeTable[], identifier: unknown) {
  const rawIdentifier = getIdentifier(identifier);
  return tables.find((table) => tableMatches(table, rawIdentifier));
}

function publicSettings(settings: CafeSettings) {
  return {
    cafeName: settings.cafeName,
    tagline: settings.tagline,
    currency: settings.currency,
    phone: settings.phone,
    address: settings.address,
    upiId: settings.upiId,
  };
}

/**
 * Parse the JSON list of LAN addresses the desktop shell writes into
 * DESKTOP_LAN_URLS. Defensive: the renderer never crashes if the env var is
 * missing or malformed — the QR-code modal simply falls back to the loopback
 * URL and shows a clear "no Wi-Fi detected" note.
 */
function parseDesktopLanUrls(raw: string | undefined): Array<{ url: string; address: string; interface: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.url === 'string' && typeof entry.address === 'string')
      .map((entry) => ({
        url: String(entry.url),
        address: String(entry.address),
        interface: typeof entry.interface === 'string' ? entry.interface : '',
      }));
  } catch {
    return [];
  }
}

function jsonError(res: Response, status: number, message: string) {
  return res.status(status).json({ error: message });
}

function getBearerToken(req: Request) {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// The single admin login: every admin request must carry the HMAC session
// token issued by /api/admin/login (or still be within its 7-day expiry).
function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const configurationError = getAdminAuthConfigurationError();
  if (configurationError) return jsonError(res, 503, configurationError);
  const token = getBearerToken(req);
  if (!token) return jsonError(res, 401, 'Unauthorized: Missing admin session.');
  const session = verifyAdminToken(token);
  if (!session) return jsonError(res, 401, 'Unauthorized: Admin session is invalid or expired. Please log in again.');
  (req as Request & { adminUser?: { email?: string } }).adminUser = { email: session.email || adminEmail };
  next();
}

/**
 * Admin guard for distributed builds: when `LICENSE_REQUIRED=true`, the admin
 * console and admin APIs are blocked until a valid license file is present.
 * Customer APIs (placing orders, viewing the menu) are NEVER blocked — a café
 * never goes dark because of a license issue.
 *
 * Returns a 402 with a structured payload so the UI can show the right
 * "activate / renew" screen instead of a generic error.
 */
async function requireValidLicense(req: Request, res: Response, next: NextFunction) {
  if (!isLicenseRequired()) return next();
  const status = await verifyLicense();
  // Make the active license payload (and the fingerprint baked into it)
  // available to downstream middlewares so the audit log can watermark
  // every admin action with the machine that performed it.
  if (status.state === 'active') {
    (req as Request & { licensePayload?: typeof status.payload }).licensePayload = status.payload;
  }
  if (status.state === 'active' || status.state === 'not-required') return next();
  if (status.state === 'expired' && status.gracePeriodEndsAt) {
    // Still inside the 7-day grace window — let the admin keep working but
    // mark the response so the UI can show a renewal banner.
    res.setHeader('X-License-State', 'expired-grace');
    res.setHeader('X-License-Grace-Ends-At', String(status.gracePeriodEndsAt));
    return next();
  }
  res.status(402).json({
    error: 'License required',
    license: status,
    action: status.state === 'missing' ? 'activate' : 'renew',
  });
}

// Combined guard used by every admin route. Validates the license BEFORE
// the admin session check so a banned/expired customer is told to renew
// instead of being asked to log in. The audit middleware sits at the end
// of the chain so it can watermark state-changing admin requests with
// the admin email + machine fingerprint.
const requireAdmin: Array<typeof requireValidLicense | typeof requireAdminAuth | ReturnType<typeof auditMiddleware>> = [
  requireValidLicense,
  requireAdminAuth,
  auditMiddleware(),
];

async function sendWhatsAppNotification(order: Order, settings: CafeSettings): Promise<{ success: boolean; error?: string }> {
  if (!settings.enableWhatsAppAlerts || !settings.whatsappNumber) {
    return { success: false, error: 'WhatsApp alerts disabled or phone not set' };
  }

  const itemsList = order.items
    .map((item) => `• ${item.quantity} × ${item.productName}${item.variantName ? ` (${item.variantName})` : ''} — ${settings.currency}${item.totalPrice}`)
    .join('\n');
  const messageText = `🔥 *NEW ORDER — ${settings.cafeName.toUpperCase()}*\n\n` +
    `*Order ID:* ${order.orderNumber}\n` +
    `*Customer:* ${order.customerName}\n` +
    `*Table:* ${order.tableName}\n` +
    `*Time:* ${new Date(order.timeline.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}\n\n` +
    `*Items:*\n${itemsList}\n\n` +
    `*TOTAL:* ${settings.currency}${order.totalAmount}\n` +
    `*Payment Status:* ${order.paymentStatus.toUpperCase()}\n` +
    `${order.specialInstructions ? `*Note:* ${order.specialInstructions}\n` : ''}`;

  if (settings.whatsappApiUrl && settings.whatsappApiToken) {
    try {
      const response = await fetch(settings.whatsappApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.whatsappApiToken}` },
        body: JSON.stringify({ phone: settings.whatsappNumber, message: messageText, orderId: order.id }),
      });
      if (!response.ok) return { success: false, error: `WhatsApp API error: ${response.status} - ${await response.text()}` };
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || 'Network error sending WhatsApp API' };
    }
  }

  // Without a gateway, the notification is considered delivered to the configured
  // direct-link workflow; the order itself is always persisted.
  return { success: true };
}

/** Builds the Express app with all API routes. Used by the local server and by Vercel. */
export function createApp() {
  const app = express();
  // Behind a reverse proxy (preview sandbox, Vercel, nginx) use the real
  // client IP from X-Forwarded-For for logging/rate-limiting.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.get('/api/health', async (_req, res) => {
    const diagnostics = store.getDiagnostics();
    const isDesktop = process.env.DESKTOP_APP === '1';
    // LAN addresses of the host running the server, when in desktop mode. The
    // renderer uses these to build QR-code URLs that customer phones on the
    // same Wi-Fi can actually reach — `window.location.origin` would be the
    // staff machine's loopback, which a phone has no route to.
    const lanUrls = isDesktop ? parseDesktopLanUrls(process.env.DESKTOP_LAN_URLS) : [];
    const port = Number(process.env.PORT || 3000);
    // License state is reported (without secrets) so the dashboard can show
    // the right banner without an extra round-trip.
    const licenseStatus = isLicenseRequired() ? await verifyLicense() : ({ state: 'not-required' } as LicenseStatus);
    res.set('Cache-Control', 'no-store');
    res.json({
      status: 'ok',
      app: 'NEXORAOSP RESTAURANT API',
      // Commit that produced this deploy, when running on Vercel.
      deploySha: process.env.VERCEL_GIT_COMMIT_SHA || null,
      persistence: diagnostics.provider,
      postgresConfigured: diagnostics.postgresConfigured,
      storage: diagnostics.provider === 'postgres' ? 'database' : 'local-json-file',
      postgres: diagnostics.postgresConfigured
        ? {
            host: diagnostics.postgresHost,
            status: diagnostics.postgresStatus,
            error: diagnostics.postgresError,
            recoveryAttempts: diagnostics.postgresRecoveryAttempts,
            lastProbeAt: diagnostics.postgresLastProbeAt,
          }
        : undefined,
      dataFile: diagnostics.dataFile,
      ephemeral: diagnostics.ephemeral,
      isDesktop: isDesktop || undefined,
      localUrl: isDesktop ? `http://127.0.0.1:${port}` : null,
      lanUrls,
      // License state — null when licenses aren't enforced.
      licenseRequired: isLicenseRequired() || undefined,
      license: isLicenseRequired() ? licenseStatus : undefined,
      trialDays: isLicenseRequired() ? getTrialDays() : undefined,
      trialAvailable: isLicenseRequired() && getTrialDays() > 0,
      // Ops helpers: a very low uptime together with "connected" on every check
      // means requests keep landing on fresh cold starts; VERCEL_REGION shows
      // which datacenter served the request.
      nodeUptimeSeconds: Math.round(process.uptime()),
      region: process.env.VERCEL_REGION || null,
      timestamp: new Date().toISOString(),
    });
  });

  // ----------------------------------------------------
  // License / activation
  //
  // These routes are public (no auth) so a fresh install can activate
  // before the customer has an admin account. They are also available
  // when LICENSE_REQUIRED is false — a self-hosted user can still
  // voluntarily register a key to get a "subscription" card in the
  // dashboard, but the app keeps working without it.
  // ----------------------------------------------------
  app.get('/api/license/status', async (_req, res) => {
    try {
      const status = isLicenseRequired() ? await verifyLicense() : ({ state: 'not-required' } as LicenseStatus);
      res.json({
        licenseRequired: isLicenseRequired(),
        status,
        // Trial info for the Setup Wizard. Only meaningful when licenses
        // are required; included always so the renderer doesn't need to
        // branch on licenseRequired.
        trialDays: getTrialDays(),
        trialAvailable: isLicenseRequired() && getTrialDays() > 0,
      });
    } catch (error) {
      jsonError(res, 500, 'Unable to read license state.');
    }
  });

  app.post('/api/license/activate', async (req, res) => {
    try {
      const { licenseKey, email, cafeName, fingerprint } = req.body || {};
      if (!licenseKey || !email || !cafeName || !fingerprint) {
        return jsonError(res, 400, 'licenseKey, email, cafeName and fingerprint are all required.');
      }
      const result = await activateLicense({ licenseKey, email, cafeName, fingerprint });
      res.json(result);
    } catch (error: any) {
      jsonError(res, 500, error?.message || 'Activation failed.');
    }
  });

  app.post('/api/license/rebind', async (req, res) => {
    try {
      const { licenseKey, email, newFingerprint } = req.body || {};
      if (!licenseKey || !email || !newFingerprint) {
        return jsonError(res, 400, 'licenseKey, email and newFingerprint are all required.');
      }
      const result = await rebindLicense({ licenseKey, email, newFingerprint });
      res.json(result);
    } catch (error: any) {
      jsonError(res, 500, error?.message || 'Rebind failed.');
    }
  });

  app.post('/api/license/heartbeat', async (_req, res) => {
    try {
      const result = await heartbeat();
      res.json(result);
    } catch (error: any) {
      jsonError(res, 500, error?.message || 'Heartbeat failed.');
    }
  });

  // Explicitly start the trial. Idempotent: if a license (real or trial)
  // already exists, the response reports the current state without
  // creating a new trial. The renderer calls this when the user clicks
  // the “Start free trial” button on the Setup Wizard.
  app.post('/api/license/start-trial', async (_req, res) => {
    try {
      if (!isLicenseRequired()) {
        return jsonError(res, 400, 'License is not required on this build — the trial is only for distributed builds.');
      }
      if (getTrialDays() <= 0) {
        return jsonError(res, 400, 'No trial is offered on this build.');
      }
      const status = await verifyLicense();
      res.json({ ok: true, trialDays: getTrialDays(), status });
    } catch (error: any) {
      jsonError(res, 500, error?.message || 'Could not start trial.');
    }
  });

  // Remove the local license file. Available in dev / self-hosted builds
  // so the user can reset to "fresh install" without uninstalling. In a
  // distributed build this is a no-op once the central server marks the
  // key revoked, but the local file will be deleted and the next status
  // check will return "missing".
  app.post('/api/license/deactivate', async (_req, res) => {
    try {
      await deleteLicenseFile();
      const status = isLicenseRequired() ? await verifyLicense() : ({ state: 'not-required' } as LicenseStatus);
      res.json({ ok: true, status });
    } catch (error: any) {
      jsonError(res, 500, error?.message || 'Deactivation failed.');
    }
  });

  // ----------------------------------------------------
  // Public customer APIs
  // ----------------------------------------------------
  app.get('/api/public/tables', async (_req, res) => {
    try {
      const tables = (await store.list('tables'))
        .filter((table) => table.isActive)
        .map(({ id, tableNumber, name, token, isActive, createdAt }) => ({ id, tableNumber, name, token, isActive, createdAt }))
        .sort((a, b) => a.tableNumber - b.tableNumber);
      res.json({ tables });
    } catch (error) {
      console.error('Public tables error:', error);
      jsonError(res, 500, 'Unable to load tables from the café database.');
    }
  });

  app.get('/api/table/:token', async (req, res) => {
    try {
      const snapshot = await store.snapshot();
      const table = findTable(snapshot.tables, decodeURIComponent(req.params.token || ''));
      if (!table) return jsonError(res, 404, `Table '${req.params.token}' not found or invalid QR code. Please scan a valid café table QR.`);
      if (!table.isActive) return jsonError(res, 403, `Table ${table.tableNumber} is currently not in service. Please contact staff.`);

      res.json({
        table: { id: table.id, tableNumber: table.tableNumber, name: table.name, token: table.token, isActive: table.isActive, createdAt: table.createdAt },
        settings: publicSettings(snapshot.settings),
        categories: snapshot.categories.sort((a, b) => a.displayOrder - b.displayOrder),
        products: snapshot.products.filter((product) => product.isAvailable).sort((a, b) => a.displayOrder - b.displayOrder),
      });
    } catch (error) {
      console.error('Table menu error:', error);
      jsonError(res, 500, 'Unable to load the menu from the café database.');
    }
  });

  app.get('/api/table/:token/orders', async (req, res) => {
    try {
      const snapshot = await store.snapshot();
      const table = findTable(snapshot.tables, decodeURIComponent(req.params.token || ''));
      if (!table) return jsonError(res, 404, 'Table not found.');
      const orders = snapshot.orders
        .filter((order) => order.tableId === table.id || order.tableNumber === table.tableNumber)
        .sort((a, b) => new Date(b.timeline.createdAt).getTime() - new Date(a.timeline.createdAt).getTime());
      res.json({ table: { id: table.id, tableNumber: table.tableNumber, name: table.name, token: table.token }, orders });
    } catch (error) {
      console.error('Table orders error:', error);
      jsonError(res, 500, 'Unable to load order history from the café database.');
    }
  });

  app.post('/api/orders', async (req, res) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const { tableToken, tableId, tableNumber, tableName, customerName, customerPhone, specialInstructions, items, clientRequestId } = req.body || {};
      if (!customerName || typeof customerName !== 'string' || !customerName.trim()) return jsonError(res, 400, 'Customer name is required.');

      // Idempotent submission FIRST: if this exact request (same
      // clientRequestId) was already processed, replay the original result
      // instead of creating a duplicate order — regardless of timing, so an
      // automatic retry is never bounced by the per-IP throttle below.
      const idempotencyKey = typeof clientRequestId === 'string' ? clientRequestId.trim().slice(0, 64) : '';
      if (idempotencyKey) {
        const previous = recentOrderRequests.get(idempotencyKey);
        if (previous && Date.now() - previous.at <= ORDER_IDEMPOTENCY_TTL_MS) {
          return res.status(200).json({ success: true, order: previous.order, duplicate: true, message: 'Order already placed.' });
        }
      }

      const now = Date.now();
      const lastOrderTime = clientOrderTimestamps.get(ip) || 0;
      if (now - lastOrderTime < ORDER_THROTTLE_MS) {
        return jsonError(res, 429, 'Order submission in progress. Please wait a few seconds.');
      }
      rememberOrderAttempt(ip, now);

      const snapshot = await store.snapshot();
      const table = findTable(snapshot.tables, tableToken) || findTable(snapshot.tables, tableId) || findTable(snapshot.tables, tableNumber);
      if (!table || !table.isActive) return jsonError(res, 400, 'Invalid or inactive table token.');
      if (!Array.isArray(items) || items.length === 0) return jsonError(res, 400, 'Cart is empty. Please select food items.');

      const validatedItems: Order['items'] = [];
      let subtotal = 0;
      for (const item of items) {
        const product = snapshot.products.find((candidate) => candidate.id === item.productId);
        if (!product) return jsonError(res, 400, `Product not found: ${item.productId}`);
        if (!product.isAvailable) return jsonError(res, 400, `Item "${product.name}" is currently unavailable.`);

        const quantity = Math.max(1, Math.min(50, Math.floor(Number(item.quantity) || 1)));
        let unitPrice = 0;
        let variantName: string | undefined;
        if (product.hasVariants) {
          if (!item.variantId) return jsonError(res, 400, `Please select a size for ${product.name}.`);
          const variant = product.variants?.find((candidate) => candidate.id === item.variantId);
          if (!variant) return jsonError(res, 400, `Invalid size selected for ${product.name}.`);
          unitPrice = variant.price;
          variantName = variant.name;
        } else {
          unitPrice = product.basePrice || 0;
        }
        const itemTotal = unitPrice * quantity;
        subtotal += itemTotal;
        validatedItems.push({ id: newId('oi'), productId: product.id, productName: product.name, variantId: item.variantId, variantName, unitPrice, quantity, totalPrice: itemTotal });
      }

      const orderNumber = `NC-${await store.nextOrderNumber()}`;
      const createdAt = new Date().toISOString();
      const order: Order = {
        id: newId('ord'),
        orderNumber,
        tableId: table.id,
        tableNumber: table.tableNumber,
        tableName: table.name,
        customerName: customerName.trim(),
        customerPhone: customerPhone ? String(customerPhone).trim() : undefined,
        specialInstructions: specialInstructions ? String(specialInstructions).trim() : undefined,
        items: validatedItems,
        subtotal,
        tax: 0,
        totalAmount: subtotal,
        status: 'new',
        paymentStatus: 'unpaid',
        timeline: { createdAt },
        whatsappNotificationSent: false,
      };

      const whatsappResult = await sendWhatsAppNotification(order, snapshot.settings);
      order.whatsappNotificationSent = whatsappResult.success;
      if (whatsappResult.error) order.whatsappNotificationError = whatsappResult.error;
      await store.put('orders', order);
      if (idempotencyKey) rememberRecentOrderRequest(idempotencyKey, order);
      res.status(201).json({ success: true, order, message: 'Order placed successfully!' });
    } catch (error: any) {
      console.error('Order creation error:', error);
      jsonError(res, 500, error?.message || 'Internal server error while placing order.');
    }
  });

  app.get('/api/orders/track/:orderId', async (req, res) => {
    try {
      const orders = await store.list('orders');
      const order = orders.find((candidate) => candidate.id === req.params.orderId || candidate.orderNumber === req.params.orderId);
      if (!order) return jsonError(res, 404, 'Order not found.');
      res.json({ order });
    } catch (error) {
      console.error('Track order error:', error);
      jsonError(res, 500, 'Unable to track the order from the café database.');
    }
  });

  app.post('/api/waiter-call', async (req, res) => {
    try {
      const { tableToken, tableId, tableNumber, tableName, customerName } = req.body || {};
      const tables = await store.list('tables');
      const targetTable = findTable(tables, tableToken) || findTable(tables, tableId) || findTable(tables, tableNumber);
      const tNum = targetTable?.tableNumber || Number(tableNumber) || 1;
      const call: WaiterCall = {
        id: newId('wc'),
        tableId: targetTable?.id || tableId || `tbl-${tNum}`,
        tableNumber: tNum,
        tableName: targetTable?.name || tableName || `Table ${tNum}`,
        customerName: customerName ? String(customerName).trim() : undefined,
        status: 'pending',
        createdAt: new Date().toISOString(),
        calledAt: new Date().toISOString(),
      };
      await store.put('waiterCalls', call);
      res.json({ success: true, call, message: `Waiter notified for ${call.tableName}! Staff is heading to your table.` });
    } catch (error) {
      console.error('Waiter call error:', error);
      jsonError(res, 500, 'Failed to notify waiter.');
    }
  });

  app.post('/api/feedback', async (req, res) => {
    try {
      const { orderId, orderNumber, tableNumber, tableName, customerName, rating, comment } = req.body || {};
      if (!rating || Number(rating) < 1 || Number(rating) > 5) return jsonError(res, 400, 'Rating must be between 1 and 5 stars.');
      const feedback: CustomerFeedback = {
        id: newId('fb'),
        orderId: orderId ? String(orderId) : undefined,
        orderNumber: orderNumber ? String(orderNumber) : undefined,
        tableNumber: Number(tableNumber) || 1,
        tableName: tableName ? String(tableName) : `Table ${tableNumber || 1}`,
        customerName: customerName ? String(customerName).trim() : 'Guest Customer',
        rating: Math.max(1, Math.min(5, Math.round(Number(rating)))),
        comment: comment ? String(comment).trim() : '',
        createdAt: new Date().toISOString(),
      };
      await store.put('feedbacks', feedback);
      res.status(201).json({ success: true, feedback, message: 'Thank you for your valuable rating and feedback!' });
    } catch (error) {
      console.error('Feedback submit error:', error);
      jsonError(res, 500, 'Failed to submit feedback.');
    }
  });

  // ----------------------------------------------------
  // Single admin login + protected admin APIs
  // ----------------------------------------------------
  // The one and only login: the single admin password. No cloud auth service.
  app.post('/api/admin/login', (req, res) => {
    const configurationError = getAdminAuthConfigurationError();
    if (configurationError) return jsonError(res, 503, configurationError);

    const password = getIdentifier(req.body?.password);
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!password) return jsonError(res, 400, 'Password is required.');

    // The correct password always logs in — rate limiting only throttles
    // WRONG guesses, so the real admin can never be locked out by a shared
    // proxy IP (brute force is still capped at 15 bad guesses / 15 min).
    if (!passwordsMatch(password)) {
      if (loginRateLimited(ip)) return jsonError(res, 429, 'Too many login attempts. Please wait a few minutes and try again.');
      recordLoginFailure(ip);
      return jsonError(res, 401, 'Incorrect admin password. Please try again.');
    }

    loginFailures.delete(ip); // successful login clears the failure counter

    res.json({
      success: true,
      token: signAdminToken(adminEmail),
      expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString(),
      admin: { email: adminEmail },
    });
  });

  app.get('/api/admin/me', requireAdmin, async (req: Request & { adminUser?: { email?: string } }, res) => {
    res.json({ email: req.adminUser?.email || adminEmail, cafeName: (await store.getSettings()).cafeName });
  });

  // Sessions are stateless (signed tokens), so logging out is a client-side
  // token removal; the token itself simply expires after its 7-day lifetime.
  app.post('/api/admin/logout', requireAdmin, (_req, res) => {
    res.json({ success: true });
  });

  app.get('/api/admin/orders', requireAdmin, async (req, res) => {
    try {
      // `scope=all-tables` is the read-only feed used by the admin dashboard's
      // live order alerts. It deliberately ignores status/table filters so Table 1,
      // Table 2, Table 3, and every later table are all included. No request to
      // this endpoint can edit, remove, or recreate an order.
      let orders = await store.list('orders');
      const isAllTablesFeed = getIdentifier(req.query.scope) === 'all-tables';
      const status = getIdentifier(req.query.status);
      const tableId = getIdentifier(req.query.tableId);
      if (!isAllTablesFeed && status) orders = orders.filter((order) => order.status === status);
      if (!isAllTablesFeed && tableId) orders = orders.filter((order) => order.tableId === tableId);
      orders.sort((a, b) => new Date(b.timeline.createdAt).getTime() - new Date(a.timeline.createdAt).getTime());
      res.set('Cache-Control', 'no-store');
      res.json({ orders, scope: isAllTablesFeed ? 'all-tables' : undefined });
    } catch (error) {
      console.error('Admin orders error:', error);
      jsonError(res, 500, 'Failed to fetch orders from the café database.');
    }
  });

  app.patch('/api/admin/orders/:id/status', requireAdmin, async (req, res) => {
    try {
      const order = await store.get('orders', req.params.id);
      if (!order) return jsonError(res, 404, 'Order not found.');
      const status = req.body?.status as OrderStatus;
      const validStatuses: OrderStatus[] = ['new', 'accepted', 'ready', 'completed', 'cancelled'];
      if (!validStatuses.includes(status)) return jsonError(res, 400, 'Invalid order status.');
      const timestamp = new Date().toISOString();
      const timeline = { ...order.timeline };
      if (status === 'accepted') timeline.acceptedAt = timestamp;
      if (status === 'ready') timeline.readyAt = timestamp;
      if (status === 'completed') timeline.completedAt = timestamp;
      if (status === 'cancelled') timeline.cancelledAt = timestamp;
      const updatedOrder: Order = { ...order, status, timeline, cancellationReason: req.body?.cancellationReason || order.cancellationReason };
      await store.put('orders', updatedOrder);
      res.json({ success: true, order: updatedOrder });
    } catch (error) {
      console.error('Order status error:', error);
      jsonError(res, 500, 'Failed to update order status.');
    }
  });

  app.patch('/api/admin/orders/:id/payment', requireAdmin, async (req, res) => {
    try {
      const order = await store.get('orders', req.params.id);
      if (!order) return jsonError(res, 404, 'Order not found.');
      const paymentStatus = req.body?.paymentStatus as PaymentStatus;
      if (!['unpaid', 'paid', 'refunded'].includes(paymentStatus)) return jsonError(res, 400, 'Invalid payment status.');
      const updatedOrder = { ...order, paymentStatus };
      await store.put('orders', updatedOrder);
      res.json({ success: true, order: updatedOrder });
    } catch (error) {
      console.error('Payment status error:', error);
      jsonError(res, 500, 'Failed to update payment status.');
    }
  });

  app.get('/api/admin/products', requireAdmin, async (_req, res) => {
    res.json({ products: (await store.list('products')).sort((a, b) => a.displayOrder - b.displayOrder) });
  });

  app.post('/api/admin/products', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const timestamp = new Date().toISOString();
      const productId = body.id || newId('prod');
      const image = body.image?.startsWith('data:image/') ? await store.uploadImage(body.image, productId) : (body.image || '');
      const product: Product = {
        id: productId,
        name: getIdentifier(body.name) || 'New Menu Item',
        description: getIdentifier(body.description),
        category: getIdentifier(body.category) || 'Snacks',
        image,
        isAvailable: body.isAvailable !== false,
        isVeg: body.isVeg !== false,
        hasVariants: Boolean(body.hasVariants),
        basePrice: Number(body.basePrice) || 0,
        variants: Array.isArray(body.variants) ? body.variants : [],
        displayOrder: Number(body.displayOrder) || (await store.list('products')).length + 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await store.put('products', product);
      res.status(201).json({ success: true, product });
    } catch (error: any) {
      console.error('Create product error:', error);
      jsonError(res, 500, error?.message || 'Failed to add product.');
    }
  });

  app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
    try {
      const existing = await store.get('products', req.params.id);
      if (!existing) return jsonError(res, 404, 'Product not found.');
      const body = req.body || {};
      let image = body.image !== undefined ? body.image : existing.image;
      if (typeof image === 'string' && image.startsWith('data:image/')) image = await store.uploadImage(image, existing.id);
      const product: Product = {
        ...existing,
        ...body,
        id: existing.id,
        image,
        updatedAt: new Date().toISOString(),
        basePrice: body.basePrice !== undefined ? Number(body.basePrice) || 0 : existing.basePrice,
        variants: Array.isArray(body.variants) ? body.variants : existing.variants,
      };
      await store.put('products', product);
      res.json({ success: true, product });
    } catch (error: any) {
      console.error('Edit product error:', error);
      jsonError(res, 500, error?.message || 'Failed to update product.');
    }
  });

  app.patch('/api/admin/products/:id/availability', requireAdmin, async (req, res) => {
    const product = await store.get('products', req.params.id);
    if (!product) return jsonError(res, 404, 'Product not found.');
    const updated = { ...product, isAvailable: !product.isAvailable, updatedAt: new Date().toISOString() };
    await store.put('products', updated);
    res.json({ success: true, product: updated });
  });

  app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
    const product = await store.get('products', req.params.id);
    if (!product) return jsonError(res, 404, 'Product not found.');
    await store.remove('products', req.params.id);
    res.json({ success: true });
  });

  app.get('/api/admin/tables', requireAdmin, async (_req, res) => {
    const snapshot = await store.snapshot();
    const tables = snapshot.tables.map((table) => ({
      ...table,
      activeOrder: snapshot.orders.find((order) => order.tableId === table.id && ['new', 'accepted', 'ready'].includes(order.status)) || null,
    }));
    res.json({ tables });
  });

  app.post('/api/admin/tables', requireAdmin, async (req, res) => {
    const tableNumber = Number(req.body?.tableNumber);
    if (!Number.isFinite(tableNumber) || tableNumber <= 0) return jsonError(res, 400, 'Valid table number is required.');
    const tables = await store.list('tables');
    if (tables.some((table) => table.tableNumber === tableNumber)) return jsonError(res, 400, `Table ${tableNumber} already exists.`);
    const table: CafeTable = {
      id: newId('tbl'),
      tableNumber,
      name: getIdentifier(req.body?.name) || `Table ${tableNumber}`,
      token: `nexoraosp_tbl_tok_table${tableNumber}_${crypto.randomBytes(6).toString('hex')}`,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    await store.put('tables', table);
    res.status(201).json({ success: true, table });
  });

  app.patch('/api/admin/tables/:id/toggle', requireAdmin, async (req, res) => {
    const table = await store.get('tables', req.params.id);
    if (!table) return jsonError(res, 404, 'Table not found.');
    const updated = { ...table, isActive: !table.isActive };
    await store.put('tables', updated);
    res.json({ success: true, table: updated });
  });

  app.patch('/api/admin/tables/:id/regenerate-token', requireAdmin, async (req, res) => {
    const table = await store.get('tables', req.params.id);
    if (!table) return jsonError(res, 404, 'Table not found.');
    const updated = { ...table, token: `nexoraosp_tbl_tok_table${table.tableNumber}_${crypto.randomBytes(6).toString('hex')}` };
    await store.put('tables', updated);
    res.json({ success: true, table: updated });
  });

  app.delete('/api/admin/tables/:id', requireAdmin, async (req, res) => {
    const table = await store.get('tables', req.params.id);
    if (!table) return jsonError(res, 404, 'Table not found.');
    await store.remove('tables', req.params.id);
    res.json({ success: true });
  });

  app.get('/api/admin/categories', requireAdmin, async (_req, res) => {
    res.json({ categories: (await store.list('categories')).sort((a, b) => a.displayOrder - b.displayOrder) });
  });

  app.post('/api/admin/categories', requireAdmin, async (req, res) => {
    const name = getIdentifier(req.body?.name);
    if (!name) return jsonError(res, 400, 'Category name is required.');
    const categories = await store.list('categories');
    const category: CafeCategory = { id: newId('cat'), name, displayOrder: categories.length + 1 };
    await store.put('categories', category);
    res.status(201).json({ success: true, category });
  });

  app.put('/api/admin/categories/:id', requireAdmin, async (req, res) => {
    const name = getIdentifier(req.body?.name);
    if (!name) return jsonError(res, 400, 'Valid category name is required.');
    const category = await store.get('categories', req.params.id);
    if (!category) return jsonError(res, 404, 'Category not found.');
    const oldName = category.name;
    const updatedCategory = { ...category, name };
    const products = await store.list('products');
    await store.put('categories', updatedCategory);
    await Promise.all(products.filter((product) => product.category.toLowerCase() === oldName.toLowerCase()).map((product) => store.put('products', { ...product, category: name, updatedAt: new Date().toISOString() })));
    res.json({ success: true, category: updatedCategory, updatedProductsCount: products.filter((product) => product.category.toLowerCase() === oldName.toLowerCase()).length });
  });

  app.delete('/api/admin/categories/:id', requireAdmin, async (req, res) => {
    const category = await store.get('categories', req.params.id);
    if (!category) return jsonError(res, 404, 'Category not found.');
    await store.remove('categories', req.params.id);
    res.json({ success: true });
  });

  app.get('/api/admin/waiter-calls', requireAdmin, async (_req, res) => {
    const calls = (await store.list('waiterCalls')).sort((a, b) => new Date(b.calledAt || b.createdAt || 0).getTime() - new Date(a.calledAt || a.createdAt || 0).getTime());
    res.json({ calls });
  });

  app.patch('/api/admin/waiter-calls/:id/attend', requireAdmin, async (req, res) => {
    const call = await store.get('waiterCalls', req.params.id);
    if (!call) return jsonError(res, 404, 'Waiter call not found.');
    const updated = { ...call, status: 'attended' as const, attendedAt: new Date().toISOString() };
    await store.put('waiterCalls', updated);
    res.json({ success: true, call: updated });
  });

  app.get('/api/admin/feedbacks', requireAdmin, async (_req, res) => {
    const feedbacks = (await store.list('feedbacks')).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const averageRating = feedbacks.length ? Number((feedbacks.reduce((sum, item) => sum + item.rating, 0) / feedbacks.length).toFixed(1)) : 0;
    const ratingDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    feedbacks.forEach((item) => { const rating = Math.max(1, Math.min(5, Math.round(item.rating))); ratingDistribution[rating] += 1; });
    res.json({ feedbacks, averageRating, totalFeedbacks: feedbacks.length, ratingDistribution });
  });

  app.get('/api/admin/reports', requireAdmin, async (req, res) => {
    const { range = 'today', startDate, endDate } = req.query;
    const nowDate = new Date();
    let filterStart = new Date(0);
    let filterEnd = new Date();
    if (range === 'today') filterStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
    else if (range === 'yesterday') { filterStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 1); filterEnd = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 1, 23, 59, 59, 999); }
    else if (range === 'week') filterStart = new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    else if (range === 'month') filterStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1);
    else if (range === 'custom' && startDate && endDate) { filterStart = new Date(String(startDate)); filterEnd = new Date(String(endDate)); }

    const orders = (await store.list('orders')).filter((order) => { const date = new Date(order.timeline.createdAt); return date >= filterStart && date <= filterEnd; });
    const completedOrders = orders.filter((order) => order.status === 'completed');
    const cancelledOrders = orders.filter((order) => order.status === 'cancelled');
    const pendingOrders = orders.filter((order) => ['new', 'accepted', 'ready'].includes(order.status));
    const totalRevenue = completedOrders.reduce((sum, order) => sum + order.totalAmount, 0);
    const paidAmount = orders.filter((order) => order.paymentStatus === 'paid').reduce((sum, order) => sum + order.totalAmount, 0);
    const unpaidAmount = orders.filter((order) => order.paymentStatus === 'unpaid' && order.status !== 'cancelled').reduce((sum, order) => sum + order.totalAmount, 0);
    const itemMap = new Map<string, { name: string; variant?: string; quantity: number; revenue: number }>();
    completedOrders.forEach((order) => order.items.forEach((item) => { const key = `${item.productName}_${item.variantName || 'single'}`; const current = itemMap.get(key) || { name: item.productName, variant: item.variantName, quantity: 0, revenue: 0 }; current.quantity += item.quantity; current.revenue += item.totalPrice; itemMap.set(key, current); }));
    const summary: SalesSummary = {
      totalRevenue,
      totalOrders: orders.length,
      completedOrders: completedOrders.length,
      cancelledOrders: cancelledOrders.length,
      pendingOrders: pendingOrders.length,
      averageOrderValue: completedOrders.length ? Math.round(totalRevenue / completedOrders.length) : 0,
      paidAmount,
      unpaidAmount,
      topSellingItems: Array.from(itemMap.values()).sort((a, b) => b.quantity - a.quantity),
      recentOrders: orders.sort((a, b) => new Date(b.timeline.createdAt).getTime() - new Date(a.timeline.createdAt).getTime()).slice(0, 10),
    };
    res.json({ summary });
  });

  app.get('/api/admin/settings', requireAdmin, async (req: Request & { adminUser?: { email?: string } }, res) => {
    res.json({ settings: await store.getSettings(), adminEmail: req.adminUser?.email || adminEmail });
  });

  app.put('/api/admin/settings', requireAdmin, async (req, res) => {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') return jsonError(res, 400, 'Invalid settings payload.');
    const settings = { ...(await store.getSettings()), ...updates };
    await store.putSettings(settings);
    res.json({ success: true, settings });
  });

  // Change the single admin password. It is saved to the active credential
  // store (data/admin.json locally, database on Vercel) and takes effect
  // immediately — no restart and no cloud auth service needed.
  app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
    try {
      const currentPassword = getIdentifier(req.body?.currentPassword);
      const newPassword = getIdentifier(req.body?.newPassword);
      const result = await changeAdminPassword(currentPassword, newPassword);
      if (!result.ok) return jsonError(res, 401, result.message);
      res.json({ success: true, message: result.message });
    } catch (error: any) {
      console.error('Change password error:', error);
      jsonError(res, 500, error?.message || 'Failed to update the admin password.');
    }
  });

  // Returns the most recent audit log entries. Newest first. The
  // fingerprint watermark makes it possible to trace any leaked
  // license back to the original machine.
  app.get('/api/admin/audit', requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      const file = path.join(
        process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/restaurant-data' : path.join(process.cwd(), 'data')),
        'audit.log',
      );
      let raw = '';
      try {
        raw = await fs.promises.readFile(file, 'utf8');
      } catch {
        // No audit log yet — return empty.
        return res.json({ entries: [] });
      }
      // File is one JSON object per line; newest entries are at the end.
      const lines = raw.split(String.fromCharCode(10)).filter((l) => l.trim());
      const entries = lines
        .slice(-limit)
        .reverse()
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
      res.json({ entries });
    } catch (error: any) {
      jsonError(res, 500, error?.message || 'Could not read audit log.');
    }
  });

  return app;
}
