# SOLARA Postgres Migration Notes

SOLARA production ledger mode requires Railway Postgres. SQLite is supported
only for local development.

## Railway Postgres Setup

1. In Railway, add a Postgres database to the SOLARA project.
2. Copy the Postgres `DATABASE_URL`.
3. Set the backend service variable:

```bash
DATABASE_URL=postgresql://...
NODE_ENV=production
```

4. Redeploy the backend service.

At startup, `server.js` initializes the required schema automatically.

## Verify Tables

Open the Railway Postgres shell and run:

```sql
\dt
SELECT key, value FROM system_settings ORDER BY key;
SELECT gpu_tier, rate_per_minute FROM reward_rates ORDER BY gpu_tier;
```

Required tables:

- `users`
- `validation_sessions`
- `reward_balances`
- `payout_requests`
- `payout_batches`
- `reward_rates`
- `admin_audit_logs`
- `wallet_blacklist`
- `system_settings`
- `reward_accrual_events`

## SQLite Migration Warning

Existing SQLite data from `/data/solara-ledger.sqlite` is not automatically
migrated. To preserve prior local ledger data, export rows from SQLite and import
them into Railway Postgres before launch.

Do not launch production with SQLite. The server refuses to start when
`NODE_ENV=production` and `DATABASE_URL` is not a PostgreSQL URL.
