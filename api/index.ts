// Complete self-contained API for Vercel - no external imports from ../src/server
import type { IncomingMessage, ServerResponse } from 'http';
import * as crypto from 'crypto';

// ── In-memory data store (Vercel serverless compatible) ─────────────────────
interface Product {
  id: string;
  name: string;
  description: string;
  category: string;
  image: string;
  isAvailable: boolean;
  isVeg?: boolean;
  hasVariants: boolean;
  basePrice?: number;
  variants?: Array<{ id: string; name: string; price: number }>;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface CafeTable {
  id: string;
  tableNumber: number;
  name: string;
  token: string;
  isActive: boolean;
  createdAt: string;
}

interface Order {
  id: string;
  orderNumber: string;
  tableId: string;
  tableNumber: number;
  tableName: string;
  customerName: string;
  customerPhone?: string;
  items: Array<{
    productId: string;
    productName: string;
    variantId?: string;
    variantName?: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  totalAmount: number;
  status: 'new' | 'accepted' | 'ready' | 'completed' | 'cancelled';
  paymentStatus: 'unpaid' | 'paid' | 'refunded';
  specialInstructions?: string;
  timeline: {
    createdAt: string;
    updatedAt: string;
    acceptedAt?: string;
    readyAt?: string;
    completedAt?: string;
    cancelledAt?: string;
  };
}

interface WaiterCall {
  id: string;
  tableId?: string;
  tableNumber: number;
  tableName: string;
  customerName?: string;
  status: 'pending' | 'attended';
  createdAt: string;
  attendedAt?: string;
}

interface Feedback {
  id: string;
  orderId?: string;
  orderNumber?: string;
  tableNumber: number;
  tableName: string;
  customerName: string;
  rating: number;
  comment: string;
  createdAt: string;
}

// Initial data (inlined from seed.ts to avoid import issues)
const createdAt = '2026-01-01T00:00:00.000Z';

const settings = {
  cafeName: 'Nagori Chai Point',
  tagline: 'Authentic Chai, Fresh Snacks & Quick Bytes',
  address: 'Near City Center, Main Road',
  phone: '+91 9852120609',
  whatsappNumber: '9852120609',
  currency: '₹',
  upiId: '9852120609@upi',
  enableWhatsAppAlerts: true,
  whatsappApiUrl: '',
  whatsappApiToken: '',
  enableSoundAlerts: true,
};

const categories = [
  { id: 'cat-tea-coffee', name: 'Tea & Coffee', displayOrder: 1 },
  { id: 'cat-cold-drinks', name: 'Cold Drinks & Water', displayOrder: 2 },
  { id: 'cat-snacks', name: 'Snacks', displayOrder: 3 },
  { id: 'cat-burgers', name: 'Burgers', displayOrder: 4 },
  { id: 'cat-momos', name: 'Momos', displayOrder: 5 },
  { id: 'cat-chinese', name: 'Chinese', displayOrder: 6 },
];

const tables: CafeTable[] = Array.from({ length: 6 }, (_, index) => {
  const tableNumber = index + 1;
  const suffixes = ['9a2f7c', '4b8e1d', '7c3a9f', '1f5e8b', '3d6a2c', '8e0b4f'];
  return {
    id: `tbl-${tableNumber}`,
    tableNumber,
    name: `Table ${tableNumber}`,
    token: `nagori_tbl_tok_table${tableNumber}_${suffixes[index]}`,
    isActive: true,
    createdAt,
  };
});

const products: Product[] = [
  {
    id: 'prod-tea',
    name: 'Special Masala Chai',
    description: 'Nagori special kadak masala chai prepared with whole spices, fresh ginger, cardamom, and creamy milk.',
    category: 'Tea & Coffee',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: false,
    basePrice: 10,
    displayOrder: 1,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-coffee',
    name: 'Hot Filter Coffee',
    description: 'Aromatic freshly brewed hot filter coffee whipped to frothy perfection with rich milk.',
    category: 'Tea & Coffee',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: false,
    basePrice: 30,
    displayOrder: 2,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-cold-drink',
    name: 'Cold Drink (Chilled 250ml)',
    description: 'Chilled refreshing cold drink can/bottle (Thums Up, Coca Cola, Sprite, Maaza).',
    category: 'Cold Drinks & Water',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: false,
    basePrice: 20,
    displayOrder: 3,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-water-bottle',
    name: 'Packaged Drinking Water',
    description: 'Pure and sealed mineral drinking water bottle chilled to perfection.',
    category: 'Cold Drinks & Water',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: true,
    variants: [
      { id: 'var-water-500ml', name: '500ml Bottle', price: 10 },
      { id: 'var-water-1ltr', name: '1 Litre Bottle', price: 20 },
    ],
    displayOrder: 4,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-samosa',
    name: 'Crispy Samosa',
    description: 'Crispy, golden-fried pastry stuffed with spiced potatoes and peas. Served with tangy mint and sweet tamarind chutneys.',
    category: 'Snacks',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: false,
    basePrice: 10,
    displayOrder: 5,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-burger',
    name: 'Veg Aloo Tikki Burger',
    description: 'Crispy spiced vegetable aloo tikki in a toasted sesame bun with sliced onions, crunchy cabbage, and house sauces.',
    category: 'Burgers',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: false,
    basePrice: 50,
    displayOrder: 6,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-momos-veg',
    name: 'Veg Steamed Momos',
    description: 'Authentic Himalayan dumplings stuffed with freshly seasoned cabbage, carrots, paneer, and herbs. Served with fiery spicy red chili chutney.',
    category: 'Momos',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: true,
    variants: [
      { id: 'var-veg-momos-half', name: 'Half (5 Pcs)', price: 50 },
      { id: 'var-veg-momos-full', name: 'Full (10 Pcs)', price: 90 },
    ],
    displayOrder: 7,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-momos-nonveg',
    name: 'Non-Veg Chicken Momos',
    description: 'Juicy minced chicken infused with ginger, garlic, and special spices inside delicate steamed dumpling wrappers. Served with hot momo dip.',
    category: 'Momos',
    image: '',
    isAvailable: true,
    isVeg: false,
    hasVariants: true,
    variants: [
      { id: 'var-nv-momos-half', name: 'Half (5 Pcs)', price: 70 },
      { id: 'var-nv-momos-full', name: 'Full (10 Pcs)', price: 130 },
    ],
    displayOrder: 8,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-chowmein',
    name: 'Veg Chow Mein',
    description: 'Street-style wok-tossed noodles loaded with crunchy julienned bell peppers, shredded cabbage, carrots, and savory sauces.',
    category: 'Chinese',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: true,
    variants: [
      { id: 'var-chowmein-half', name: 'Half Plate', price: 80 },
      { id: 'var-chowmein-full', name: 'Full Plate', price: 150 },
    ],
    displayOrder: 9,
    createdAt,
    updatedAt: createdAt,
  },
];

// In-memory storage (Vercel serverless - data persists per function instance)
let orders: Order[] = [];
let waiterCalls: WaiterCall[] = [];
let feedbacks: Feedback[] = [];
let orderCounter = 1040;

// Admin authentication (simple HMAC token)
const ADMIN_EMAIL = 'admin@nagoritea.com';
const ADMIN_PASSWORD = '9852120609@';
const SESSION_SECRET = crypto.createHash('sha256').update('nagori-chai-admin-session-v2').digest('hex');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function generateToken(): string {
  const payload = Buffer.from(JSON.stringify({ email: ADMIN_EMAIL, iat: Date.now(), exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token: string): boolean {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (signature !== expected) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Date.now() < decoded.exp;
  } catch {
    return false;
  }
}

function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function sendJson(res: ServerResponse, statusCode: number, data: any) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }
  const token = authHeader.substring(7);
  if (!verifyToken(token)) {
    sendJson(res, 401, { error: 'Invalid or expired token' });
    return false;
  }
  return true;
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    // Health check
    if (path === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { status: 'ok', persistence: 'memory', timestamp: new Date().toISOString() });
    }

    // Public: Get active tables
    if (path === '/api/public/tables' && method === 'GET') {
      const activeTables = tables.filter(t => t.isActive).map(t => ({
        id: t.id, tableNumber: t.tableNumber, name: t.name, token: t.token, isActive: t.isActive, createdAt: t.createdAt
      }));
      return sendJson(res, 200, { tables: activeTables });
    }

    // Public: Get table menu
    if (path.startsWith('/api/table/') && path.endsWith('/orders') && method === 'GET') {
      const token = path.split('/')[3];
      const table = tables.find(t => t.token === token || t.id === token);
      if (!table) return sendJson(res, 404, { error: 'Table not found' });
      const tableOrders = orders.filter(o => o.tableId === table.id).sort((a, b) => new Date(b.timeline.createdAt).getTime() - new Date(a.timeline.createdAt).getTime());
      return sendJson(res, 200, { table: { id: table.id, tableNumber: table.tableNumber, name: table.name, token: table.token }, orders: tableOrders });
    }

    if (path.startsWith('/api/table/') && method === 'GET') {
      const token = path.split('/')[3];
      const table = tables.find(t => t.token === token || t.id === token);
      if (!table) return sendJson(res, 404, { error: 'Table not found' });
      if (!table.isActive) return sendJson(res, 403, { error: 'Table not in service' });
      return sendJson(res, 200, {
        table: { id: table.id, tableNumber: table.tableNumber, name: table.name, token: table.token, isActive: table.isActive, createdAt: table.createdAt },
        settings: { cafeName: settings.cafeName, tagline: settings.tagline, currency: settings.currency, phone: settings.phone, address: settings.address, upiId: settings.upiId },
        categories: categories.sort((a, b) => a.displayOrder - b.displayOrder),
        products: products.filter(p => p.isAvailable).sort((a, b) => a.displayOrder - b.displayOrder),
      });
    }

    // Public: Place order
    if (path === '/api/orders' && method === 'POST') {
      const body = await readBody(req);
      const { tableToken, customerName, customerPhone, items, specialInstructions } = JSON.parse(body);
      const table = tables.find(t => t.token === tableToken || t.id === tableToken);
      if (!table) return sendJson(res, 404, { error: 'Table not found' });
      
      orderCounter++;
      const order: Order = {
        id: generateId('ord'),
        orderNumber: `ORD-${orderCounter}`,
        tableId: table.id,
        tableNumber: table.tableNumber,
        tableName: table.name,
        customerName: customerName || 'Guest',
        customerPhone,
        items: items.map((item: any) => {
          const product = products.find(p => p.id === item.productId);
          if (!product) throw new Error(`Product ${item.productId} not found`);
          const variant = item.variantId ? product.variants?.find(v => v.id === item.variantId) : null;
          const unitPrice = variant ? variant.price : (product.basePrice || 0);
          return {
            productId: item.productId,
            productName: product.name,
            variantId: variant?.id,
            variantName: variant?.name,
            quantity: item.quantity,
            unitPrice,
            totalPrice: unitPrice * item.quantity,
          };
        }),
        totalAmount: 0,
        status: 'new',
        paymentStatus: 'unpaid',
        specialInstructions,
        timeline: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      };
      order.totalAmount = order.items.reduce((sum, item) => sum + item.totalPrice, 0);
      orders.unshift(order);
      return sendJson(res, 201, { success: true, order, message: 'Order placed successfully' });
    }

    // Public: Track order
    if (path.startsWith('/api/orders/track/') && method === 'GET') {
      const orderId = path.split('/')[4];
      const order = orders.find(o => o.id === orderId || o.orderNumber === orderId);
      if (!order) return sendJson(res, 404, { error: 'Order not found' });
      return sendJson(res, 200, { order });
    }

    // Public: Call waiter
    if (path === '/api/waiter-call' && method === 'POST') {
      const body = await readBody(req);
      const { tableToken, tableId, tableNumber, tableName, customerName } = JSON.parse(body);
      const table = tables.find(t => t.token === tableToken || t.id === tableId || t.tableNumber === tableNumber);
      if (!table) return sendJson(res, 404, { error: 'Table not found' });
      
      const call: WaiterCall = {
        id: generateId('call'),
        tableId: table.id,
        tableNumber: table.tableNumber,
        tableName: table.name,
        customerName,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      waiterCalls.unshift(call);
      return sendJson(res, 201, { success: true, call, message: 'Waiter called successfully' });
    }

    // Public: Submit feedback
    if (path === '/api/feedback' && method === 'POST') {
      const body = await readBody(req);
      const { orderId, orderNumber, tableNumber, tableName, customerName, rating, comment } = JSON.parse(body);
      const order = orderId || orderNumber ? orders.find(o => o.id === orderId || o.orderNumber === orderNumber) : null;
      
      const feedback: Feedback = {
        id: generateId('fb'),
        orderId: order?.id,
        orderNumber: order?.orderNumber,
        tableNumber,
        tableName,
        customerName,
        rating,
        comment,
        createdAt: new Date().toISOString(),
      };
      feedbacks.unshift(feedback);
      return sendJson(res, 201, { success: true, feedback, message: 'Feedback submitted successfully' });
    }

    // Admin: Login
    if (path === '/api/admin/login' && method === 'POST') {
      const body = await readBody(req);
      const { password } = JSON.parse(body);
      if (password !== ADMIN_PASSWORD) {
        return sendJson(res, 401, { error: 'Invalid password' });
      }
      return sendJson(res, 200, { success: true, token: generateToken(), admin: { email: ADMIN_EMAIL } });
    }

    // Admin: Get me
    if (path === '/api/admin/me' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { email: ADMIN_EMAIL, cafeName: settings.cafeName });
    }

    // Admin: Get orders
    if (path === '/api/admin/orders' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { orders });
    }

    // Admin: Update order status
    if (path.match(/^\/api\/admin\/orders\/[^\/]+\/status$/) && method === 'PATCH') {
      if (!requireAuth(req, res)) return;
      const orderId = path.split('/')[4];
      const body = await readBody(req);
      const { status, cancellationReason } = JSON.parse(body);
      const order = orders.find(o => o.id === orderId);
      if (!order) return sendJson(res, 404, { error: 'Order not found' });
      
      order.status = status;
      order.timeline.updatedAt = new Date().toISOString();
      if (status === 'accepted') order.timeline.acceptedAt = new Date().toISOString();
      if (status === 'ready') order.timeline.readyAt = new Date().toISOString();
      if (status === 'completed') order.timeline.completedAt = new Date().toISOString();
      if (status === 'cancelled') {
        order.timeline.cancelledAt = new Date().toISOString();
        if (cancellationReason) order.specialInstructions = (order.specialInstructions ? order.specialInstructions + '\n' : '') + `Cancelled: ${cancellationReason}`;
      }
      return sendJson(res, 200, { success: true, order });
    }

    // Admin: Update payment status
    if (path.match(/^\/api\/admin\/orders\/[^\/]+\/payment$/) && method === 'PATCH') {
      if (!requireAuth(req, res)) return;
      const orderId = path.split('/')[4];
      const body = await readBody(req);
      const { paymentStatus } = JSON.parse(body);
      const order = orders.find(o => o.id === orderId);
      if (!order) return sendJson(res, 404, { error: 'Order not found' });
      order.paymentStatus = paymentStatus;
      order.timeline.updatedAt = new Date().toISOString();
      return sendJson(res, 200, { success: true, order });
    }

    // Admin: Get products
    if (path === '/api/admin/products' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { products });
    }

    // Admin: Add product
    if (path === '/api/admin/products' && method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      const product: Product = {
        id: generateId('prod'),
        ...JSON.parse(body),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      products.push(product);
      return sendJson(res, 201, { success: true, product });
    }

    // Admin: Get tables
    if (path === '/api/admin/tables' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      const tablesWithOrders = tables.map(t => ({
        ...t,
        activeOrder: orders.find(o => o.tableId === t.id && ['new', 'accepted', 'ready'].includes(o.status)) || null,
      }));
      return sendJson(res, 200, { tables: tablesWithOrders });
    }

    // Admin: Get categories
    if (path === '/api/admin/categories' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { categories: categories.sort((a, b) => a.displayOrder - b.displayOrder) });
    }

    // Admin: Get waiter calls
    if (path === '/api/admin/waiter-calls' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { calls: waiterCalls });
    }

    // Admin: Attend waiter call
    if (path.match(/^\/api\/admin\/waiter-calls\/[^\/]+\/attend$/) && method === 'PATCH') {
      if (!requireAuth(req, res)) return;
      const callId = path.split('/')[4];
      const call = waiterCalls.find(c => c.id === callId);
      if (!call) return sendJson(res, 404, { error: 'Waiter call not found' });
      call.status = 'attended';
      call.attendedAt = new Date().toISOString();
      return sendJson(res, 200, { success: true, call });
    }

    // Admin: Get feedbacks
    if (path === '/api/admin/feedbacks' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      const avgRating = feedbacks.length > 0 ? feedbacks.reduce((sum, f) => sum + f.rating, 0) / feedbacks.length : 0;
      return sendJson(res, 200, { feedbacks, averageRating: Math.round(avgRating * 10) / 10, totalFeedbacks: feedbacks.length });
    }

    // Admin: Get settings
    if (path === '/api/admin/settings' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      return sendJson(res, 200, { settings, adminEmail: ADMIN_EMAIL });
    }

    // Admin: Update settings
    if (path === '/api/admin/settings' && method === 'PUT') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      Object.assign(settings, JSON.parse(body));
      return sendJson(res, 200, { success: true, settings });
    }

    // Admin: Change password
    if (path === '/api/admin/change-password' && method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      const { currentPassword, newPassword } = JSON.parse(body);
      if (currentPassword !== ADMIN_PASSWORD) {
        return sendJson(res, 401, { error: 'Current password is incorrect' });
      }
      return sendJson(res, 200, { success: true, message: 'Password updated successfully' });
    }

    // Admin: Logout
    if (path === '/api/admin/logout' && method === 'POST') {
      return sendJson(res, 200, { success: true, message: 'Logged out successfully' });
    }

    // Admin: Reports
    if (path === '/api/admin/reports' && method === 'GET') {
      if (!requireAuth(req, res)) return;
      const completedOrders = orders.filter(o => o.status === 'completed');
      const totalRevenue = completedOrders.reduce((sum, o) => sum + o.totalAmount, 0);
      return sendJson(res, 200, { 
        summary: { 
          totalOrders: orders.length,
          completedOrders: completedOrders.length,
          totalRevenue,
          averageOrderValue: completedOrders.length > 0 ? totalRevenue / completedOrders.length : 0
        }
      });
    }

    // Admin: Edit product
    if (path.match(/^\/api\/admin\/products\/[^\/]+$/) && method === 'PUT') {
      if (!requireAuth(req, res)) return;
      const productId = path.split('/')[4];
      const body = await readBody(req);
      const product = products.find(p => p.id === productId);
      if (!product) return sendJson(res, 404, { error: 'Product not found' });
      Object.assign(product, JSON.parse(body), { updatedAt: new Date().toISOString() });
      return sendJson(res, 200, { success: true, product });
    }

    // Admin: Delete product
    if (path.match(/^\/api\/admin\/products\/[^\/]+$/) && method === 'DELETE') {
      if (!requireAuth(req, res)) return;
      const productId = path.split('/')[4];
      const index = products.findIndex(p => p.id === productId);
      if (index === -1) return sendJson(res, 404, { error: 'Product not found' });
      products.splice(index, 1);
      return sendJson(res, 200, { success: true });
    }

    // Admin: Toggle product availability
    if (path.match(/^\/api\/admin\/products\/[^\/]+\/availability$/) && method === 'PATCH') {
      if (!requireAuth(req, res)) return;
      const productId = path.split('/')[4];
      const product = products.find(p => p.id === productId);
      if (!product) return sendJson(res, 404, { error: 'Product not found' });
      product.isAvailable = !product.isAvailable;
      product.updatedAt = new Date().toISOString();
      return sendJson(res, 200, { success: true, product });
    }

    // Admin: Add table
    if (path === '/api/admin/tables' && method === 'POST') {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      const { tableNumber, name } = JSON.parse(body);
      const newTable: CafeTable = {
        id: generateId('tbl'),
        tableNumber,
        name: name || `Table ${tableNumber}`,
        token: `nagori_tbl_tok_table${tableNumber}_${crypto.randomBytes(3).toString('hex')}`,
        isActive: true,
        createdAt: new Date().toISOString()
      };
      tables.push(newTable);
      return sendJson(res, 201, { success: true, table: newTable });
    }

    // Admin: Delete table
    if (path.match(/^\/api\/admin\/tables\/[^\/]+$/) && method === 'DELETE') {
      if (!requireAuth(req, res)) return;
      const tableId = path.split('/')[4];
      const index = tables.findIndex(t => t.id === tableId);
      if (index === -1) return sendJson(res, 404, { error: 'Table not found' });
      tables.splice(index, 1);
      return sendJson(res, 200, { success: true });
    }

    // Admin: Toggle table
    if (path.match(/^\/api\/admin\/tables\/[^\/]+\/toggle$/) && method === 'PATCH') {
      if (!requireAuth(req, res)) return;
      const tableId = path.split('/')[4];
      const table = tables.find(t => t.id === tableId);
      if (!table) return sendJson(res, 404, { error: 'Table not found' });
      table.isActive = !table.isActive;
      return sendJson(res, 200, { success: true, table });
    }

    // Admin: Regenerate table token
    if (path.match(/^\/api\/admin\/tables\/[^\/]+\/regenerate-token$/) && method === 'PATCH') {
      if (!requireAuth(req, res)) return;
      const tableId = path.split('/')[4];
      const table = tables.find(t => t.id === tableId);
      if (!table) return sendJson(res, 404, { error: 'Table not found' });
      table.token = `nagori_tbl_tok_table${table.tableNumber}_${crypto.randomBytes(3).toString('hex')}`;
      return sendJson(res, 200, { success: true, table });
    }

    // Admin: Edit category
    if (path.match(/^\/api\/admin\/categories\/[^\/]+$/) && method === 'PUT') {
      if (!requireAuth(req, res)) return;
      const categoryId = decodeURIComponent(path.split('/')[4]);
      const body = await readBody(req);
      const category = categories.find(c => c.id === categoryId);
      if (!category) return sendJson(res, 404, { error: 'Category not found' });
      category.name = JSON.parse(body).name;
      return sendJson(res, 200, { success: true, category });
    }

    // Admin: Delete category
    if (path.match(/^\/api\/admin\/categories\/[^\/]+$/) && method === 'DELETE') {
      if (!requireAuth(req, res)) return;
      const categoryId = path.split('/')[4];
      const index = categories.findIndex(c => c.id === categoryId);
      if (index === -1) return sendJson(res, 404, { error: 'Category not found' });
      categories.splice(index, 1);
      return sendJson(res, 200, { success: true });
    }

    // 404
    return sendJson(res, 404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Handler error:', error);
    return sendJson(res, 500, { error: 'Internal server error', details: (error as Error).message });
  }
}
