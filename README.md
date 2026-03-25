# FoodOrder – Restaurant Order Management System

A real-time restaurant ordering app with separate **Client** and **Management** pages, powered by **Node.js + Express + Socket.IO + SQLite**.

- Client page: place dine-in / takeaway / pre-order requests, track orders, and pay.
- Management page: monitor tables and kitchen pipeline, manage menu availability/items, switch table states, and view audit logs.
- Real-time sync: all connected screens update instantly via Socket.IO.

---

## Tech Stack

- **Backend:** Node.js, Express 5, Socket.IO
- **Database:** SQLite (`better-sqlite3`)
- **Frontend:** Plain HTML/CSS/JS (`client.html`, `management.html`)
- **Utilities:** `qrcode` (QR generation endpoint), in-memory API rate limiter, scheduled DB backups

---

## Project Structure

```text
FoodOrdering/
├─ server.js
├─ client.html
├─ management.html
├─ restaurant_order_management_system.html
├─ .env.example
├─ DEPLOYMENT.md
├─ render.yaml
├─ package.json
├─ data/
│  ├─ restaurant.db
│  └─ backups/
└─ availability_smoke.js
```

---

## Features

### Core Ordering
- Dine-in, takeaway, and pre-order flows
- Live menu categories and item availability
- Cart with subtotal, tax, service, and total
- Receipt-style bill UI in client and management views

### Table & Kitchen Operations
- Table states: `free`, `ordering`, `occupied`
- Kitchen pipeline statuses: `new`, `preparing`, `ready`, `delivered`
- Table status guard: table can be set to `free` only when related dine/pre-order items are delivered
- Payment handling keeps dine/pre-order table marked `occupied`

### Management Controls
- Add/remove table
- Table status switch panel
- Ordering side panel for occupied/ordering tables with +/- and submit
- Menu CRUD (add/delete) and availability toggles
- Order list under Menu section
- Activity audit logs

### Reliability & Ops
- `/api/health` endpoint
- In-memory API rate limiting for `/api/*`
- Automatic SQLite backups with retention policy

---

## Quick Start (Local)

## 1) Install
```bash
npm install
```

## 2) Run
```bash
npm start
```

## 3) Open
- Management: `http://localhost:3000/management.html`
- Client: `http://localhost:3000/client.html`

---

## Environment Variables

Copy values from `.env.example` and override as needed:

- `NODE_ENV` (default: `development`)
- `PORT` (default: `3000`)
- `RATE_LIMIT_WINDOW_MS` (default: `60000`)
- `RATE_LIMIT_MAX` (default: `240`)
- `DB_BACKUP_ENABLED` (default: `true`)
- `DB_BACKUP_INTERVAL_MINUTES` (default: `60`)
- `DB_BACKUP_RETENTION_COUNT` (default: `48`)

PowerShell example:

```powershell
$env:NODE_ENV='production'
$env:PORT='3000'
$env:RATE_LIMIT_WINDOW_MS='60000'
$env:RATE_LIMIT_MAX='240'
$env:DB_BACKUP_ENABLED='true'
$env:DB_BACKUP_INTERVAL_MINUTES='60'
$env:DB_BACKUP_RETENTION_COUNT='48'
npm start
```

---

## NPM Scripts

- `npm start` → start server
- `npm run dev` → start server (same command currently)

---

## API Reference

### Health & State
- `GET /api/health` – service + DB health
- `GET /api/state` – full UI state (`menu`, `tables`, `orders`, `stats`)

### Menu
- `POST /api/menu/:id/availability` – set availability
- `POST /api/menu` – add menu item
- `DELETE /api/menu/:id` – delete menu item

### Orders
- `POST /api/orders` – create order
- `POST /api/orders/:id/status` – update order status (`new|preparing|ready|delivered`)
- `POST /api/orders/:id/pay` – mark order paid

### Tables
- `POST /api/tables/:tableNumber/toggle` – cycle table state
- `POST /api/tables/:tableNumber/status` – explicit state set
- `POST /api/tables` – add table
- `DELETE /api/tables/:tableNumber` – delete free table (with safety checks)

### Audit & Share
- `GET /api/audit-logs?limit=30`
- `GET /api/share-info`
- `GET /api/share-qr?target=<url>`

---

## Realtime Behavior

Socket.IO event:
- `state:update` – emitted whenever menu/tables/orders change.

Both pages subscribe and rerender from the server state to stay in sync.

---

## Business Rules (Current)

- Dine-in and pre-order require table selection.
- Creating dine-in marks table `occupied`.
- Creating pre-order marks table `ordering`.
- Status update effects:
  - `new` → table `ordering`
  - `preparing|ready` → table `occupied`
  - `delivered` → table `free`
- Paying a dine/pre-order marks table `occupied`.
- Setting table to `free` is blocked if there are undelivered dine/pre-order orders for that table.

---

## Database Notes

SQLite file:
- `data/restaurant.db`

Backups:
- `data/backups/restaurant-YYYYMMDDTHHMMSSZ.db`

Tables in DB:
- `menu_items`
- `table_status`
- `orders`
- `order_items`
- `audit_logs`

---

## Deployment

- Local-first runbook: see `DEPLOYMENT.md`
- `render.yaml` is present for cloud deployment scaffolding.

### Recommended low-cost internet backend (current codebase)

Use the existing backend as-is on **Render Web Service + persistent disk**:

- Runtime: Node.js web service
- Database: SQLite file persisted on Render disk (`/opt/render/project/src/data`)
- Realtime: Socket.IO works over the same Render service URL

This is the lowest-risk option for low traffic because no DB rewrite is needed.

#### Render steps

1. Push this repo to GitHub.
2. In Render, create a new **Blueprint** from repo (it will read `render.yaml`).
3. Ensure disk is attached as configured (`sqlite-data`, `1GB`).
4. Deploy.
5. Open:
  - `https://<your-service>.onrender.com/management.html`
  - `https://<your-service>.onrender.com/client.html`

#### Notes

- Free plans may sleep when idle (cold starts).
- For smoother always-on behavior, use a low paid Render instance.
- Backups continue to run on server interval and are saved under the mounted `data/backups/` path.

For small single-location setups, local SQLite is recommended.

---

## Troubleshooting

### UI says "Request failed"
- Ensure latest server is running on port 3000.
- Restart server:
  ```powershell
  npm start
  ```
- Hard refresh browser (`Ctrl+F5`).

### Port 3000 already in use
- Stop existing process and restart.

### Table not switching to free
- Check if related dine/pre-order orders are fully delivered; guard blocks freeing early by design.

### Rate limit responses (`429`)
- Wait for `RATE_LIMIT_WINDOW_MS` reset or increase limit for your environment.

---

## GitHub

Repository: `https://github.com/vishwa-10147/FoodOrder`

---

## License

ISC
