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

## 7) Operational Notes
- Render free tiers may sleep when idle.
- Keep persistent disk enabled; without it, SQLite data can be lost between deploys.
- For higher traffic, move to managed Postgres in a future phase.
