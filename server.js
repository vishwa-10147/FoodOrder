require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');
const Razorpay = require('razorpay');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'restaurant.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const APP_START_TIME = Date.now();
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';

const RATE_LIMIT_WINDOW_MS = Math.max(1000, Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000));
const RATE_LIMIT_MAX = Math.max(1, Number(process.env.RATE_LIMIT_MAX || 240));

const DB_BACKUP_ENABLED = String(process.env.DB_BACKUP_ENABLED || 'true') !== 'false';
const DB_BACKUP_INTERVAL_MINUTES = Math.max(1, Number(process.env.DB_BACKUP_INTERVAL_MINUTES || 60));
const DB_BACKUP_RETENTION_COUNT = Math.max(1, Number(process.env.DB_BACKUP_RETENTION_COUNT || 48));

const RAZORPAY_KEY_ID = String(process.env.RAZORPAY_KEY_ID || '').trim();
const RAZORPAY_KEY_SECRET = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
const RAZORPAY_WEBHOOK_SECRET = String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
const RAZORPAY_ENABLED = Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);

const razorpay = RAZORPAY_ENABLED
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null;

let lastBackupAt = null;

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

function toSafeTimestampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function getRateLimitKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function createMemoryRateLimiter({ windowMs, max, keyPrefix, skip }) {
  const buckets = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.min(windowMs, 60 * 1000)).unref();

  return (req, res, next) => {
    if (typeof skip === 'function' && skip(req)) return next();

    const now = Date.now();
    const key = `${keyPrefix}:${getRateLimitKey(req)}`;
    const existing = buckets.get(key);
    const bucket = !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : existing;

    bucket.count += 1;
    buckets.set(key, bucket);

    if (bucket.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests, please retry shortly' });
    }

    return next();
  };
}

async function runDatabaseBackup(reason = 'scheduled') {
  if (!DB_BACKUP_ENABLED) return;

  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    db.pragma('wal_checkpoint(PASSIVE)');
    const fileName = `restaurant-${toSafeTimestampForFile()}.db`;
    const destination = path.join(BACKUP_DIR, fileName);
    await db.backup(destination);
    lastBackupAt = Date.now();

    const backupFiles = fs.readdirSync(BACKUP_DIR)
      .filter((name) => /^restaurant-\d{8}T\d{6}Z\.db$/.test(name))
      .sort((a, b) => b.localeCompare(a));

    backupFiles.slice(DB_BACKUP_RETENTION_COUNT).forEach((name) => {
      const stalePath = path.join(BACKUP_DIR, name);
      try {
        fs.unlinkSync(stalePath);
      } catch (_err) {
      }
    });

    // eslint-disable-next-line no-console
    console.log(`[backup:${reason}] ${destination}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[backup:${reason}] failed`, error.message);
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  category TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS table_status (
  restaurant_id INTEGER NOT NULL DEFAULT 1,
  table_number INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('free','ordering','occupied'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL DEFAULT 1,
  order_type TEXT NOT NULL CHECK(order_type IN ('dine','takeaway','preorder')),
  table_number INTEGER,
  notes TEXT DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('new','preparing','ready','delivered')),
  source TEXT NOT NULL DEFAULT 'direct',
  external_order_id TEXT,
  paid INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  payment_gateway_order_id TEXT,
  payment_gateway_payment_id TEXT,
  paid_at INTEGER,
  eta_minutes INTEGER NOT NULL DEFAULT 15,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  menu_item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  item_price INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  actor TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);
`);

const seedMenu = [
  { name: 'Butter chicken', description: 'Creamy tomato gravy', price: 180, emoji: '🍛', category: 'mains' },
  { name: 'Paneer tikka', description: 'Grilled cottage cheese', price: 160, emoji: '🫕', category: 'starters' },
  { name: 'Dal makhani', description: 'Slow-cooked black lentils', price: 140, emoji: '🥘', category: 'mains' },
  { name: 'Garlic naan', description: 'Soft leavened bread', price: 50, emoji: '🫓', category: 'breads' },
  { name: 'Veg biryani', description: 'Fragrant basmati rice', price: 180, emoji: '🍚', category: 'mains' },
  { name: 'Mango lassi', description: 'Chilled yoghurt drink', price: 80, emoji: '🥛', category: 'drinks' },
  { name: 'Masala chai', description: 'Spiced milk tea', price: 40, emoji: '☕', category: 'drinks' },
  { name: 'Samosa', description: 'Crispy pastry, potato fill', price: 30, emoji: '🥟', category: 'starters' }
];

function toOrderLabel(id) {
  return `#${String(id).padStart(4, '0')}`;
}

function getActor(req) {
  const actor = req.headers['x-actor'];
  return typeof actor === 'string' && actor.trim() ? actor.trim() : 'system';
}

function logAudit({ action, entityType, entityId = null, actor = 'system', details = null }) {
  db.prepare(
    'INSERT INTO audit_logs (action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(action, entityType, entityId ? String(entityId) : null, actor, details ? JSON.stringify(details) : null, Date.now());
}

function getAuditLogs(limit = 30) {
  const safeLimit = Number(limit) > 0 ? Math.min(Number(limit), 200) : 30;
  const rows = db.prepare(
    `SELECT id, action, entity_type as entityType, entity_id as entityId, actor, details, created_at as createdAt
     FROM audit_logs
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(safeLimit);

  return rows.map((row) => ({
    ...row,
    details: row.details ? JSON.parse(row.details) : null
  }));
}

function normalizeRestaurantCode(input) {
  const raw = String(input || '').trim().toLowerCase();
  return raw.replace(/[^a-z0-9_-]/g, '').slice(0, 64);
}

function resolveRestaurantByCode(restaurantCode, fallbackName = '') {
  const now = Date.now();
  const normalizedCode = normalizeRestaurantCode(restaurantCode) || 'default';
  const existing = db.prepare('SELECT id, code, name FROM restaurants WHERE code = ?').get(normalizedCode);
  if (existing) return existing;

  const safeName = String(fallbackName || '').trim() || normalizedCode.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  db.prepare('INSERT INTO restaurants (code, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(normalizedCode, safeName, now, now);
  return db.prepare('SELECT id, code, name FROM restaurants WHERE code = ?').get(normalizedCode);
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      const isEscapedQuote = inQuotes && line[i + 1] === '"';
      if (isEscapedQuote) {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function parseMenuCsv(csvText) {
  const text = String(csvText || '').replace(/^\uFEFF/, '');
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (!lines.length) return { rows: [], invalidRows: [] };

  const headerValues = parseCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase());
  const hasHeader = headerValues.includes('item') || headerValues.includes('name') || headerValues.includes('price');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const rows = [];
  const invalidRows = [];

  dataLines.forEach((line, index) => {
    const parsed = parseCsvLine(line);
    if (parsed.length < 3) {
      invalidRows.push({ line: index + (hasHeader ? 2 : 1), reason: 'Expected at least 3 columns: Category, Item, Price' });
      return;
    }

    const category = String(parsed[0] || '').trim() || 'other';
    const name = String(parsed[1] || '').trim();
    const priceText = String(parsed[2] || '').replace(/[^\d.]/g, '');
    const numericPrice = Number(priceText);
    const price = Math.round(numericPrice);
    const description = String(parsed[3] || '').trim() || `${category} menu item`;

    if (!name) {
      invalidRows.push({ line: index + (hasHeader ? 2 : 1), reason: 'Item name is empty' });
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      invalidRows.push({ line: index + (hasHeader ? 2 : 1), reason: `Invalid price: ${parsed[2] || ''}` });
      return;
    }

    rows.push({
      name,
      description,
      price,
      category: category.toLowerCase(),
      emoji: '🍽️',
      available: 1
    });
  });

  return { rows, invalidRows };
}

function seedDatabase() {
  const now = Date.now();
  const defaultRestaurant = db.prepare('SELECT id FROM restaurants WHERE code = ?').get('default');
  if (!defaultRestaurant) {
    db.prepare('INSERT INTO restaurants (code, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('default', 'Default Restaurant', now, now);
  }

  const menuColumns = db.prepare('PRAGMA table_info(menu_items)').all();
  const hasAvailableColumn = menuColumns.some((col) => col.name === 'available');
  const hasMenuRestaurantIdColumn = menuColumns.some((col) => col.name === 'restaurant_id');
  if (!hasAvailableColumn) {
    db.exec('ALTER TABLE menu_items ADD COLUMN available INTEGER NOT NULL DEFAULT 1');
  }
  if (!hasMenuRestaurantIdColumn) {
    db.exec('ALTER TABLE menu_items ADD COLUMN restaurant_id INTEGER NOT NULL DEFAULT 1');
  }
  db.exec('UPDATE menu_items SET restaurant_id = 1 WHERE restaurant_id IS NULL OR restaurant_id < 1');

  const tableColumns = db.prepare('PRAGMA table_info(table_status)').all();
  const hasTableRestaurantIdColumn = tableColumns.some((col) => col.name === 'restaurant_id');
  if (!hasTableRestaurantIdColumn) {
    db.exec('ALTER TABLE table_status ADD COLUMN restaurant_id INTEGER NOT NULL DEFAULT 1');
  }
  db.exec('UPDATE table_status SET restaurant_id = 1 WHERE restaurant_id IS NULL OR restaurant_id < 1');

  const orderColumnsForRestaurant = db.prepare('PRAGMA table_info(orders)').all();
  const hasOrderRestaurantIdColumn = orderColumnsForRestaurant.some((col) => col.name === 'restaurant_id');
  if (!hasOrderRestaurantIdColumn) {
    db.exec('ALTER TABLE orders ADD COLUMN restaurant_id INTEGER NOT NULL DEFAULT 1');
  }
  db.exec('UPDATE orders SET restaurant_id = 1 WHERE restaurant_id IS NULL OR restaurant_id < 1');

  const menuCount = db.prepare('SELECT COUNT(*) as count FROM menu_items').get().count;
  if (menuCount === 0) {
    const insertMenu = db.prepare(
      'INSERT INTO menu_items (name, description, price, emoji, category) VALUES (?, ?, ?, ?, ?)'
    );
    const tx = db.transaction((items) => {
      items.forEach((item) => insertMenu.run(item.name, item.description, item.price, item.emoji, item.category));
    });
    tx(seedMenu);
  }

  const orderColumns = db.prepare('PRAGMA table_info(orders)').all();
  const hasPaymentMethodColumn = orderColumns.some((col) => col.name === 'payment_method');
  const hasPaymentGatewayOrderIdColumn = orderColumns.some((col) => col.name === 'payment_gateway_order_id');
  const hasPaymentGatewayPaymentIdColumn = orderColumns.some((col) => col.name === 'payment_gateway_payment_id');
  const hasPaidAtColumn = orderColumns.some((col) => col.name === 'paid_at');
  const hasSourceColumn = orderColumns.some((col) => col.name === 'source');
  const hasExternalOrderIdColumn = orderColumns.some((col) => col.name === 'external_order_id');
  if (!hasPaymentMethodColumn) {
    db.exec('ALTER TABLE orders ADD COLUMN payment_method TEXT');
  }
  if (!hasPaymentGatewayOrderIdColumn) {
    db.exec('ALTER TABLE orders ADD COLUMN payment_gateway_order_id TEXT');
  }
  if (!hasPaymentGatewayPaymentIdColumn) {
    db.exec('ALTER TABLE orders ADD COLUMN payment_gateway_payment_id TEXT');
  }
  if (!hasPaidAtColumn) {
    db.exec('ALTER TABLE orders ADD COLUMN paid_at INTEGER');
  }
  if (!hasSourceColumn) {
    db.exec("ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'direct'");
  }
  if (!hasExternalOrderIdColumn) {
    db.exec('ALTER TABLE orders ADD COLUMN external_order_id TEXT');
  }

  // Ensure the external order id uniqueness index exists after legacy schemas are migrated.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external_order_id
    ON orders(external_order_id)
    WHERE external_order_id IS NOT NULL;
  `);

  const tableCount = db.prepare('SELECT COUNT(*) as count FROM table_status').get().count;
  if (tableCount === 0) {
    const insertTable = db.prepare('INSERT INTO table_status (table_number, status) VALUES (?, ?)');
    const tx = db.transaction(() => {
      for (let i = 1; i <= 14; i += 1) {
        const defaultStatus = [1, 3, 5, 7].includes(i) ? 'occupied' : [4].includes(i) ? 'ordering' : 'free';
        insertTable.run(i, defaultStatus);
      }
    });
    tx();
  }

  const orderCount = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
  if (orderCount === 0) {
    const tableNumbers = db.prepare('SELECT table_number as tableNumber FROM table_status ORDER BY table_number ASC').all();
    if (!tableNumbers.length) return;

    const preferredDineTable = tableNumbers.find((row) => row.tableNumber === 4)?.tableNumber || tableNumbers[0].tableNumber;
    const preferredPreorderTable = tableNumbers.find((row) => row.tableNumber !== preferredDineTable)?.tableNumber || preferredDineTable;

    createOrder({
      orderType: 'dine',
      tableNumber: preferredDineTable,
      notes: 'Less spice please',
      items: [
        { menuItemId: 1, qty: 2 },
        { menuItemId: 4, qty: 3 },
        { menuItemId: 6, qty: 1 }
      ],
      status: 'preparing',
      paid: 0,
      etaMinutes: 12
    });
    createOrder({
      orderType: 'preorder',
      tableNumber: preferredPreorderTable,
      notes: 'Pickup at 1:15 PM',
      items: [
        { menuItemId: 2, qty: 1 },
        { menuItemId: 3, qty: 1 },
        { menuItemId: 5, qty: 1 }
      ],
      status: 'new',
      paid: 0,
      etaMinutes: 18
    });
  }

}

function getMenuMap() {
  const rows = db.prepare('SELECT id, name, price FROM menu_items WHERE available = 1').all();
  return rows.reduce((acc, row) => {
    acc[row.id] = row;
    return acc;
  }, {});
}

function getMenuByNameMap() {
  const rows = db.prepare('SELECT id, name, price FROM menu_items').all();
  return rows.reduce((acc, row) => {
    acc[String(row.name || '').trim().toLowerCase()] = row;
    return acc;
  }, {});
}

function createOrder({
  orderType,
  tableNumber = null,
  notes = '',
  items,
  status = 'new',
  paid = 0,
  etaMinutes = 15,
  source = 'direct',
  externalOrderId = null
}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Order must contain items');
  }

  const menuMap = getMenuMap();
  const normalizedItems = items
    .map((item) => ({ menu: menuMap[item.menuItemId], qty: Number(item.qty) || 0, menuItemId: item.menuItemId }))
    .filter((item) => item.menu && item.qty > 0);

  if (normalizedItems.length === 0) {
    throw new Error('Order contains invalid items');
  }

  if (orderType === 'dine' || orderType === 'preorder') {
    const exists = db.prepare('SELECT table_number FROM table_status WHERE table_number = ?').get(tableNumber);
    if (!exists) throw new Error('Selected table does not exist');
  }

  const now = Date.now();
  const insertOrder = db.prepare(
     `INSERT INTO orders (order_type, table_number, notes, status, source, external_order_id, paid, eta_minutes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, menu_item_id, item_name, item_price, qty)
     VALUES (?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    const result = insertOrder.run(orderType, tableNumber, notes, status, source, externalOrderId, paid, etaMinutes, now, now);
    normalizedItems.forEach((item) => {
      insertItem.run(result.lastInsertRowid, item.menuItemId, item.menu.name, item.menu.price, item.qty);
    });
    if ((orderType === 'dine' || orderType === 'preorder') && tableNumber) {
      const initialStatus = orderType === 'preorder' ? 'ordering' : 'occupied';
      db.prepare('UPDATE table_status SET status = ? WHERE table_number = ?').run(initialStatus, tableNumber);
    }
    return result.lastInsertRowid;
  });

  return tx();
}

function getOrders() {
  const orders = db.prepare(
    `SELECT id, restaurant_id as restaurantId, order_type as orderType, table_number as tableNumber, notes, status, source, external_order_id as externalOrderId, paid, payment_method as paymentMethod, payment_gateway_order_id as paymentGatewayOrderId, payment_gateway_payment_id as paymentGatewayPaymentId, paid_at as paidAt, eta_minutes as etaMinutes, created_at as createdAt, updated_at as updatedAt
     FROM orders
     ORDER BY created_at DESC`
  ).all();

  const items = db.prepare(
    `SELECT order_id as orderId, item_name as name, item_price as price, qty
     FROM order_items`
  ).all();

  const byOrder = items.reduce((acc, item) => {
    if (!acc[item.orderId]) acc[item.orderId] = [];
    acc[item.orderId].push(item);
    return acc;
  }, {});

  return orders.map((order) => {
    const orderItems = byOrder[order.id] || [];
    const subtotal = orderItems.reduce((sum, item) => sum + item.price * item.qty, 0);
    const tax = Math.round(subtotal * 0.05);
    const service = Math.round(subtotal * 0.04);
    const total = subtotal + tax + service;
    return {
      ...order,
      label: toOrderLabel(order.id),
      items: orderItems,
      subtotal,
      tax,
      service,
      total,
      progress: order.status === 'new' ? 20 : order.status === 'preparing' ? 56 : order.status === 'ready' ? 82 : 100
    };
  });
}

function getStats(orders, tables) {
  const activeOrders = orders.filter((o) => o.status !== 'delivered').length;
  const now = Date.now();
  const overdue = orders.filter((o) => o.status !== 'delivered' && now - o.createdAt > o.etaMinutes * 60000).length;
  const waitingOrders = orders.filter((o) => o.status !== 'delivered');
  const avgWait = waitingOrders.length
    ? Math.round(waitingOrders.reduce((sum, o) => sum + (now - o.createdAt) / 60000, 0) / waitingOrders.length)
    : 0;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const revenueToday = orders
    .filter((o) => o.paid === 1 && o.createdAt >= todayStart.getTime())
    .reduce((sum, o) => sum + o.total, 0);

  const occupiedTables = tables.filter((t) => t.status === 'occupied' || t.status === 'ordering').length;

  return {
    activeOrders,
    overdue,
    avgWait,
    revenueToday,
    occupiedTables,
    tableCapacity: tables.length
  };
}

function getState() {
  const menu = db.prepare(
    'SELECT id, restaurant_id as restaurantId, name, description as desc, price, emoji, category as cat, available FROM menu_items ORDER BY id ASC'
  ).all();
  const tables = db.prepare('SELECT restaurant_id as restaurantId, table_number as tableNumber, status FROM table_status ORDER BY table_number ASC').all();
  const orders = getOrders();
  const stats = getStats(orders, tables);
  return {
    menu,
    tables,
    orders,
    stats
  };
}

function markOrderPaid({ orderId, actor, paymentMethod, paymentGatewayOrderId = null, paymentGatewayPaymentId = null }) {
  const order = db.prepare('SELECT id, order_type as orderType, table_number as tableNumber, paid FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order not found');
  if (Number(order.paid) === 1) throw new Error('Order is already paid');

  const paidAt = Date.now();
  db.prepare(
    'UPDATE orders SET paid = 1, payment_method = ?, payment_gateway_order_id = ?, payment_gateway_payment_id = ?, paid_at = ?, updated_at = ? WHERE id = ?'
  ).run(paymentMethod, paymentGatewayOrderId, paymentGatewayPaymentId, paidAt, paidAt, orderId);

  if ((order.orderType === 'dine' || order.orderType === 'preorder') && order.tableNumber) {
    db.prepare('UPDATE table_status SET status = ? WHERE table_number = ?').run('occupied', order.tableNumber);
  }

  logAudit({
    action: 'order_paid',
    entityType: 'order',
    entityId: orderId,
    actor,
    details: { paymentMethod, paymentGatewayOrderId, paymentGatewayPaymentId, paidAt }
  });

  broadcastState();
  return getOrders().find((entry) => entry.id === orderId);
}

function broadcastState() {
  io.emit('state:update', getState());
}

seedDatabase();

const jsonParser = express.json();
app.use((req, res, next) => {
  if (req.path === '/api/payments/razorpay/webhook') return next();
  return jsonParser(req, res, next);
});
app.use(express.static(__dirname));

app.get('/', (_req, res) => {
  res.redirect('/client.html');
});

app.get('/client', (_req, res) => {
  res.redirect('/client.html');
});

app.get('/management', (_req, res) => {
  res.redirect('/management.html');
});

const apiRateLimiter = createMemoryRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  keyPrefix: 'api',
  skip: (req) => req.path === '/health'
});

app.use('/api', apiRateLimiter);

app.get('/api/health', (_req, res) => {
  try {
    db.prepare('SELECT 1 as ok').get();
    return res.json({
      ok: true,
      env: NODE_ENV,
      port: PORT,
      uptimeSeconds: Math.floor((Date.now() - APP_START_TIME) / 1000),
      db: {
        engine: 'sqlite',
        file: DB_FILE,
        backupEnabled: DB_BACKUP_ENABLED,
        backupIntervalMinutes: DB_BACKUP_INTERVAL_MINUTES,
        lastBackupAt
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Database health check failed', details: error.message });
  }
});

app.get('/api/state', (_req, res) => {
  res.json(getState());
});

app.post('/api/menu/:id/availability', (req, res) => {
  const menuItemId = Number(req.params.id);
  const availableValue = req.body?.available;
  const available = availableValue === true || availableValue === 1 || availableValue === '1'
    ? 1
    : 0;
  const actor = getActor(req);

  const item = db.prepare('SELECT id, name, available FROM menu_items WHERE id = ?').get(menuItemId);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });

  if (Number(item.available) === available) {
    return res.json({ ok: true, available });
  }

  db.prepare('UPDATE menu_items SET available = ? WHERE id = ?').run(available, menuItemId);
  logAudit({
    action: 'menu_availability_changed',
    entityType: 'menu_item',
    entityId: menuItemId,
    actor,
    details: { name: item.name, from: Number(item.available), to: available }
  });

  broadcastState();
  return res.json({ ok: true, available });
});

app.post('/api/menu', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.desc || req.body?.description || '').trim();
  const price = Number(req.body?.price || 0);
  const emoji = String(req.body?.emoji || '🍽️').trim() || '🍽️';
  const cat = String(req.body?.cat || req.body?.category || 'other').trim().toLowerCase() || 'other';
  const availableValue = req.body?.available;
  const available = availableValue === false || availableValue === 0 || availableValue === '0' ? 0 : 1;
  const actor = getActor(req);

  if (!name) return res.status(400).json({ error: 'Menu item name is required' });
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'Price must be greater than 0' });

  const result = db.prepare(
    'INSERT INTO menu_items (name, description, price, emoji, category, available) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, description || 'Custom menu item', Math.round(price), emoji, cat, available);

  logAudit({
    action: 'menu_item_added',
    entityType: 'menu_item',
    entityId: result.lastInsertRowid,
    actor,
    details: { name, price: Math.round(price), cat, available }
  });

  broadcastState();
  return res.status(201).json({ id: result.lastInsertRowid });
});

app.delete('/api/menu/:id', (req, res) => {
  const menuItemId = Number(req.params.id);
  const actor = getActor(req);
  const item = db.prepare('SELECT id, name, price, category FROM menu_items WHERE id = ?').get(menuItemId);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });

  db.prepare('DELETE FROM menu_items WHERE id = ?').run(menuItemId);
  logAudit({
    action: 'menu_item_deleted',
    entityType: 'menu_item',
    entityId: menuItemId,
    actor,
    details: { name: item.name, price: item.price, cat: item.category }
  });

  broadcastState();
  return res.json({ ok: true });
});

app.post('/api/menu/import-csv', (req, res) => {
  try {
    const actor = getActor(req);
    const csvText = String(req.body?.csvText || '');
    const replaceExisting = req.body?.replaceExisting === true;
    const restaurantCode = String(req.body?.restaurantCode || 'default');
    const restaurantName = String(req.body?.restaurantName || '').trim();

    if (!csvText.trim()) {
      return res.status(400).json({ error: 'CSV content is required' });
    }

    const restaurant = resolveRestaurantByCode(restaurantCode, restaurantName);
    const { rows, invalidRows } = parseMenuCsv(csvText);

    if (!rows.length) {
      return res.status(400).json({ error: 'No valid menu rows found in CSV', invalidRows });
    }

    const insertItem = db.prepare(
      'INSERT INTO menu_items (restaurant_id, name, description, price, emoji, category, available) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const deleteExisting = db.prepare('DELETE FROM menu_items WHERE restaurant_id = ?');

    const tx = db.transaction(() => {
      if (replaceExisting) {
        deleteExisting.run(restaurant.id);
      }

      let inserted = 0;
      rows.forEach((row) => {
        insertItem.run(
          restaurant.id,
          row.name,
          row.description,
          row.price,
          row.emoji,
          row.category,
          row.available
        );
        inserted += 1;
      });

      return { inserted };
    });

    const result = tx();

    logAudit({
      action: 'menu_csv_imported',
      entityType: 'menu',
      actor,
      details: {
        restaurantId: restaurant.id,
        restaurantCode: restaurant.code,
        restaurantName: restaurant.name,
        inserted: result.inserted,
        invalidRows: invalidRows.length,
        replaceExisting
      }
    });

    broadcastState();
    return res.json({
      ok: true,
      restaurant: {
        id: restaurant.id,
        code: restaurant.code,
        name: restaurant.name
      },
      inserted: result.inserted,
      invalidRows,
      replaceExisting
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Failed to import CSV' });
  }
});

app.get('/api/audit-logs', (req, res) => {
  const limit = Number(req.query.limit || 30);
  res.json({ logs: getAuditLogs(limit) });
});

app.post('/api/orders', (req, res) => {
  try {
    const actor = getActor(req);
    const { orderType, tableNumber, notes, items } = req.body || {};
    if (!['dine', 'takeaway', 'preorder'].includes(orderType)) {
      return res.status(400).json({ error: 'Invalid order type' });
    }

    const requiresTable = orderType === 'dine' || orderType === 'preorder';
    const normalizedTableNumber = requiresTable ? Number(tableNumber || 0) || null : null;
    if (requiresTable && !normalizedTableNumber) {
      return res.status(400).json({ error: 'Table number is required for dine-in and pre-order' });
    }

    const orderId = createOrder({
      orderType,
      tableNumber: normalizedTableNumber,
      notes: notes || '',
      items,
      status: 'new',
      paid: 0,
      etaMinutes: orderType === 'preorder' ? 25 : 15
    });

    const createdOrder = getOrders().find((order) => order.id === orderId);

    logAudit({
      action: 'order_created',
      entityType: 'order',
      entityId: orderId,
      actor,
      details: {
        orderType,
        tableNumber: normalizedTableNumber,
        total: createdOrder?.total || null
      }
    });

    broadcastState();
    return res.status(201).json({ order: createdOrder });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/orders/:id/status', (req, res) => {
  const orderId = Number(req.params.id);
  const actor = getActor(req);
  const { status } = req.body || {};
  if (!['new', 'preparing', 'ready', 'delivered'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const order = db.prepare(
    'SELECT id, order_type as orderType, table_number as tableNumber, status, source, external_order_id as externalOrderId FROM orders WHERE id = ?'
  ).get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), orderId);
  if ((order.orderType === 'dine' || order.orderType === 'preorder') && order.tableNumber) {
    let nextTableStatus = null;
    if (status === 'new') nextTableStatus = 'ordering';
    if (status === 'preparing' || status === 'ready') nextTableStatus = 'occupied';
    if (status === 'delivered') nextTableStatus = 'free';
    if (nextTableStatus) {
      db.prepare('UPDATE table_status SET status = ? WHERE table_number = ?').run(nextTableStatus, order.tableNumber);
    }
  }

  logAudit({
    action: 'order_status_changed',
    entityType: 'order',
    entityId: orderId,
    actor,
    details: { from: order.status, to: status, orderType: order.orderType, tableNumber: order.tableNumber }
  });

  broadcastState();
  return res.json({ ok: true });
});

app.get('/api/payments/razorpay/config', (_req, res) => {
  const enabled = RAZORPAY_ENABLED;
  return res.json({ enabled, keyId: enabled ? RAZORPAY_KEY_ID : null });
});

app.post('/api/orders/:id/razorpay-order', async (req, res) => {
  try {
    if (!RAZORPAY_ENABLED || !razorpay) {
      return res.status(400).json({ error: 'Razorpay is not configured' });
    }

    const orderId = Number(req.params.id);
    const actor = getActor(req);
    const order = getOrders().find((entry) => entry.id === orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (Number(order.paid) === 1) return res.status(400).json({ error: 'Order is already paid' });

    const amountPaise = Math.round(Number(order.total || 0) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      return res.status(400).json({ error: 'Invalid order amount' });
    }

    const gatewayOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `order_${order.id}_${Date.now()}`,
      notes: {
        appOrderId: String(order.id),
        appOrderLabel: String(order.label || '')
      }
    });

    db.prepare('UPDATE orders SET payment_gateway_order_id = ?, updated_at = ? WHERE id = ?')
      .run(gatewayOrder.id, Date.now(), order.id);

    logAudit({
      action: 'payment_gateway_order_created',
      entityType: 'order',
      entityId: order.id,
      actor,
      details: { gateway: 'razorpay', gatewayOrderId: gatewayOrder.id, amountPaise }
    });

    broadcastState();

    return res.json({
      keyId: RAZORPAY_KEY_ID,
      gatewayOrderId: gatewayOrder.id,
      amountPaise,
      currency: 'INR',
      appOrder: getOrders().find((entry) => entry.id === order.id)
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to create Razorpay order' });
  }
});

app.post('/api/orders/:id/razorpay/verify', async (req, res) => {
  try {
    if (!RAZORPAY_ENABLED || !razorpay) {
      return res.status(400).json({ error: 'Razorpay is not configured' });
    }

    const orderId = Number(req.params.id);
    const actor = getActor(req);
    const razorpayOrderId = String(req.body?.razorpayOrderId || '').trim();
    const razorpayPaymentId = String(req.body?.razorpayPaymentId || '').trim();
    const razorpaySignature = String(req.body?.razorpaySignature || '').trim();

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ error: 'Missing Razorpay verification fields' });
    }

    const order = getOrders().find((entry) => entry.id === orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (Number(order.paid) === 1) return res.status(400).json({ error: 'Order is already paid' });

    if (order.paymentGatewayOrderId && order.paymentGatewayOrderId !== razorpayOrderId) {
      return res.status(400).json({ error: 'Gateway order mismatch' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');
    if (expectedSignature !== razorpaySignature) {
      return res.status(400).json({ error: 'Invalid Razorpay signature' });
    }

    const payment = await razorpay.payments.fetch(razorpayPaymentId);
    const expectedAmountPaise = Math.round(Number(order.total || 0) * 100);
    if (Number(payment.amount || 0) !== expectedAmountPaise) {
      return res.status(400).json({ error: 'Razorpay amount mismatch' });
    }
    if (String(payment.order_id || '') !== razorpayOrderId) {
      return res.status(400).json({ error: 'Razorpay order reference mismatch' });
    }
    if (!['captured', 'authorized'].includes(String(payment.status || '').toLowerCase())) {
      return res.status(400).json({ error: 'Payment not completed yet' });
    }

    const normalizedMethod = String(payment.method || req.body?.paymentMethod || 'online').trim().toLowerCase();
    const updatedOrder = markOrderPaid({
      orderId,
      actor,
      paymentMethod: normalizedMethod,
      paymentGatewayOrderId: razorpayOrderId,
      paymentGatewayPaymentId: razorpayPaymentId
    });

    return res.json({ ok: true, order: updatedOrder });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Razorpay verification failed' });
  }
});

app.post('/api/payments/razorpay/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    if (!RAZORPAY_ENABLED || !RAZORPAY_WEBHOOK_SECRET) {
      return res.status(400).json({ error: 'Razorpay webhook is not configured' });
    }

    const signature = String(req.headers['x-razorpay-signature'] || '').trim();
    if (!signature) return res.status(400).json({ error: 'Missing webhook signature' });

    const bodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(bodyBuffer).digest('hex');
    if (expected !== signature) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const payload = JSON.parse(bodyBuffer.toString('utf8') || '{}');
    const event = String(payload?.event || '').trim();
    if (event !== 'payment.captured') return res.json({ ok: true, ignored: true });

    const paymentEntity = payload?.payload?.payment?.entity;
    const orderEntity = payload?.payload?.order?.entity;
    const appOrderId = Number(orderEntity?.notes?.appOrderId || 0);
    if (!appOrderId) return res.json({ ok: true, ignored: true });

    const existing = getOrders().find((entry) => entry.id === appOrderId);
    if (!existing || Number(existing.paid) === 1) return res.json({ ok: true, ignored: true });

    markOrderPaid({
      orderId: appOrderId,
      actor: 'razorpay-webhook',
      paymentMethod: String(paymentEntity?.method || 'online').toLowerCase(),
      paymentGatewayOrderId: String(paymentEntity?.order_id || orderEntity?.id || ''),
      paymentGatewayPaymentId: String(paymentEntity?.id || '')
    });

    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Webhook processing failed' });
  }
});

app.post('/api/orders/:id/pay', (req, res) => {
  const orderId = Number(req.params.id);
  const actor = getActor(req);
  const paymentMethod = String(req.body?.paymentMethod || 'card').trim().toLowerCase();
  if (!['card', 'upi', 'cash'].includes(paymentMethod)) {
    return res.status(400).json({ error: 'Invalid payment method' });
  }

  const amount = Number(req.body?.amount || 0);
  const fullOrder = getOrders().find((entry) => entry.id === orderId);
  if (!fullOrder) return res.status(404).json({ error: 'Order details not found' });
  if (Number(fullOrder.paid) === 1) return res.status(400).json({ error: 'Order is already paid' });

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid payment amount' });
  }
  if (Math.round(amount) !== Math.round(fullOrder.total)) {
    return res.status(400).json({ error: `Payment amount mismatch. Expected ${fullOrder.total}` });
  }

  const updatedOrder = markOrderPaid({ orderId, actor, paymentMethod });
  return res.json({ ok: true, order: updatedOrder });
});

app.post('/api/tables/:tableNumber/toggle', (req, res) => {
  const tableNumber = Number(req.params.tableNumber);
  const actor = getActor(req);
  const table = db.prepare('SELECT status FROM table_status WHERE table_number = ?').get(tableNumber);
  if (!table) return res.status(404).json({ error: 'Table not found' });

  const cycle = { free: 'ordering', ordering: 'occupied', occupied: 'free' };
  const next = cycle[table.status];
  if (next === 'free') {
    const activeUndelivered = db.prepare(
      `SELECT COUNT(*) as count FROM orders
        WHERE order_type IN ('dine','preorder') AND table_number = ? AND status != 'delivered'`
    ).get(tableNumber).count;
    if (activeUndelivered > 0) {
      return res.status(400).json({ error: 'Table can be set to free only after all dine/pre-order orders are delivered' });
    }
  }
  db.prepare('UPDATE table_status SET status = ? WHERE table_number = ?').run(next, tableNumber);

  logAudit({ action: 'table_status_toggled', entityType: 'table', entityId: tableNumber, actor, details: { from: table.status, to: next } });

  broadcastState();
  return res.json({ status: next });
});

app.post('/api/tables/:tableNumber/status', (req, res) => {
  const tableNumber = Number(req.params.tableNumber);
  const actor = getActor(req);
  const status = String(req.body?.status || '').trim();
  if (!['free', 'ordering', 'occupied'].includes(status)) {
    return res.status(400).json({ error: 'Invalid table status' });
  }

  const table = db.prepare('SELECT status FROM table_status WHERE table_number = ?').get(tableNumber);
  if (!table) return res.status(404).json({ error: 'Table not found' });

  if (table.status === status) return res.json({ status });

  if (status === 'free') {
    // Prevent freeing a table while it still has active dine/pre-order work.
    const activeUndelivered = db.prepare(
      `SELECT COUNT(*) as count FROM orders
        WHERE order_type IN ('dine','preorder') AND table_number = ? AND status != 'delivered'`
    ).get(tableNumber).count;
    if (activeUndelivered > 0) {
      return res.status(400).json({ error: 'Table can be set to free only after all dine/pre-order orders are delivered' });
    }
  }

  db.prepare('UPDATE table_status SET status = ? WHERE table_number = ?').run(status, tableNumber);
  logAudit({ action: 'table_status_set', entityType: 'table', entityId: tableNumber, actor, details: { from: table.status, to: status } });

  broadcastState();
  return res.json({ status });
});

app.post('/api/tables', (req, res) => {
  const actor = getActor(req);
  const requested = Number(req.body?.tableNumber || 0);
  const nextTableNumber = requested > 0
    ? requested
    : (db.prepare('SELECT COALESCE(MAX(table_number), 0) as maxTable FROM table_status').get().maxTable + 1);

  const exists = db.prepare('SELECT table_number FROM table_status WHERE table_number = ?').get(nextTableNumber);
  if (exists) return res.status(400).json({ error: 'Table already exists' });

  db.prepare('INSERT INTO table_status (table_number, status) VALUES (?, ?)').run(nextTableNumber, 'free');
  logAudit({ action: 'table_added', entityType: 'table', entityId: nextTableNumber, actor, details: { status: 'free' } });

  broadcastState();
  return res.status(201).json({ tableNumber: nextTableNumber, status: 'free' });
});

app.delete('/api/tables/:tableNumber', (req, res) => {
  const tableNumber = Number(req.params.tableNumber);
  const actor = getActor(req);
  const table = db.prepare('SELECT status FROM table_status WHERE table_number = ?').get(tableNumber);
  if (!table) return res.status(404).json({ error: 'Table not found' });

  const tableCount = db.prepare('SELECT COUNT(*) as count FROM table_status').get().count;
  if (tableCount <= 1) return res.status(400).json({ error: 'At least one table must remain' });
  if (table.status !== 'free') return res.status(400).json({ error: 'Only free tables can be removed' });

  const activeDineOrders = db.prepare(
    `SELECT COUNT(*) as count FROM orders
      WHERE order_type IN ('dine','preorder') AND table_number = ? AND status != 'delivered'`
  ).get(tableNumber).count;
  if (activeDineOrders > 0) {
    return res.status(400).json({ error: 'Table has active dine-in orders' });
  }

  db.prepare('DELETE FROM table_status WHERE table_number = ?').run(tableNumber);
  logAudit({ action: 'table_removed', entityType: 'table', entityId: tableNumber, actor, details: { previousStatus: table.status } });

  broadcastState();
  return res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.emit('state:update', getState());
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${PORT}`);
});

if (DB_BACKUP_ENABLED) {
  runDatabaseBackup('startup');
  setInterval(() => {
    runDatabaseBackup('interval');
  }, DB_BACKUP_INTERVAL_MINUTES * 60 * 1000).unref();
}
