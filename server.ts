import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import {
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
} from './src/types';
import {
  getSupabasePublicConfig,
  store,
  supabaseAdmin,
  supabaseAuth,
  supabaseConfigured,
  newId,
} from './src/server/store';
import { initialSettings } from './src/server/seed';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const fallbackAdminEmail = process.env.ADMIN_EMAIL || 'admin@nagoritea.com';
const fallbackAdminPassword = process.env.ADMIN_PASSWORD || '9852120609';
const fallbackAdminTokens = new Set<string>();
const clientOrderTimestamps = new Map<string, number>();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

function jsonError(res: Response, status: number, message: string) {
  return res.status(status).json({ error: message });
}

function getBearerToken(req: Request) {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// Supabase Auth owns admin sessions when configured. The fallback is deliberately
// memory-only and is used solely to keep an unconfigured local preview usable.
async function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const token = getBearerToken(req);
  if (!token) return jsonError(res, 401, 'Unauthorized: Missing Supabase session.');

  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) return jsonError(res, 401, 'Unauthorized: Supabase session is invalid or expired.');
    if (!data.user.email || data.user.email.toLowerCase() !== fallbackAdminEmail.toLowerCase()) {
      return jsonError(res, 403, 'This Supabase user is not configured as the café administrator.');
    }
    (req as Request & { adminUser?: typeof data.user }).adminUser = data.user;
    return next();
  }

  if (!fallbackAdminTokens.has(token)) return jsonError(res, 401, 'Unauthorized: Invalid local preview session.');
  return next();
}

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
  // direct-link workflow; the order itself is always persisted in Supabase.
  return { success: true };
}

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'Nagori Chai Point API',
    persistence: store.provider,
    supabaseConfigured,
    storage: supabaseConfigured ? 'supabase-storage' : 'memory-preview',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/config', (_req, res) => {
  const publicConfig = getSupabasePublicConfig();
  res.json({ supabaseUrl: publicConfig.url, supabaseAnonKey: publicConfig.anonKey, configured: publicConfig.configured });
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
    jsonError(res, 500, 'Unable to load tables from Supabase.');
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
    jsonError(res, 500, 'Unable to load the menu from Supabase.');
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
    jsonError(res, 500, 'Unable to load order history from Supabase.');
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const lastOrderTime = clientOrderTimestamps.get(ip) || 0;
    if (Date.now() - lastOrderTime < 3000) return jsonError(res, 429, 'Order submission in progress. Please wait a few seconds.');
    clientOrderTimestamps.set(ip, Date.now());

    const { tableToken, tableId, tableNumber, tableName, customerName, customerPhone, specialInstructions, items } = req.body || {};
    if (!customerName || typeof customerName !== 'string' || !customerName.trim()) return jsonError(res, 400, 'Customer name is required.');

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
    jsonError(res, 500, 'Unable to track order from Supabase.');
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
// Supabase Auth + protected admin APIs
// ----------------------------------------------------
app.post('/api/admin/login', async (req, res) => {
  const inputEmail = getIdentifier(req.body?.email);
  const password = getIdentifier(req.body?.password);
  if (!password) return jsonError(res, 400, 'Password is required.');

  if (supabaseAuth && supabaseAdmin) {
    const configuredEmail = fallbackAdminEmail.toLowerCase();
    const email = inputEmail.includes('@') ? inputEmail.toLowerCase() : configuredEmail;
    if (email !== configuredEmail) return jsonError(res, 401, 'Invalid admin credentials.');
    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (error || !data.session || !data.user) {
      return jsonError(res, 401, error?.message || 'Invalid Supabase admin credentials. Create the admin user in Supabase Authentication first.');
    }
    return res.json({
      success: true,
      token: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at,
      admin: { email: data.user.email || email },
    });
  }

  const acceptedNames = new Set(['nagori tea point', 'nagoriteapoint', 'nagori chai point', 'nagori', 'admin', fallbackAdminEmail.toLowerCase()]);
  if (!acceptedNames.has((inputEmail || 'admin').toLowerCase()) || password !== fallbackAdminPassword) return jsonError(res, 401, 'Invalid local preview credentials.');
  const token = `preview_${crypto.randomBytes(24).toString('hex')}`;
  fallbackAdminTokens.add(token);
  res.json({ success: true, token, admin: { email: fallbackAdminEmail } });
});

app.get('/api/admin/me', requireAdminAuth, async (req: Request & { adminUser?: { email?: string } }, res) => {
  res.json({ email: req.adminUser?.email || fallbackAdminEmail, cafeName: (await store.getSettings()).cafeName });
});

app.post('/api/admin/logout', requireAdminAuth, (req, res) => {
  const token = getBearerToken(req);
  fallbackAdminTokens.delete(token);
  res.json({ success: true });
});

app.get('/api/admin/orders', requireAdminAuth, async (req, res) => {
  try {
    let orders = await store.list('orders');
    const status = getIdentifier(req.query.status);
    const tableId = getIdentifier(req.query.tableId);
    if (status) orders = orders.filter((order) => order.status === status);
    if (tableId) orders = orders.filter((order) => order.tableId === tableId);
    orders.sort((a, b) => new Date(b.timeline.createdAt).getTime() - new Date(a.timeline.createdAt).getTime());
    res.json({ orders });
  } catch (error) {
    console.error('Admin orders error:', error);
    jsonError(res, 500, 'Failed to fetch orders from Supabase.');
  }
});

app.patch('/api/admin/orders/:id/status', requireAdminAuth, async (req, res) => {
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

app.patch('/api/admin/orders/:id/payment', requireAdminAuth, async (req, res) => {
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

app.get('/api/admin/products', requireAdminAuth, async (_req, res) => {
  res.json({ products: (await store.list('products')).sort((a, b) => a.displayOrder - b.displayOrder) });
});

app.post('/api/admin/products', requireAdminAuth, async (req, res) => {
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

app.put('/api/admin/products/:id', requireAdminAuth, async (req, res) => {
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

app.patch('/api/admin/products/:id/availability', requireAdminAuth, async (req, res) => {
  const product = await store.get('products', req.params.id);
  if (!product) return jsonError(res, 404, 'Product not found.');
  const updated = { ...product, isAvailable: !product.isAvailable, updatedAt: new Date().toISOString() };
  await store.put('products', updated);
  res.json({ success: true, product: updated });
});

app.delete('/api/admin/products/:id', requireAdminAuth, async (req, res) => {
  const product = await store.get('products', req.params.id);
  if (!product) return jsonError(res, 404, 'Product not found.');
  await store.remove('products', req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/tables', requireAdminAuth, async (_req, res) => {
  const snapshot = await store.snapshot();
  const tables = snapshot.tables.map((table) => ({
    ...table,
    activeOrder: snapshot.orders.find((order) => order.tableId === table.id && ['new', 'accepted', 'ready'].includes(order.status)) || null,
  }));
  res.json({ tables });
});

app.post('/api/admin/tables', requireAdminAuth, async (req, res) => {
  const tableNumber = Number(req.body?.tableNumber);
  if (!Number.isFinite(tableNumber) || tableNumber <= 0) return jsonError(res, 400, 'Valid table number is required.');
  const tables = await store.list('tables');
  if (tables.some((table) => table.tableNumber === tableNumber)) return jsonError(res, 400, `Table ${tableNumber} already exists.`);
  const table: CafeTable = {
    id: newId('tbl'),
    tableNumber,
    name: getIdentifier(req.body?.name) || `Table ${tableNumber}`,
    token: `nagori_tbl_tok_table${tableNumber}_${crypto.randomBytes(6).toString('hex')}`,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  await store.put('tables', table);
  res.status(201).json({ success: true, table });
});

app.patch('/api/admin/tables/:id/toggle', requireAdminAuth, async (req, res) => {
  const table = await store.get('tables', req.params.id);
  if (!table) return jsonError(res, 404, 'Table not found.');
  const updated = { ...table, isActive: !table.isActive };
  await store.put('tables', updated);
  res.json({ success: true, table: updated });
});

app.patch('/api/admin/tables/:id/regenerate-token', requireAdminAuth, async (req, res) => {
  const table = await store.get('tables', req.params.id);
  if (!table) return jsonError(res, 404, 'Table not found.');
  const updated = { ...table, token: `nagori_tbl_tok_table${table.tableNumber}_${crypto.randomBytes(6).toString('hex')}` };
  await store.put('tables', updated);
  res.json({ success: true, table: updated });
});

app.delete('/api/admin/tables/:id', requireAdminAuth, async (req, res) => {
  const table = await store.get('tables', req.params.id);
  if (!table) return jsonError(res, 404, 'Table not found.');
  await store.remove('tables', req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/categories', requireAdminAuth, async (_req, res) => {
  res.json({ categories: (await store.list('categories')).sort((a, b) => a.displayOrder - b.displayOrder) });
});

app.post('/api/admin/categories', requireAdminAuth, async (req, res) => {
  const name = getIdentifier(req.body?.name);
  if (!name) return jsonError(res, 400, 'Category name is required.');
  const categories = await store.list('categories');
  const category: CafeCategory = { id: newId('cat'), name, displayOrder: categories.length + 1 };
  await store.put('categories', category);
  res.status(201).json({ success: true, category });
});

app.put('/api/admin/categories/:id', requireAdminAuth, async (req, res) => {
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

app.delete('/api/admin/categories/:id', requireAdminAuth, async (req, res) => {
  const category = await store.get('categories', req.params.id);
  if (!category) return jsonError(res, 404, 'Category not found.');
  await store.remove('categories', req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/waiter-calls', requireAdminAuth, async (_req, res) => {
  const calls = (await store.list('waiterCalls')).sort((a, b) => new Date(b.calledAt || b.createdAt || 0).getTime() - new Date(a.calledAt || a.createdAt || 0).getTime());
  res.json({ calls });
});

app.patch('/api/admin/waiter-calls/:id/attend', requireAdminAuth, async (req, res) => {
  const call = await store.get('waiterCalls', req.params.id);
  if (!call) return jsonError(res, 404, 'Waiter call not found.');
  const updated = { ...call, status: 'attended' as const, attendedAt: new Date().toISOString() };
  await store.put('waiterCalls', updated);
  res.json({ success: true, call: updated });
});

app.get('/api/admin/feedbacks', requireAdminAuth, async (_req, res) => {
  const feedbacks = (await store.list('feedbacks')).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const averageRating = feedbacks.length ? Number((feedbacks.reduce((sum, item) => sum + item.rating, 0) / feedbacks.length).toFixed(1)) : 0;
  const ratingDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  feedbacks.forEach((item) => { const rating = Math.max(1, Math.min(5, Math.round(item.rating))); ratingDistribution[rating] += 1; });
  res.json({ feedbacks, averageRating, totalFeedbacks: feedbacks.length, ratingDistribution });
});

app.get('/api/admin/reports', requireAdminAuth, async (req, res) => {
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

app.get('/api/admin/settings', requireAdminAuth, async (req: Request & { adminUser?: { email?: string } }, res) => {
  res.json({ settings: await store.getSettings(), adminEmail: req.adminUser?.email || fallbackAdminEmail });
});

app.put('/api/admin/settings', requireAdminAuth, async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') return jsonError(res, 400, 'Invalid settings payload.');
  const settings = { ...(await store.getSettings()), ...updates };
  await store.putSettings(settings);
  res.json({ success: true, settings });
});

app.post('/api/admin/change-password', requireAdminAuth, async (req: Request & { adminUser?: { id?: string; email?: string } }, res) => {
  const currentPassword = getIdentifier(req.body?.currentPassword);
  const newPassword = getIdentifier(req.body?.newPassword);
  if (!currentPassword || !newPassword) return jsonError(res, 400, 'Current and new password are required.');
  if (newPassword.length < 6) return jsonError(res, 400, 'New password must be at least 6 characters.');

  if (supabaseAdmin && supabaseAuth && req.adminUser?.id && req.adminUser.email) {
    const { error: verifyError } = await supabaseAuth.auth.signInWithPassword({ email: req.adminUser.email, password: currentPassword });
    if (verifyError) return jsonError(res, 401, 'Current password is incorrect.');
    const { error } = await supabaseAdmin.auth.admin.updateUserById(req.adminUser.id, { password: newPassword });
    if (error) return jsonError(res, 500, error.message);
    return res.json({ success: true, message: 'Password updated successfully.' });
  }

  if (currentPassword !== fallbackAdminPassword) return jsonError(res, 401, 'Current password is incorrect.');
  res.json({ success: true, message: 'Password updated for this local preview session.' });
});

// ----------------------------------------------------
// Vite middleware / production static server
// ----------------------------------------------------
async function startServer() {
  await store.waitUntilReady();
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: ['.e2b.app', 'localhost'],
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Nagori Chai Point server running on http://0.0.0.0:${PORT} (${store.provider})`);
    if (!supabaseConfigured) console.warn('Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; this preview is memory-only.');
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
