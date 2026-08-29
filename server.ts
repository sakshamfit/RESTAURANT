import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import {
  Product,
  CafeTable,
  Order,
  CafeCategory,
  CafeSettings,
  OrderStatus,
  PaymentStatus,
  SalesSummary,
  WaiterCall,
  CustomerFeedback,
} from './src/types';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health Check API
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    app: 'Nagori Chai Point API',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ----------------------------------------------------
// Persistent Database Store with Atomic Writes
// ----------------------------------------------------
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');

interface DatabaseSchema {
  settings: CafeSettings;
  admin: {
    email: string;
    passwordHash: string;
    salt: string;
  };
  categories: CafeCategory[];
  tables: CafeTable[];
  products: Product[];
  orders: Order[];
  feedbacks: CustomerFeedback[];
  waiterCalls: WaiterCall[];
  orderCounter: number;
}

function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const finalSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, finalSalt, 1000, 64, 'sha512').toString('hex');
  return { hash, salt: finalSalt };
}

function verifyPassword(password: string, hash: string, salt: string): boolean {
  try {
    const testHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512');
    const stored = Buffer.from(String(hash).trim(), 'hex');
    if (testHash.length !== stored.length) return false;
    return crypto.timingSafeEqual(testHash, stored);
  } catch {
    return false;
  }
}

const defaultAdminCreds = hashPassword(process.env.ADMIN_PASSWORD || '9852120609');

const INITIAL_DATA: DatabaseSchema = {
  settings: {
    cafeName: 'Nagori Chai Point',
    tagline: 'Authentic Chai, Fresh Snacks & Quick Bites',
    address: 'Near City Center, Main Road',
    phone: '+91 9852120609',
    whatsappNumber: process.env.WHATSAPP_PHONE_NUMBER || '9852120609',
    currency: '₹',
    upiId: '9852120609@upi',
    enableWhatsAppAlerts: true,
    whatsappApiUrl: process.env.WHATSAPP_API_URL || '',
    whatsappApiToken: process.env.WHATSAPP_API_TOKEN || '',
    enableSoundAlerts: true,
  },
  admin: {
    email: process.env.ADMIN_EMAIL || 'Nagori Tea Point',
    passwordHash: defaultAdminCreds.hash,
    salt: defaultAdminCreds.salt,
  },
  categories: [
    { id: 'cat-tea-coffee', name: 'Tea & Coffee', displayOrder: 1 },
    { id: 'cat-cold-drinks', name: 'Cold Drinks & Water', displayOrder: 2 },
    { id: 'cat-snacks', name: 'Snacks', displayOrder: 3 },
    { id: 'cat-burgers', name: 'Burgers', displayOrder: 4 },
    { id: 'cat-momos', name: 'Momos', displayOrder: 5 },
    { id: 'cat-chinese', name: 'Chinese', displayOrder: 6 },
  ],
  tables: [
    {
      id: 'tbl-1',
      tableNumber: 1,
      name: 'Table 1',
      token: 'nagori_tbl_tok_table1_9a2f7c',
      isActive: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'tbl-2',
      tableNumber: 2,
      name: 'Table 2',
      token: 'nagori_tbl_tok_table2_4b8e1d',
      isActive: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'tbl-3',
      tableNumber: 3,
      name: 'Table 3',
      token: 'nagori_tbl_tok_table3_7c3a9f',
      isActive: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'tbl-4',
      tableNumber: 4,
      name: 'Table 4',
      token: 'nagori_tbl_tok_table4_1f5e8b',
      isActive: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'tbl-5',
      tableNumber: 5,
      name: 'Table 5',
      token: 'nagori_tbl_tok_table5_3d6a2c',
      isActive: true,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'tbl-6',
      tableNumber: 6,
      name: 'Table 6',
      token: 'nagori_tbl_tok_table6_8e0b4f',
      isActive: true,
      createdAt: new Date().toISOString(),
    },
  ],
  products: [
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  orders: [],
  feedbacks: [],
  waiterCalls: [],
  orderCounter: 1040,
};

let db: DatabaseSchema = INITIAL_DATA;

function loadDatabase() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf-8');
      db = JSON.parse(data);
      // Ensure all fields exist if schema evolved
      if (!db.settings) db.settings = INITIAL_DATA.settings;
      db.settings.cafeName = 'Nagori Chai Point';
      if (!db.categories || db.categories.length === 0) db.categories = INITIAL_DATA.categories;
      if (!db.tables || db.tables.length === 0) db.tables = INITIAL_DATA.tables;
      if (!db.orders) db.orders = [];
      if (!db.feedbacks) db.feedbacks = [];
      if (!db.waiterCalls) db.waiterCalls = [];
      if (!db.orderCounter) db.orderCounter = 1040;

      // Merge new categories if missing
      const catNames = new Set(db.categories.map((c) => c.name));
      if (!catNames.has('Cold Drinks & Water')) {
        db.categories.push({ id: 'cat-cold-drinks', name: 'Cold Drinks & Water', displayOrder: 2 });
        db.categories.sort((a, b) => a.displayOrder - b.displayOrder);
      }

      // Merge / ensure initial required products (Cold Drink 20rs, Water Bottle 10/20, Veg & Non-Veg Momos)
      const existingProdIds = new Set((db.products || []).map((p) => p.id));
      INITIAL_DATA.products.forEach((initProd) => {
        if (!existingProdIds.has(initProd.id)) {
          if (!db.products) db.products = [];
          db.products.push(initProd);
        }
      });

      // Ensure isVeg defaults to true if undefined
      db.products.forEach((p) => {
        if (p.isVeg === undefined) {
          p.isVeg = p.id.includes('nonveg') ? false : true;
        }
      });

      // Seed the admin account only if it is missing — credentials stored in
      // data/store.json persist across restarts (change it in Admin > Settings).
      if (!db.admin || !db.admin.passwordHash || !db.admin.salt) {
        const seeded = hashPassword(process.env.ADMIN_PASSWORD || '9852120609');
        db.admin = {
          email: process.env.ADMIN_EMAIL || 'Nagori Tea Point',
          passwordHash: seeded.hash,
          salt: seeded.salt,
        };
      }
      db.settings.whatsappNumber = '9852120609';
      db.settings.phone = '+91 9852120609';
      db.settings.upiId = '9852120609@upi';
      saveDatabase();
    } else {
      saveDatabase();
    }
  } catch (error) {
    console.error('Failed to load database, using in-memory initialization:', error);
    db = INITIAL_DATA;
  }
}

function saveDatabase() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const tempFile = `${DB_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf-8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (error) {
    console.error('Failed to persist database:', error);
  }
}

loadDatabase();

// ----------------------------------------------------
// Admin Auth Middleware
// ----------------------------------------------------
const activeAdminTokens = new Set<string>();

function generateAdminToken(): string {
  const token = `adm_tok_${crypto.randomBytes(32).toString('hex')}`;
  activeAdminTokens.add(token);
  return token;
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }
  const token = authHeader.split(' ')[1];
  if (!activeAdminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired session' });
  }
  next();
}

// ----------------------------------------------------
// Anti-spam Rate Limiter for Orders
// ----------------------------------------------------
const clientOrderTimestamps = new Map<string, number>();

// ----------------------------------------------------
// WhatsApp Dispatcher Helper
// ----------------------------------------------------
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

  // If a real WhatsApp Webhook/Gateway is configured
  if (settings.whatsappApiUrl && settings.whatsappApiToken) {
    try {
      const response = await fetch(settings.whatsappApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.whatsappApiToken}`,
        },
        body: JSON.stringify({
          phone: settings.whatsappNumber,
          message: messageText,
          orderId: order.id,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `WhatsApp API error: ${response.status} - ${errorText}` };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error sending WhatsApp API' };
    }
  }

  // Recorded successfully for direct link dispatch
  return { success: true };
}

// ----------------------------------------------------
// Public APIs (Customer Flow)
// ----------------------------------------------------

// Public API to get list of active tables for in-app QR scanner & selector
app.get('/api/public/tables', (req: Request, res: Response) => {
  const activeTables = db.tables
    .filter((t) => t.isActive)
    .map((t) => ({
      id: t.id,
      tableNumber: t.tableNumber,
      name: t.name,
      token: t.token,
    }))
    .sort((a, b) => a.tableNumber - b.tableNumber);

  res.json({ tables: activeTables });
});

// 1. Get Table Details & Active Menu by Permanent QR Token or Table ID / Number
app.get('/api/table/:token', (req: Request, res: Response) => {
  const rawIdentifier = decodeURIComponent(req.params.token || '').trim();
  const lowerIdentifier = rawIdentifier.toLowerCase().replace(/\s+/g, '');

  // Look up by token, id, tableNumber, or name (e.g. 'table1', 't1', '1')
  const table = db.tables.find((t) => {
    if (t.token === rawIdentifier) return true;
    if (t.id === rawIdentifier) return true;
    if (String(t.tableNumber) === rawIdentifier) return true;
    if (t.name.toLowerCase().replace(/\s+/g, '') === lowerIdentifier) return true;
    if (lowerIdentifier === `t${t.tableNumber}`) return true;
    if (lowerIdentifier === `table${t.tableNumber}`) return true;
    return false;
  });

  if (!table) {
    return res.status(404).json({ error: `Table '${rawIdentifier}' not found or invalid QR code. Please scan a valid café table QR.` });
  }

  if (!table.isActive) {
    return res.status(403).json({ error: `Table ${table.tableNumber} is currently not in service. Please contact staff.` });
  }

  const activeProducts = db.products
    .filter((p) => p.isAvailable)
    .sort((a, b) => a.displayOrder - b.displayOrder);

  const categories = db.categories.sort((a, b) => a.displayOrder - b.displayOrder);

  res.json({
    table: {
      id: table.id,
      tableNumber: table.tableNumber,
      name: table.name,
      token: table.token,
    },
    settings: {
      cafeName: db.settings.cafeName,
      tagline: db.settings.tagline,
      currency: db.settings.currency,
      phone: db.settings.phone,
      address: db.settings.address,
      upiId: db.settings.upiId,
    },
    categories,
    products: activeProducts,
  });
});

// 1b. Get Order History for a specific Table by Token / Table Number
app.get('/api/table/:token/orders', (req: Request, res: Response) => {
  const rawIdentifier = decodeURIComponent(req.params.token || '').trim();
  const lowerIdentifier = rawIdentifier.toLowerCase().replace(/\s+/g, '');

  const table = db.tables.find((t) => {
    if (t.token === rawIdentifier) return true;
    if (t.id === rawIdentifier) return true;
    if (String(t.tableNumber) === rawIdentifier) return true;
    if (t.name.toLowerCase().replace(/\s+/g, '') === lowerIdentifier) return true;
    if (lowerIdentifier === `t${t.tableNumber}`) return true;
    if (lowerIdentifier === `table${t.tableNumber}`) return true;
    return false;
  });

  if (!table) {
    return res.status(404).json({ error: 'Table not found' });
  }

  // Filter all orders placed for this specific table
  const tableOrders = db.orders
    .filter((o) => o.tableId === table.id || o.tableNumber === table.tableNumber)
    .sort((a, b) => new Date(b.timeline.createdAt).getTime() - new Date(a.timeline.createdAt).getTime());

  res.json({
    table: {
      id: table.id,
      tableNumber: table.tableNumber,
      name: table.name,
      token: table.token,
    },
    orders: tableOrders,
  });
});

// 2. Place Customer Order with Strict Server-Side Recalculation
app.post('/api/orders', async (req: Request, res: Response) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const lastOrderTime = clientOrderTimestamps.get(ip) || 0;
    const now = Date.now();

    // Cooldown protection: 3 seconds per IP
    if (now - lastOrderTime < 3000) {
      return res.status(429).json({ error: 'Order submission in progress. Please wait a few seconds.' });
    }
    clientOrderTimestamps.set(ip, now);

    const { tableToken, tableId, tableNumber, tableName, customerName, customerPhone, specialInstructions, items } = req.body;

    if (!customerName || typeof customerName !== 'string' || customerName.trim().length === 0) {
      return res.status(400).json({ error: 'Customer name is required.' });
    }

    const rawIdentifier = (tableToken || tableId || (tableNumber !== undefined ? String(tableNumber) : '') || '').toString().trim();
    const lowerIdentifier = rawIdentifier.toLowerCase().replace(/\s+/g, '');

    let table = db.tables.find((t) => {
      if (tableToken && t.token === tableToken) return true;
      if (tableId && t.id === tableId) return true;
      if (tableNumber !== undefined && t.tableNumber === Number(tableNumber)) return true;
      if (t.token === rawIdentifier) return true;
      if (t.id === rawIdentifier) return true;
      if (String(t.tableNumber) === rawIdentifier) return true;
      if (t.name.toLowerCase().replace(/\s+/g, '') === lowerIdentifier) return true;
      if (lowerIdentifier === `t${t.tableNumber}`) return true;
      if (lowerIdentifier === `table${t.tableNumber}`) return true;
      return false;
    });

    // If table still not found, create or assign if tableNumber is valid
    if (!table && tableNumber) {
      const num = Number(tableNumber);
      if (!isNaN(num) && num > 0) {
        table = {
          id: `tbl-${num}`,
          tableNumber: num,
          name: tableName || `Table ${num}`,
          token: `nagori_tbl_tok_table${num}_auto`,
          isActive: true,
          createdAt: new Date().toISOString(),
        };
        db.tables.push(table);
      }
    }

    if (!table || !table.isActive) {
      return res.status(400).json({ error: 'Invalid or inactive table token.' });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty. Please select food items.' });
    }

    // Recalculate all item prices against server database
    const validatedItems = [];
    let subtotal = 0;

    for (const item of items) {
      const product = db.products.find((p) => p.id === item.productId);
      if (!product) {
        return res.status(400).json({ error: `Product not found: ${item.productName || item.productId}` });
      }
      if (!product.isAvailable) {
        return res.status(400).json({ error: `Item "${product.name}" is currently unavailable.` });
      }

      const quantity = Math.max(1, Math.min(50, Math.floor(Number(item.quantity) || 1)));
      let unitPrice = 0;
      let variantName: string | undefined = undefined;

      if (product.hasVariants) {
        if (!item.variantId) {
          return res.status(400).json({ error: `Please select a size for ${product.name}.` });
        }
        const variant = product.variants?.find((v) => v.id === item.variantId);
        if (!variant) {
          return res.status(400).json({ error: `Invalid size selected for ${product.name}.` });
        }
        unitPrice = variant.price;
        variantName = variant.name;
      } else {
        unitPrice = product.basePrice || 0;
      }

      const itemTotal = unitPrice * quantity;
      subtotal += itemTotal;

      validatedItems.push({
        id: `oi-${crypto.randomBytes(6).toString('hex')}`,
        productId: product.id,
        productName: product.name,
        variantId: item.variantId,
        variantName,
        unitPrice,
        quantity,
        totalPrice: itemTotal,
      });
    }

    db.orderCounter = (db.orderCounter || 1040) + 1;
    const orderNumber = `NC-${db.orderCounter}`;

    const newOrder: Order = {
      id: `ord-${crypto.randomBytes(8).toString('hex')}`,
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
      timeline: {
        createdAt: new Date().toISOString(),
      },
      whatsappNotificationSent: false,
    };

    // Attempt WhatsApp notification
    const whatsappResult = await sendWhatsAppNotification(newOrder, db.settings);
    newOrder.whatsappNotificationSent = whatsappResult.success;
    if (whatsappResult.error) {
      newOrder.whatsappNotificationError = whatsappResult.error;
    }

    db.orders.unshift(newOrder);
    saveDatabase();

    res.status(201).json({
      success: true,
      order: newOrder,
      message: 'Order placed successfully!',
    });
  } catch (error: any) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: 'Internal server error while placing order.' });
  }
});

// 3. Track Order Status for Customer
app.get('/api/orders/track/:orderId', (req: Request, res: Response) => {
  const { orderId } = req.params;
  const order = db.orders.find((o) => o.id === orderId || o.orderNumber === orderId);

  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  res.json({ order });
});

// 4. Customer Waiter Call API
app.post('/api/waiter-call', (req: Request, res: Response) => {
  try {
    const { tableToken, tableId, tableNumber, tableName, customerName } = req.body;
    let targetTable: CafeTable | undefined;

    if (tableToken) {
      const rawIdentifier = String(tableToken).trim();
      targetTable = db.tables.find(
        (t) =>
          t.token === rawIdentifier ||
          t.id === rawIdentifier ||
          String(t.tableNumber) === rawIdentifier
      );
    } else if (tableId) {
      targetTable = db.tables.find((t) => t.id === tableId);
    } else if (tableNumber) {
      targetTable = db.tables.find((t) => t.tableNumber === Number(tableNumber));
    }

    const tNum = targetTable ? targetTable.tableNumber : Number(tableNumber) || 1;
    const tName = targetTable ? targetTable.name : tableName || `Table ${tNum}`;
    const tId = targetTable ? targetTable.id : tableId || `tbl-${tNum}`;

    const newCall: WaiterCall = {
      id: `wc-${crypto.randomBytes(6).toString('hex')}`,
      tableNumber: tNum,
      tableName: tName,
      customerName: customerName ? String(customerName).trim() : undefined,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    if (!db.waiterCalls) db.waiterCalls = [];
    db.waiterCalls.unshift(newCall);
    saveDatabase();

    res.json({
      success: true,
      call: newCall,
      message: `Waiter notified for ${tName}! Staff is heading to your table.`,
    });
  } catch (error) {
    console.error('Waiter call error:', error);
    res.status(500).json({ error: 'Failed to notify waiter.' });
  }
});

// 5. Customer Feedback API
app.post('/api/feedback', (req: Request, res: Response) => {
  try {
    const { orderId, orderNumber, tableNumber, tableName, customerName, rating, comment } = req.body;

    if (!rating || Number(rating) < 1 || Number(rating) > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5 stars.' });
    }

    const newFeedback: CustomerFeedback = {
      id: `fb-${crypto.randomBytes(6).toString('hex')}`,
      orderId: orderId ? String(orderId) : undefined,
      orderNumber: orderNumber ? String(orderNumber) : undefined,
      tableNumber: Number(tableNumber) || 1,
      tableName: tableName ? String(tableName) : `Table ${tableNumber || 1}`,
      customerName: customerName ? String(customerName).trim() : 'Guest Customer',
      rating: Math.max(1, Math.min(5, Math.round(Number(rating)))),
      comment: comment ? String(comment).trim() : '',
      createdAt: new Date().toISOString(),
    };

    if (!db.feedbacks) db.feedbacks = [];
    db.feedbacks.unshift(newFeedback);
    saveDatabase();

    res.status(201).json({
      success: true,
      feedback: newFeedback,
      message: 'Thank you for your valuable rating and feedback!',
    });
  } catch (error) {
    console.error('Feedback submit error:', error);
    res.status(500).json({ error: 'Failed to submit feedback.' });
  }
});

// ----------------------------------------------------
// Admin APIs (Protected)
// ----------------------------------------------------

// Admin Login
app.post('/api/admin/login', (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password is required.' });
  }

  const inputId = email ? String(email).trim().toLowerCase() : 'nagori tea point';
  const allowedUsernames = new Set([
    'nagori tea point',
    'nagoriteapoint',
    'nagori chai point',
    'nagori',
    'admin',
    (db.admin.email || '').toLowerCase(),
  ]);

  if (!allowedUsernames.has(inputId)) {
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }

  if (!verifyPassword(String(password).trim(), db.admin.passwordHash, db.admin.salt)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  const token = generateAdminToken();
  res.json({
    success: true,
    token,
    admin: { email: db.admin.email },
  });
});

// Admin Verify Session
app.get('/api/admin/me', requireAdminAuth, (req: Request, res: Response) => {
  res.json({
    email: db.admin.email,
    cafeName: db.settings.cafeName,
  });
});

// Admin Logout
app.post('/api/admin/logout', requireAdminAuth, (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.split(' ')[1];
    activeAdminTokens.delete(token);
  }
  res.json({ success: true });
});

// Admin Get Orders (with optional status & date filter)
app.get('/api/admin/orders', requireAdminAuth, (req: Request, res: Response) => {
  const { status, tableId, limit } = req.query;

  let filtered = [...db.orders];

  if (status && typeof status === 'string' && status !== 'all') {
    filtered = filtered.filter((o) => o.status === status);
  }

  if (tableId && typeof tableId === 'string') {
    filtered = filtered.filter((o) => o.tableId === tableId);
  }

  if (limit && !isNaN(Number(limit))) {
    filtered = filtered.slice(0, Number(limit));
  }

  res.json({ orders: filtered });
});

// Admin Update Order Status
app.patch('/api/admin/orders/:id/status', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, cancellationReason } = req.body as { status: OrderStatus; cancellationReason?: string };

  const validStatuses: OrderStatus[] = ['new', 'accepted', 'ready', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }

  const order = db.orders.find((o) => o.id === id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const now = new Date().toISOString();
  order.status = status;

  if (status === 'accepted' && !order.timeline.acceptedAt) {
    order.timeline.acceptedAt = now;
  } else if (status === 'ready' && !order.timeline.readyAt) {
    order.timeline.readyAt = now;
  } else if (status === 'completed' && !order.timeline.completedAt) {
    order.timeline.completedAt = now;
  } else if (status === 'cancelled') {
    order.timeline.cancelledAt = now;
    if (cancellationReason) {
      order.cancellationReason = cancellationReason;
    }
  }

  saveDatabase();
  res.json({ success: true, order });
});

// Admin Update Payment Status
app.patch('/api/admin/orders/:id/payment', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const { paymentStatus } = req.body as { paymentStatus: PaymentStatus };

  const validPaymentStatuses: PaymentStatus[] = ['unpaid', 'paid', 'refunded'];
  if (!validPaymentStatuses.includes(paymentStatus)) {
    return res.status(400).json({ error: 'Invalid payment status.' });
  }

  const order = db.orders.find((o) => o.id === id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  order.paymentStatus = paymentStatus;
  saveDatabase();
  res.json({ success: true, order });
});

// Admin Get Products (all, including unavailable)
app.get('/api/admin/products', requireAdminAuth, (req: Request, res: Response) => {
  const products = db.products.sort((a, b) => a.displayOrder - b.displayOrder);
  res.json({ products });
});

// Admin Add Product
app.post('/api/admin/products', requireAdminAuth, (req: Request, res: Response) => {
  const { name, description, category, image, hasVariants, basePrice, variants, isAvailable, isVeg } = req.body;

  if (!name || !category) {
    return res.status(400).json({ error: 'Name and Category are required.' });
  }

  const newProduct: Product = {
    id: `prod-${crypto.randomBytes(6).toString('hex')}`,
    name: name.trim(),
    description: description ? description.trim() : '',
    category: category.trim(),
    image: image ? image.trim() : 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=600&q=80',
    isAvailable: isAvailable !== undefined ? Boolean(isAvailable) : true,
    isVeg: isVeg !== undefined ? Boolean(isVeg) : true,
    hasVariants: Boolean(hasVariants),
    basePrice: hasVariants ? undefined : Number(basePrice) || 0,
    variants: hasVariants && Array.isArray(variants)
      ? variants.map((v, idx) => ({
          id: v.id || `var-${Date.now()}-${idx}`,
          name: String(v.name || '').trim(),
          price: Number(v.price) || 0,
        }))
      : undefined,
    displayOrder: db.products.length + 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  db.products.push(newProduct);
  saveDatabase();
  res.status(201).json({ success: true, product: newProduct });
});

// Admin Edit Product
app.put('/api/admin/products/:id', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const product = db.products.find((p) => p.id === id);

  if (!product) {
    return res.status(404).json({ error: 'Product not found.' });
  }

  const { name, description, category, image, hasVariants, basePrice, variants, isAvailable, isVeg, displayOrder } = req.body;

  if (name) product.name = name.trim();
  if (description !== undefined) product.description = description.trim();
  if (category) product.category = category.trim();
  if (image) product.image = image.trim();
  if (isAvailable !== undefined) product.isAvailable = Boolean(isAvailable);
  if (isVeg !== undefined) product.isVeg = Boolean(isVeg);
  if (displayOrder !== undefined) product.displayOrder = Number(displayOrder);

  product.hasVariants = Boolean(hasVariants);
  if (product.hasVariants) {
    product.basePrice = undefined;
    product.variants = Array.isArray(variants)
      ? variants.map((v, idx) => ({
          id: v.id || `var-${Date.now()}-${idx}`,
          name: String(v.name || '').trim(),
          price: Number(v.price) || 0,
        }))
      : [];
  } else {
    product.basePrice = Number(basePrice) || 0;
    product.variants = undefined;
  }

  product.updatedAt = new Date().toISOString();
  saveDatabase();
  res.json({ success: true, product });
});

// Admin Waiter Calls API
app.get('/api/admin/waiter-calls', requireAdminAuth, (req: Request, res: Response) => {
  const calls = (db.waiterCalls || []).slice(0, 50);
  res.json({ calls });
});

app.patch('/api/admin/waiter-calls/:id/attend', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const call = (db.waiterCalls || []).find((c) => c.id === id);
  if (!call) {
    return res.status(404).json({ error: 'Waiter call request not found.' });
  }
  call.status = 'attended';
  call.attendedAt = new Date().toISOString();
  saveDatabase();
  res.json({ success: true, call });
});

// Admin Feedbacks & Ratings API
app.get('/api/admin/feedbacks', requireAdminAuth, (req: Request, res: Response) => {
  const feedbacks = (db.feedbacks || []).slice(0, 100);
  const total = feedbacks.length;
  const sum = feedbacks.reduce((acc, f) => acc + (Number(f.rating) || 5), 0);
  const averageRating = total > 0 ? parseFloat((sum / total).toFixed(1)) : 5.0;

  const ratingDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  feedbacks.forEach((f) => {
    const r = Math.min(5, Math.max(1, Math.round(Number(f.rating) || 5)));
    ratingDistribution[r] = (ratingDistribution[r] || 0) + 1;
  });

  res.json({
    feedbacks,
    averageRating,
    totalFeedbacks: total,
    ratingDistribution,
  });
});

// Admin Toggle Product Availability
app.patch('/api/admin/products/:id/availability', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const product = db.products.find((p) => p.id === id);

  if (!product) {
    return res.status(404).json({ error: 'Product not found.' });
  }

  product.isAvailable = !product.isAvailable;
  product.updatedAt = new Date().toISOString();
  saveDatabase();
  res.json({ success: true, product });
});

// Admin Delete Product
app.delete('/api/admin/products/:id', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const index = db.products.findIndex((p) => p.id === id);

  if (index === -1) {
    return res.status(404).json({ error: 'Product not found.' });
  }

  db.products.splice(index, 1);
  saveDatabase();
  res.json({ success: true });
});

// Admin Get Tables
app.get('/api/admin/tables', requireAdminAuth, (req: Request, res: Response) => {
  const tablesWithActiveOrders = db.tables.map((tbl) => {
    const activeOrder = db.orders.find(
      (o) => o.tableId === tbl.id && (o.status === 'new' || o.status === 'accepted' || o.status === 'ready')
    );
    return {
      ...tbl,
      activeOrder: activeOrder || null,
    };
  });

  res.json({ tables: tablesWithActiveOrders });
});

// Admin Create Table
app.post('/api/admin/tables', requireAdminAuth, (req: Request, res: Response) => {
  const { tableNumber, name } = req.body;

  const num = Number(tableNumber);
  if (!num || isNaN(num)) {
    return res.status(400).json({ error: 'Valid table number is required.' });
  }

  const existing = db.tables.find((t) => t.tableNumber === num);
  if (existing) {
    return res.status(400).json({ error: `Table ${num} already exists.` });
  }

  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const token = `nagori_tbl_tok_table${num}_${randomSuffix}`;

  const newTable: CafeTable = {
    id: `tbl-${Date.now()}`,
    tableNumber: num,
    name: name ? String(name).trim() : `Table ${num}`,
    token,
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  db.tables.push(newTable);
  db.tables.sort((a, b) => a.tableNumber - b.tableNumber);
  saveDatabase();
  res.status(201).json({ success: true, table: newTable });
});

// Admin Toggle Table Active Status
app.patch('/api/admin/tables/:id/toggle', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const table = db.tables.find((t) => t.id === id);

  if (!table) {
    return res.status(404).json({ error: 'Table not found.' });
  }

  table.isActive = !table.isActive;
  saveDatabase();
  res.json({ success: true, table });
});

// Admin Reset Table Token (in case of misuse)
app.patch('/api/admin/tables/:id/regenerate-token', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const table = db.tables.find((t) => t.id === id);

  if (!table) {
    return res.status(404).json({ error: 'Table not found.' });
  }

  const randomSuffix = crypto.randomBytes(6).toString('hex');
  table.token = `nagori_tbl_tok_table${table.tableNumber}_${randomSuffix}`;
  saveDatabase();
  res.json({ success: true, table });
});

// Admin Delete Table
app.delete('/api/admin/tables/:id', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const index = db.tables.findIndex((t) => t.id === id);

  if (index === -1) {
    return res.status(404).json({ error: 'Table not found.' });
  }

  db.tables.splice(index, 1);
  saveDatabase();
  res.json({ success: true });
});

// Admin Categories
app.get('/api/admin/categories', requireAdminAuth, (req: Request, res: Response) => {
  res.json({ categories: db.categories });
});

app.post('/api/admin/categories', requireAdminAuth, (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Category name is required.' });
  }

  const newCat: CafeCategory = {
    id: `cat-${crypto.randomBytes(4).toString('hex')}`,
    name: name.trim(),
    displayOrder: db.categories.length + 1,
  };

  db.categories.push(newCat);
  saveDatabase();
  res.status(201).json({ success: true, category: newCat });
});

app.put('/api/admin/categories/:id', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Valid category name is required.' });
  }

  const category = db.categories.find((c) => c.id === id);
  if (!category) {
    return res.status(404).json({ error: 'Category not found.' });
  }

  const oldName = category.name;
  const newName = name.trim();
  category.name = newName;

  // Automatically update any existing products categorized under the old category name
  let updatedProductsCount = 0;
  db.products.forEach((p) => {
    if (p.category.toLowerCase() === oldName.toLowerCase()) {
      p.category = newName;
      updatedProductsCount++;
    }
  });

  saveDatabase();
  res.json({ success: true, category, updatedProductsCount });
});

app.delete('/api/admin/categories/:id', requireAdminAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const index = db.categories.findIndex((c) => c.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Category not found.' });
  }
  db.categories.splice(index, 1);
  saveDatabase();
  res.json({ success: true });
});

// Admin Reports & Analytics
app.get('/api/admin/reports', requireAdminAuth, (req: Request, res: Response) => {
  const { range = 'today', startDate, endDate } = req.query;

  const now = new Date();
  let filterStart: Date;
  let filterEnd = new Date();

  if (range === 'today') {
    filterStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  } else if (range === 'yesterday') {
    filterStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
    filterEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
  } else if (range === 'week') {
    filterStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (range === 'month') {
    filterStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  } else if (range === 'custom' && startDate && endDate) {
    filterStart = new Date(String(startDate));
    filterEnd = new Date(String(endDate));
  } else {
    // All time
    filterStart = new Date(0);
  }

  const rangeOrders = db.orders.filter((o) => {
    const orderDate = new Date(o.timeline.createdAt);
    return orderDate >= filterStart && orderDate <= filterEnd;
  });

  const completedOrders = rangeOrders.filter((o) => o.status === 'completed');
  const cancelledOrders = rangeOrders.filter((o) => o.status === 'cancelled');
  const pendingOrders = rangeOrders.filter((o) => o.status === 'new' || o.status === 'accepted' || o.status === 'ready');

  const totalRevenue = completedOrders.reduce((sum, o) => sum + o.totalAmount, 0);
  const paidAmount = rangeOrders.filter((o) => o.paymentStatus === 'paid').reduce((sum, o) => sum + o.totalAmount, 0);
  const unpaidAmount = rangeOrders.filter((o) => o.paymentStatus === 'unpaid' && o.status !== 'cancelled').reduce((sum, o) => sum + o.totalAmount, 0);
  const averageOrderValue = completedOrders.length > 0 ? Math.round(totalRevenue / completedOrders.length) : 0;

  // Top selling items
  const itemMap = new Map<string, { name: string; variant?: string; quantity: number; revenue: number }>();
  for (const order of completedOrders) {
    for (const item of order.items) {
      const key = `${item.productName}_${item.variantName || 'single'}`;
      const curr = itemMap.get(key) || {
        name: item.productName,
        variant: item.variantName,
        quantity: 0,
        revenue: 0,
      };
      curr.quantity += item.quantity;
      curr.revenue += item.totalPrice;
      itemMap.set(key, curr);
    }
  }

  const topSellingItems = Array.from(itemMap.values()).sort((a, b) => b.quantity - a.quantity);

  const summary: SalesSummary = {
    totalRevenue,
    totalOrders: rangeOrders.length,
    completedOrders: completedOrders.length,
    cancelledOrders: cancelledOrders.length,
    pendingOrders: pendingOrders.length,
    averageOrderValue,
    paidAmount,
    unpaidAmount,
    topSellingItems,
    recentOrders: rangeOrders.slice(0, 10),
  };

  res.json({ summary });
});

// Admin Settings
app.get('/api/admin/settings', requireAdminAuth, (req: Request, res: Response) => {
  res.json({
    settings: db.settings,
    adminEmail: db.admin.email,
  });
});

app.put('/api/admin/settings', requireAdminAuth, (req: Request, res: Response) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Invalid settings payload.' });
  }

  db.settings = {
    ...db.settings,
    ...updates,
  };

  saveDatabase();
  res.json({ success: true, settings: db.settings });
});

// Admin Change Password
app.post('/api/admin/change-password', requireAdminAuth, (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }

  const isValid = verifyPassword(currentPassword, db.admin.passwordHash, db.admin.salt);
  if (!isValid) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const { hash, salt } = hashPassword(newPassword);
  db.admin.passwordHash = hash;
  db.admin.salt = salt;
  saveDatabase();

  res.json({ success: true, message: 'Password updated successfully.' });
});

// ----------------------------------------------------
// Vite Middleware / Static Production Server
// ----------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        // Allow the Arena preview host (*.e2b.app) so the app loads in the browser
        allowedHosts: ['.e2b.app'],
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Nagori Tea Point Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
