require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const SQLITE_FILE = process.env.SQLITE_FILE || path.join(ROOT, 'data', 'restaurant.db');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const APPLY_SCHEMA = process.argv.includes('--apply-schema');
const KEEP_TARGET_DATA = process.argv.includes('--keep-target-data');
const SCHEMA_ONLY = process.argv.includes('--schema-only');

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL. Set it to your Supabase Postgres connection string.');
  process.exit(1);
}

const sslMode = String(process.env.PGSSL || '').toLowerCase();
const useSsl = sslMode === 'true' || sslMode === '1' || DATABASE_URL.includes('sslmode=require');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined
});

function splitSqlStatements(sqlText) {
  return sqlText
    .split(/;\s*\n/)
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

async function applySchema(client) {
  const schemaPath = path.join(__dirname, 'supabase_schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const statements = splitSqlStatements(sql);
  for (const stmt of statements) {
    await client.query(stmt);
  }
}

function selectAll(db, table, columns) {
  const rows = db.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all();
  return rows;
}

async function insertRows(client, table, columns, rows) {
  if (!rows.length) return;
  const quotedColumns = columns.map((c) => `"${c}"`).join(', ');
  const placeholders = columns.map((_c, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO ${table} (${quotedColumns}) VALUES (${placeholders})`;
  for (const row of rows) {
    const values = columns.map((c) => row[c]);
    await client.query(sql, values);
  }
}

async function resetSequence(client, table, idColumn = 'id') {
  const seqQuery = `SELECT pg_get_serial_sequence('${table}', '${idColumn}') AS seq`;
  const seq = (await client.query(seqQuery)).rows[0]?.seq;
  if (!seq) return;
  const maxId = (await client.query(`SELECT COALESCE(MAX(${idColumn}), 0) AS max_id FROM ${table}`)).rows[0].max_id;
  await client.query(`SELECT setval($1, $2, false)`, [seq, Number(maxId) + 1]);
}

async function run() {
  let sqlite = null;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (APPLY_SCHEMA || SCHEMA_ONLY) {
      console.log('Applying schema...');
      await applySchema(client);
    }

    if (SCHEMA_ONLY) {
      await client.query('COMMIT');
      console.log('Schema initialization completed successfully. No data migrated.');
      return;
    }

    if (!fs.existsSync(SQLITE_FILE)) {
      throw new Error(`SQLite file not found: ${SQLITE_FILE}`);
    }

    sqlite = new Database(SQLITE_FILE, { readonly: true });

    if (!KEEP_TARGET_DATA) {
      console.log('Clearing target tables...');
      await client.query(`
        TRUNCATE TABLE
          order_items,
          orders,
          table_status,
          menu_items,
          restaurant_auth,
          audit_logs,
          restaurants
        RESTART IDENTITY CASCADE
      `);
    }

    const plan = [
      {
        table: 'restaurants',
        columns: ['id', 'code', 'name', 'address', 'cuisines', 'rating', 'rating_count', 'price_for_two', 'accepting_orders', 'reopen_note', 'created_at', 'updated_at']
      },
      {
        table: 'restaurant_auth',
        columns: ['restaurant_id', 'password_hash', 'password_salt', 'updated_at']
      },
      {
        table: 'menu_items',
        columns: ['id', 'restaurant_id', 'name', 'description', 'price', 'emoji', 'category', 'image_url', 'available']
      },
      {
        table: 'table_status',
        columns: ['restaurant_id', 'table_number', 'status']
      },
      {
        table: 'orders',
        columns: ['id', 'restaurant_id', 'order_type', 'table_number', 'notes', 'status', 'source', 'external_order_id', 'paid', 'payment_method', 'payment_gateway_order_id', 'payment_gateway_payment_id', 'paid_at', 'eta_minutes', 'created_at', 'updated_at']
      },
      {
        table: 'order_items',
        columns: ['id', 'order_id', 'menu_item_id', 'item_name', 'item_price', 'qty']
      },
      {
        table: 'audit_logs',
        columns: ['id', 'action', 'entity_type', 'entity_id', 'actor', 'details', 'created_at']
      }
    ];

    for (const item of plan) {
      const rows = selectAll(sqlite, item.table, item.columns);
      console.log(`Migrating ${item.table}: ${rows.length} rows`);
      await insertRows(client, item.table, item.columns, rows);
    }

    await resetSequence(client, 'restaurants');
    await resetSequence(client, 'menu_items');
    await resetSequence(client, 'orders');
    await resetSequence(client, 'order_items');
    await resetSequence(client, 'audit_logs');

    await client.query('COMMIT');
    console.log('Migration completed successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    if (sqlite) sqlite.close();
    await pool.end();
  }
}

run();
