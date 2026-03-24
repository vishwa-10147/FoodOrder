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
