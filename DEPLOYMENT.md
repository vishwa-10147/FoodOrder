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

Recommended operational settings:

- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_MAX=240`
- `DB_BACKUP_ENABLED=true`
- `DB_BACKUP_INTERVAL_MINUTES=60`
- `DB_BACKUP_RETENTION_COUNT=48`

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

## 7) Operational Notes
- Render free tiers may sleep when idle.
- Keep persistent disk enabled; without it, SQLite data can be lost between deploys.
- For higher traffic, move to managed Postgres in a future phase.
