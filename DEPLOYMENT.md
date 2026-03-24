# Free Deployment Guide (Render + Supabase)

## 1) Create free Postgres (Supabase)
1. Go to Supabase and create a new project (free tier).
2. Open `Project Settings` -> `Database` -> `Connection string`.
3. Copy the `URI` format connection string.
4. Ensure `sslmode=require` is in the URL.

## 2) Push code to GitHub
1. Create a new GitHub repository.
2. Push this project.

## 3) Deploy backend on Render (free)
1. Go to Render -> `New` -> `Blueprint` (or Web Service).
2. Connect your GitHub repo.
3. If using Blueprint, it reads `render.yaml` automatically.
4. In Render env vars, set:
   - `DATABASE_URL` = your Supabase connection string
   - `PGSSL` = `true`
   - `NODE_ENV` = `production`
5. Deploy.

## 4) Open your app URLs
After deploy, use:
- `https://<your-render-domain>/management.html`
- `https://<your-render-domain>/client.html`

Both pages share the same internet database and real-time updates.

## Notes
- Do not use browser localStorage for shared order data.
- Managed Postgres is your source of truth for all users.
- Free tiers may sleep or have usage limits depending on provider policy.
