const express = require('express');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.error('Missing DATABASE_URL. Set it to your Supabase/Neon/Postgres connection string.');
  process.exit(1);
}

const useSSL = process.env.PGSSL === 'true' || process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS menu_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      price INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      category TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS table_status (
      table_number INTEGER PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('free','ordering','occupied'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_type TEXT NOT NULL CHECK(order_type IN ('dine','takeaway','preorder')),
      table_number INTEGER,
      notes TEXT DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('new','preparing','ready','delivered')),
      paid INTEGER NOT NULL DEFAULT 0,
      eta_minutes INTEGER NOT NULL DEFAULT 15,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      menu_item_id INTEGER NOT NULL,
      item_name TEXT NOT NULL,
      item_price INTEGER NOT NULL,
      qty INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      actor TEXT NOT NULL,
      details JSONB,
      created_at BIGINT NOT NULL
    );
  `);

  const menuCount = Number((await pool.query('SELECT COUNT(*)::int as count FROM menu_items')).rows[0].count);
  if (menuCount === 0) {
    for (const item of seedMenu) {
      await pool.query(
        'INSERT INTO menu_items (name, description, price, emoji, category) VALUES ($1, $2, $3, $4, $5)',
        [item.name, item.description, item.price, item.emoji, item.category]
      );
    }
  }

  const tableCount = Number((await pool.query('SELECT COUNT(*)::int as count FROM table_status')).rows[0].count);
  if (tableCount === 0) {
    for (let tableNumber = 1; tableNumber <= 14; tableNumber += 1) {
      const defaultStatus = [1, 3, 5, 7].includes(tableNumber)
        ? 'occupied'
        : [4].includes(tableNumber)
          ? 'ordering'
          : 'free';
      await pool.query('INSERT INTO table_status (table_number, status) VALUES ($1, $2)', [tableNumber, defaultStatus]);
    }
  }

  const orderCount = Number((await pool.query('SELECT COUNT(*)::int as count FROM orders')).rows[0].count);
  if (orderCount === 0) {
    await createOrder({
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

    await createOrder({
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

async function getMenuMap(client = pool) {
  const rows = (await client.query('SELECT id, name, price FROM menu_items')).rows;
  return rows.reduce((acc, row) => {
    acc[row.id] = row;
    return acc;
  }, {});
}

async function createOrder({ orderType, tableNumber = null, notes = '', items, status = 'new', paid = 0, etaMinutes = 15 }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Order must contain items');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const menuMap = await getMenuMap(client);
    const normalizedItems = items
      .map((item) => ({ menu: menuMap[item.menuItemId], qty: Number(item.qty) || 0, menuItemId: item.menuItemId }))
      .filter((item) => item.menu && item.qty > 0);

    if (normalizedItems.length === 0) {
      throw new Error('Order contains invalid items');
    }

    if (orderType === 'dine') {
      const exists = (await client.query('SELECT table_number FROM table_status WHERE table_number = $1', [tableNumber])).rows[0];
      if (!exists) throw new Error('Selected table does not exist');
    }

    const now = Date.now();
    const insertOrder = await client.query(
      `INSERT INTO orders (order_type, table_number, notes, status, paid, eta_minutes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [orderType, tableNumber, notes, status, paid, etaMinutes, now, now]
    );

    const orderId = insertOrder.rows[0].id;

    for (const item of normalizedItems) {
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, item_price, qty)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, item.menuItemId, item.menu.name, item.menu.price, item.qty]
      );
    }

    if (orderType === 'dine' && tableNumber) {
      await client.query('UPDATE table_status SET status = $1 WHERE table_number = $2', ['occupied', tableNumber]);
    }

    await client.query('COMMIT');
    return orderId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getOrders() {
  const orderRows = (await pool.query(
    `SELECT id, order_type as "orderType", table_number as "tableNumber", notes, status,
            paid, eta_minutes as "etaMinutes", created_at as "createdAt", updated_at as "updatedAt"
     FROM orders
     ORDER BY created_at DESC`
  )).rows;

  const itemRows = (await pool.query(
    `SELECT order_id as "orderId", item_name as name, item_price as price, qty
     FROM order_items`
  )).rows;

  const byOrder = itemRows.reduce((acc, item) => {
    if (!acc[item.orderId]) acc[item.orderId] = [];
    acc[item.orderId].push(item);
    return acc;
  }, {});

  return orderRows.map((order) => {
    const items = byOrder[order.id] || [];
    const subtotal = items.reduce((sum, item) => sum + Number(item.price) * Number(item.qty), 0);
    const tax = Math.round(subtotal * 0.05);
    const service = Math.round(subtotal * 0.04);
    const total = subtotal + tax + service;

    return {
      ...order,
      paid: Number(order.paid),
      etaMinutes: Number(order.etaMinutes),
      createdAt: Number(order.createdAt),
      updatedAt: Number(order.updatedAt),
      label: toOrderLabel(order.id),
      items,
      subtotal,
      tax,
      service,
      total,
      progress: order.status === 'new' ? 20 : order.status === 'preparing' ? 56 : order.status === 'ready' ? 82 : 100
    };
  });
}

function getStats(orders, tables) {
  const activeOrders = orders.filter((order) => order.status !== 'delivered').length;
  const now = Date.now();
  const overdue = orders.filter((order) => order.status !== 'delivered' && now - order.createdAt > order.etaMinutes * 60000).length;
  const waitingOrders = orders.filter((order) => order.status !== 'delivered');
  const avgWait = waitingOrders.length
    ? Math.round(waitingOrders.reduce((sum, order) => sum + (now - order.createdAt) / 60000, 0) / waitingOrders.length)
    : 0;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const revenueToday = orders
    .filter((order) => order.paid === 1 && order.createdAt >= todayStart.getTime())
    .reduce((sum, order) => sum + order.total, 0);

  const occupiedTables = tables.filter((table) => table.status === 'occupied' || table.status === 'ordering').length;

  return {
    activeOrders,
    overdue,
    avgWait,
    revenueToday,
    occupiedTables,
    tableCapacity: tables.length
  };
}

async function getState() {
  const menu = (await pool.query(
    'SELECT id, name, description as desc, price, emoji, category as cat FROM menu_items ORDER BY id ASC'
  )).rows;

  const tables = (await pool.query(
    'SELECT table_number as "tableNumber", status FROM table_status ORDER BY table_number ASC'
  )).rows;

  const orders = await getOrders();
  const stats = getStats(orders, tables);

  return { menu, tables, orders, stats };
}

function getActor(req) {
  const actor = req.headers['x-actor'];
  return typeof actor === 'string' && actor.trim() ? actor.trim() : 'system';
}

async function logAudit({ action, entityType, entityId = null, actor = 'system', details = null }) {
  await pool.query(
    `INSERT INTO audit_logs (action, entity_type, entity_id, actor, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [action, entityType, entityId ? String(entityId) : null, actor, details, Date.now()]
  );
}

async function getAuditLogs(limit = 30) {
  const safeLimit = Number(limit) > 0 ? Math.min(Number(limit), 200) : 30;
  const rows = (await pool.query(
    `SELECT id, action, entity_type as "entityType", entity_id as "entityId", actor, details, created_at as "createdAt"
     FROM audit_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit]
  )).rows;

  return rows.map((row) => ({
    ...row,
    createdAt: Number(row.createdAt)
  }));
}

async function broadcastState() {
  const state = await getState();
  io.emit('state:update', state);
}

app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/state', async (_req, res) => {
  const state = await getState();
  res.json(state);
});

app.get('/api/audit-logs', async (req, res) => {
  const limit = Number(req.query.limit || 30);
  const logs = await getAuditLogs(limit);
  res.json({ logs });
});

app.post('/api/orders', async (req, res) => {
  try {
    const actor = getActor(req);
    const { orderType, tableNumber, notes, items } = req.body || {};

    if (!['dine', 'takeaway', 'preorder'].includes(orderType)) {
      return res.status(400).json({ error: 'Invalid order type' });
    }

    const normalizedTableNumber = orderType === 'dine' ? Number(tableNumber || 0) || null : null;
    if (orderType === 'dine' && !normalizedTableNumber) {
      return res.status(400).json({ error: 'Table number is required for dine-in orders' });
    }

    const orderId = await createOrder({
      orderType,
      tableNumber: normalizedTableNumber,
      notes: notes || '',
      items,
      status: 'new',
      paid: 0,
      etaMinutes: orderType === 'preorder' ? 25 : 15
    });

    const createdOrder = (await getOrders()).find((order) => order.id === orderId);

    await logAudit({
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

    await broadcastState();
    return res.status(201).json({ order: createdOrder });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/orders/:id/status', async (req, res) => {
  const actor = getActor(req);
  const orderId = Number(req.params.id);
  const { status } = req.body || {};

  if (!['new', 'preparing', 'ready', 'delivered'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const order = (await pool.query(
    `SELECT id, order_type as "orderType", table_number as "tableNumber", status
     FROM orders WHERE id = $1`,
    [orderId]
  )).rows[0];

  if (!order) return res.status(404).json({ error: 'Order not found' });

  await pool.query('UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3', [status, Date.now(), orderId]);

  if (status === 'delivered' && order.orderType === 'dine' && order.tableNumber) {
    await pool.query('UPDATE table_status SET status = $1 WHERE table_number = $2', ['free', order.tableNumber]);
  }

  await logAudit({
    action: 'order_status_changed',
    entityType: 'order',
    entityId: orderId,
    actor,
    details: {
      from: order.status,
      to: status,
      orderType: order.orderType,
      tableNumber: order.tableNumber
    }
  });

  await broadcastState();
  return res.json({ ok: true });
});

app.post('/api/orders/:id/pay', async (req, res) => {
  const actor = getActor(req);
  const orderId = Number(req.params.id);

  const exists = (await pool.query('SELECT id FROM orders WHERE id = $1', [orderId])).rows[0];
  if (!exists) return res.status(404).json({ error: 'Order not found' });

  await pool.query('UPDATE orders SET paid = 1, updated_at = $1 WHERE id = $2', [Date.now(), orderId]);
  await logAudit({ action: 'order_paid', entityType: 'order', entityId: orderId, actor });

  await broadcastState();
  return res.json({ ok: true });
});

app.post('/api/tables/:tableNumber/toggle', async (req, res) => {
  const actor = getActor(req);
  const tableNumber = Number(req.params.tableNumber);
  const table = (await pool.query('SELECT status FROM table_status WHERE table_number = $1', [tableNumber])).rows[0];

  if (!table) return res.status(404).json({ error: 'Table not found' });

  const cycle = { free: 'ordering', ordering: 'occupied', occupied: 'free' };
  const next = cycle[table.status];

  await pool.query('UPDATE table_status SET status = $1 WHERE table_number = $2', [next, tableNumber]);

  await logAudit({
    action: 'table_status_toggled',
    entityType: 'table',
    entityId: tableNumber,
    actor,
    details: { from: table.status, to: next }
  });

  await broadcastState();
  return res.json({ status: next });
});

app.post('/api/tables', async (req, res) => {
  const actor = getActor(req);
  const requested = Number(req.body?.tableNumber || 0);

  let nextTableNumber = requested;
  if (!(nextTableNumber > 0)) {
    const maxRow = (await pool.query('SELECT COALESCE(MAX(table_number), 0) as "maxTable" FROM table_status')).rows[0];
    nextTableNumber = Number(maxRow.maxTable) + 1;
  }

  const exists = (await pool.query('SELECT table_number FROM table_status WHERE table_number = $1', [nextTableNumber])).rows[0];
  if (exists) return res.status(400).json({ error: 'Table already exists' });

  await pool.query('INSERT INTO table_status (table_number, status) VALUES ($1, $2)', [nextTableNumber, 'free']);

  await logAudit({
    action: 'table_added',
    entityType: 'table',
    entityId: nextTableNumber,
    actor,
    details: { status: 'free' }
  });

  await broadcastState();
  return res.status(201).json({ tableNumber: nextTableNumber, status: 'free' });
});

app.delete('/api/tables/:tableNumber', async (req, res) => {
  const actor = getActor(req);
  const tableNumber = Number(req.params.tableNumber);
  const table = (await pool.query('SELECT status FROM table_status WHERE table_number = $1', [tableNumber])).rows[0];

  if (!table) return res.status(404).json({ error: 'Table not found' });

  const tableCount = Number((await pool.query('SELECT COUNT(*)::int as count FROM table_status')).rows[0].count);
  if (tableCount <= 1) return res.status(400).json({ error: 'At least one table must remain' });

  if (table.status !== 'free') return res.status(400).json({ error: 'Only free tables can be removed' });

  const activeDineOrders = Number((await pool.query(
    `SELECT COUNT(*)::int as count
     FROM orders
     WHERE order_type = 'dine' AND table_number = $1 AND status != 'delivered'`,
    [tableNumber]
  )).rows[0].count);

  if (activeDineOrders > 0) {
    return res.status(400).json({ error: 'Table has active dine-in orders' });
  }

  await pool.query('DELETE FROM table_status WHERE table_number = $1', [tableNumber]);

  await logAudit({
    action: 'table_removed',
    entityType: 'table',
    entityId: tableNumber,
    actor,
    details: { previousStatus: table.status }
  });

  await broadcastState();
  return res.json({ ok: true });
});

io.on('connection', async (socket) => {
  socket.emit('state:update', await getState());
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDatabase();
    server.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to start server:', error);
    process.exit(1);
  }
})();
