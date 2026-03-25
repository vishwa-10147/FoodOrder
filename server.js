const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

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
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  category TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS table_status (
  table_number INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('free','ordering','occupied'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_type TEXT NOT NULL CHECK(order_type IN ('dine','takeaway','preorder')),
  table_number INTEGER,
  notes TEXT DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('new','preparing','ready','delivered')),
  paid INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
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

function seedDatabase() {
  const menuColumns = db.prepare('PRAGMA table_info(menu_items)').all();
  const hasAvailableColumn = menuColumns.some((col) => col.name === 'available');
  if (!hasAvailableColumn) {
    db.exec('ALTER TABLE menu_items ADD COLUMN available INTEGER NOT NULL DEFAULT 1');
  }

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
  const hasPaidAtColumn = orderColumns.some((col) => col.name === 'paid_at');
  if (!hasPaymentMethodColumn) {
    db.exec('ALTER TABLE orders ADD COLUMN payment_method TEXT');
  }
  if (!hasPaidAtColumn) {
    db.exec('ALTER TABLE orders ADD COLUMN paid_at INTEGER');
  }

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
    createOrder({
      orderType: 'dine',
      tableNumber: 4,
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

function createOrder({ orderType, tableNumber = null, notes = '', items, status = 'new', paid = 0, etaMinutes = 15 }) {
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
    `INSERT INTO orders (order_type, table_number, notes, status, paid, eta_minutes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertItem = db.prepare(
    `INSERT INTO order_items (order_id, menu_item_id, item_name, item_price, qty)
     VALUES (?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    const result = insertOrder.run(orderType, tableNumber, notes, status, paid, etaMinutes, now, now);
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
    `SELECT id, order_type as orderType, table_number as tableNumber, notes, status, paid, payment_method as paymentMethod, paid_at as paidAt, eta_minutes as etaMinutes, created_at as createdAt, updated_at as updatedAt
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
    'SELECT id, name, description as desc, price, emoji, category as cat, available FROM menu_items ORDER BY id ASC'
  ).all();
  const tables = db.prepare('SELECT table_number as tableNumber, status FROM table_status ORDER BY table_number ASC').all();
  const orders = getOrders();
  const stats = getStats(orders, tables);
  return { menu, tables, orders, stats };
}

function broadcastState() {
  io.emit('state:update', getState());
}

function getLocalAccessUrls(port) {
  const ifaces = os.networkInterfaces();
  const urls = [];

  Object.values(ifaces).forEach((entries) => {
    (entries || []).forEach((entry) => {
      if (entry && entry.family === 'IPv4' && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    });
  });

  return Array.from(new Set(urls));
}

seedDatabase();

app.use(express.json());
app.use(express.static(__dirname));

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

app.get('/api/audit-logs', (req, res) => {
  const limit = Number(req.query.limit || 30);
  res.json({ logs: getAuditLogs(limit) });
});

app.get('/api/share-info', (req, res) => {
  const port = Number(process.env.PORT || 3000);
  const localUrls = getLocalAccessUrls(port);
  const currentHost = req.get('host');
  const currentUrl = currentHost ? `http://${currentHost}` : null;
  res.json({ currentUrl, localUrls });
});

app.get('/api/share-qr', async (req, res) => {
  const target = String(req.query.target || '').trim();
  if (!target) return res.status(400).json({ error: 'Missing target URL' });

  try {
    const svg = await QRCode.toString(target, { type: 'svg', margin: 1, width: 240 });
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(svg);
  } catch (_error) {
    return res.status(400).json({ error: 'Unable to generate QR' });
  }
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

  const order = db.prepare('SELECT id, order_type as orderType, table_number as tableNumber, status FROM orders WHERE id = ?').get(orderId);
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

app.post('/api/orders/:id/pay', (req, res) => {
  const orderId = Number(req.params.id);
  const actor = getActor(req);
  const paymentMethod = String(req.body?.paymentMethod || 'card').trim().toLowerCase();
  if (!['card', 'upi', 'cash'].includes(paymentMethod)) {
    return res.status(400).json({ error: 'Invalid payment method' });
  }

  const amount = Number(req.body?.amount || 0);
  const order = db.prepare('SELECT id, order_type as orderType, table_number as tableNumber, paid FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (Number(order.paid) === 1) return res.status(400).json({ error: 'Order is already paid' });

  const fullOrder = getOrders().find((entry) => entry.id === orderId);
  if (!fullOrder) return res.status(404).json({ error: 'Order details not found' });

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid payment amount' });
  }
  if (Math.round(amount) !== Math.round(fullOrder.total)) {
    return res.status(400).json({ error: `Payment amount mismatch. Expected ${fullOrder.total}` });
  }

  const paidAt = Date.now();
  db.prepare('UPDATE orders SET paid = 1, payment_method = ?, paid_at = ?, updated_at = ? WHERE id = ?').run(paymentMethod, paidAt, paidAt, orderId);
  // Payment confirms table usage for dine/pre-order; keep table marked occupied.
  if ((order.orderType === 'dine' || order.orderType === 'preorder') && order.tableNumber) {
    db.prepare('UPDATE table_status SET status = ? WHERE table_number = ?').run('occupied', order.tableNumber);
  }

  logAudit({
    action: 'order_paid',
    entityType: 'order',
    entityId: orderId,
    actor,
    details: { paymentMethod, amount, paidAt }
  });

  broadcastState();
  const updatedOrder = getOrders().find((entry) => entry.id === orderId);
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
