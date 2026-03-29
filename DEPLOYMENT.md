# Production Deployment Guide

This guide is for the current production app: direct ordering, management dashboard, CSV menu import, and Razorpay payments.

## 1) Prerequisites
- GitHub repository connected to Render
- Render Web Service with persistent disk mounted at `data`
- Razorpay account with live keys

## 2) Required Environment Variables
Set these in Render service settings:

- `NODE_ENV=production`
- `PORT=10000` (or Render default)
- `RAZORPAY_KEY_ID=<your_live_key_id>`
- `RAZORPAY_KEY_SECRET=<your_live_key_secret>`
- `RAZORPAY_WEBHOOK_SECRET=<your_webhook_secret>`
- `MANAGEMENT_AUTH_SECRET=<long_random_secret>`
- `REQUIRE_PERSISTENT_DB=true`

Recommended operational settings:

- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_MAX=240`
- `DB_BACKUP_ENABLED=true`
- `DB_BACKUP_INTERVAL_MINUTES=60`
- `DB_BACKUP_RETENTION_COUNT=48`
- `MANAGEMENT_SETUP_KEY=<admin_setup_key>`

Optional explicit path settings (if your platform mount path differs):

- `DATA_DIR=/opt/render/project/src/data`
- `DB_FILE=/opt/render/project/src/data/restaurant.db`
- `DB_BACKUP_DIR=/opt/render/project/src/data/backups`

## 2.1) Management Login Bootstrap
Management now requires login using restaurant name/code + password.

Create first account (first bootstrap does not require setup key):

- `POST /api/management/register`
- Body:
   - `restaurant`: `gandikota`
   - `restaurantName`: `Gandikota`
   - `password`: `yourStrongPassword`

Create/update additional restaurant passwords (requires setup key):

- `POST /api/management/register`
- Body:
   - `setupKey`: must match `MANAGEMENT_SETUP_KEY`
   - `restaurant`: `branch_b`
   - `restaurantName`: `Branch B`
   - `password`: `anotherStrongPassword`

Management login endpoint:

- `POST /api/management/login`
- Body:
   - `restaurant`
   - `password`

Password storage:

- Passwords are stored in SQLite table `restaurant_auth`.
- Stored as salted PBKDF2 hashes (`password_hash`, `password_salt`), not plain text.

## 3) Razorpay Webhook
In Razorpay dashboard:

1. Add webhook URL:
   - `https://<your-service>.onrender.com/api/payments/razorpay/webhook`
2. Enable event:
   - `payment.captured`
3. Use the same secret as `RAZORPAY_WEBHOOK_SECRET`

## 4) Deploy on Render
1. Push changes to your deployment branch.
2. Wait for Render deploy to complete.
3. Validate endpoints:
   - `GET /api/health`
   - `GET /api/state`

## 5) Post-Deploy Validation Checklist
- Management page opens: `/management.html`
- Client page opens: `/client.html`
- CSV import works from Management -> Menu availability
- New order flow works end-to-end
- Razorpay checkout and webhook verification both work

## 6) Data and Backup Notes
- Primary DB: `data/restaurant.db`
- Backups: `data/backups/restaurant-YYYYMMDDTHHMMSSZ.db`
- Backups run at startup and at interval
- With `REQUIRE_PERSISTENT_DB=true`, production startup fails fast if DB file is missing (prevents silent fresh DB creation and lost logins).
- If DB file is missing but backups exist, startup now auto-restores from the latest backup before starting.

## 7) Operational Notes
- Render free tiers may sleep when idle.
- Keep persistent disk enabled; without it, SQLite data can be lost between deploys.
- For higher traffic, move to managed Postgres in a future phase.

## 8) One-Time Supabase Migration (Automated Script)
Use this when you want to move existing SQLite data into Supabase Postgres.

What this does:
- Creates required tables/indexes in Supabase (if you pass `--apply-schema`).
- Copies all rows from local SQLite into Supabase.
- Resets Postgres sequences so new inserts continue correctly.

### 8.1) Supabase setup
1. Create a Supabase project.
2. In Supabase dashboard, open: `Settings -> Database -> Connection string -> URI`.
3. Copy URI and set as `DATABASE_URL`.

### 8.2) Run migration locally
From project root:

Fresh Supabase DB (schema only, no SQLite import):

```bash
DATABASE_URL="<supabase_uri>" PGSSL=true npm run supabase:init
```

```bash
npm install
DATABASE_URL="<supabase_uri>" PGSSL=true npm run migrate:supabase
```

PowerShell example:

```powershell
$env:DATABASE_URL='<supabase_uri>'
$env:PGSSL='true'
npm run migrate:supabase
```

Optional:
- Custom sqlite source file: set `SQLITE_FILE`.
- Keep target data (no truncate): run script directly with `--keep-target-data`.

### 8.3) Important notes
- Migration writes directly to your Supabase DB.
- Default mode clears target app tables first to prevent duplicate rows.
- Current runtime server still uses SQLite; this step migrates data only.
