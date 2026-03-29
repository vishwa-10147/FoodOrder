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

}

run();
