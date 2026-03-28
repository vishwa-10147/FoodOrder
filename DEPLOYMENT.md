# Local Small-Setup Runbook (Recommended)

This project runs with a local SQLite database and is ideal for a single-location food court MVP.

## 1) Install and start
1. Install dependencies:
   - `npm install`
2. Start server:
   - `npm start`
3. Open:
   - `http://localhost:3000/management.html`
   - `http://localhost:3000/client.html`

## 2) Environment configuration
1. Copy `.env.example` values into your environment (PowerShell example):
   - `$env:NODE_ENV='production'`
   - `$env:PORT='3000'`
2. Optional hardening knobs:
   - `RATE_LIMIT_WINDOW_MS` (default `60000`)
   - `RATE_LIMIT_MAX` (default `240`)
   - `DB_BACKUP_ENABLED` (default `true`)
   - `DB_BACKUP_INTERVAL_MINUTES` (default `60`)
   - `DB_BACKUP_RETENTION_COUNT` (default `48`)
   - `SWIGGY_ENABLED` (default `false`)
   - `SWIGGY_API_BASE_URL`, `SWIGGY_API_TOKEN`, `SWIGGY_WEBHOOK_SECRET`
   - `SWIGGY_STORE_ID`, `SWIGGY_WEBHOOK_STRICT` (default `true`), `SWIGGY_SYNC_INTERVAL_MS` (default `15000`)

## 2.1) Own menu + Razorpay (recommended)
If you are running your own version (not Swiggy), keep Swiggy disabled and configure Razorpay:

1. Set environment variables before starting server:
   - `$env:SWIGGY_ENABLED='false'`
   - `$env:RAZORPAY_KEY_ID='rzp_test_xxxxx'`
   - `$env:RAZORPAY_KEY_SECRET='xxxxxxxx'`
   - `$env:RAZORPAY_WEBHOOK_SECRET='whsec_xxxxx'`
2. Restart app with `npm start`.
3. Confirm Razorpay config endpoint returns enabled:
   - `GET /api/payments/razorpay/config`
4. In Razorpay Dashboard (Test Mode), add webhook URL:
   - `https://<your-domain>/api/payments/razorpay/webhook`
5. Enable webhook event:
   - `payment.captured`

Notes:
- Client checkout is already wired to create and verify Razorpay orders.
- Cash payments continue working through internal API validation.
- Use test keys in development and live keys only after going live.

## 2.2) Your menu integration mapping
For your own menu/catalog UI:

1. Load menu and IDs from `GET /api/state`.
2. Place order with `POST /api/orders` using `items: [{ menuItemId, qty }]`.
3. Frontend payment flow should call:
   - `POST /api/orders/:id/razorpay-order`
   - Razorpay checkout popup
   - `POST /api/orders/:id/razorpay/verify`

## 2.3) Hybrid mode (Direct + Swiggy together)
To run both your own orders and Swiggy orders in one dashboard:

1. Keep direct flow enabled (default `POST /api/orders` for client/restaurant channels).
2. Enable Swiggy integration env values:
   - `SWIGGY_ENABLED=true`
   - `SWIGGY_API_BASE_URL=<partner-api-base>`
   - `SWIGGY_API_TOKEN=<partner-token>`
   - `SWIGGY_WEBHOOK_SECRET=<webhook-secret>`
   - `SWIGGY_STORE_ID=<store-id>`
3. Configure Swiggy webhook to:
   - `https://<your-domain>/api/integrations/swiggy/webhook`
4. Keep Razorpay env values for direct channel payments.
5. Use Management > Menu > Hybrid channel controls to:
   - check Swiggy config status
   - queue full menu sync to Swiggy
   - monitor latest sync job state

Operational note:
- Local DB remains source of truth for kitchen and table execution.
- Direct and Swiggy orders are merged in one order stream with source labels.

Swiggy payments behavior:
- For Swiggy-source orders, payment state is ingested from Swiggy webhook payload.
- When Swiggy marks payment as paid/captured/success, local order is auto-marked paid.
- Payment method is stored from incoming Swiggy payment mode (for example `cash`, `upi`, `card`, or `swiggy_<mode>`).
- Status updates from management for Swiggy-source orders auto-queue sync jobs back to Swiggy.

## 2.4) Full Swiggy-only mode
If you want everything routed through Swiggy (orders + payment handling), set:

1. `SWIGGY_ENABLED=true`
2. `SWIGGY_ONLY_MODE=true`
3. `SWIGGY_API_BASE_URL=<partner-api-base>`
4. `SWIGGY_API_TOKEN=<partner-token>`
5. `SWIGGY_WEBHOOK_SECRET=<swiggy-webhook-secret>`
6. `SWIGGY_STORE_ID=<store-id>`

Behavior in this mode:
- Direct order creation endpoint is blocked.
- Direct payment endpoints and Razorpay checkout endpoints are blocked/ignored.
- Client page hides order/payment sections and shows tracking-focused behavior.

## 2.5) Your requested model: app confirms/tracks, Swiggy handles menu + payment
Use this mode when kitchen and status management stay in your app while menu and payments come from Swiggy.

Set these values:
1. `SWIGGY_ENABLED=true`
2. `SWIGGY_ONLY_MODE=true`
3. `SWIGGY_MENU_PULL_ENABLED=true`
4. `SWIGGY_MENU_PULL_INTERVAL_MS=300000` (or your preferred interval)
5. `SWIGGY_API_BASE_URL=<partner-api-base>`
6. `SWIGGY_API_TOKEN=<partner-token>`
7. `SWIGGY_WEBHOOK_SECRET=<swiggy-webhook-secret>`
8. `SWIGGY_STORE_ID=<store-id>`

How it works:
- Menu is pulled from Swiggy into local DB on interval (and manually from management page).
- Orders are ingested from Swiggy webhooks and shown in your management kitchen/tracking.
- Payment status is ingested from Swiggy webhook payloads and marked paid locally.
- Status updates from management are synced back to Swiggy through integration jobs.

## 3) What is hardened now
- Basic API rate limiting for `/api/*`
- Health endpoint: `GET /api/health`
- Automatic SQLite backups in `data/backups/`
- Backup rotation based on retention count

## 4) Backup behavior
- Database file: `data/restaurant.db`
- Backup files: `data/backups/restaurant-YYYYMMDDTHHMMSSZ.db`
- One backup runs at startup, then at configured interval.

## 5) LAN usage (same Wi-Fi)
- Keep the server machine running.
- Use Management -> Share website to copy LAN URLs and QR codes.
- Client devices should open the generated `http://<LAN-IP>:3000/client.html` link.

## 6) Quick checks
- Health: `http://localhost:3000/api/health`
- State API: `http://localhost:3000/api/state`
- If API throttles, wait for `RATE_LIMIT_WINDOW_MS` to reset.

## Optional cloud move (later)
Once traffic grows, migrate SQLite to managed Postgres and deploy backend on a cloud runtime.
