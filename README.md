# SOLARA MVP Ledger Payout Mode

SOLARA currently runs in MVP ledger payout mode. Users connect a Solana wallet,
choose a GPU plan, start a backend validation session, accrue SOLR in the
backend ledger, and request a payout. Admins approve requests and pay users from
the reward wallet manually or with the optional batch processor.

No Anchor deployment is required for the current MVP mode. The Anchor program in
`programs/solara_rewards` is kept as optional future on-chain vault mode.

## Install And Run

```bash
npm install --legacy-peer-deps --no-audit --no-fund
npm run build
npm start
```

Open `http://localhost:3000`.

## MVP Ledger Payout Mode

Flow:

1. User connects Phantom, Solflare, or Backpack.
2. User selects a GPU plan:
   - RTX 4090 = 5 SOLR/min
   - A100 = 7 SOLR/min
   - H100 = 10 SOLR/min
3. User clicks `Start validating`.
4. Backend creates a ledger validation session.
5. Backend accrues pending SOLR from elapsed time and the selected plan.
6. User clicks `Request Payout`.
7. Pending rewards are reserved in `payout_requests`.
8. Admin approves or rejects the request in `/admin`.
9. Admin processes a batch payout from the reward wallet SOLR ATA to user ATAs.

The frontend shows ledger values only for user rewards: pending rewards, paid
rewards, active plan, and payout history all come from the backend ledger.

## Database

Railway Postgres is required for real users. SQLite is local development only.
The server refuses to start in production unless `DATABASE_URL` is a PostgreSQL
URL.

Local development can leave `DATABASE_URL` empty to use
`./data/solara-ledger.sqlite`.

Tables:

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

## Backend API

User endpoints:

```text
POST /api/validate/start
GET  /api/user/:wallet/rewards
POST /api/claim/request
```

Admin endpoints:

```text
GET  /api/admin/summary
GET  /api/admin/payouts?status=pending
POST /api/admin/payouts/:id/approve
POST /api/admin/payouts/:id/reject
POST /api/admin/payouts/process-batch
POST /api/admin/rates
POST /api/admin/sessions/:wallet/stop
POST /api/admin/pause
POST /api/admin/resume
GET  /api/admin/settings
POST /api/admin/settings
GET  /api/admin/blacklist
POST /api/admin/blacklist
POST /api/admin/unblacklist
GET  /api/admin/audit-logs
```

Admin browser endpoints require a wallet-signed message from
`ADMIN_WALLET_PUBLIC_KEY`, including a timestamp and nonce. Never expose
`ADMIN_API_KEY` to Vercel or browser JavaScript.

## Vercel Env Setup

Use `.env.vercel.example`:

```bash
API_BASE_URL=
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=
SOLR_MINT=
SOLR_DECIMALS=9
ADMIN_WALLET_PUBLIC_KEY=
```

Vercel receives public runtime values only. Do not add private keys,
`ADMIN_API_KEY`, or reward wallet secrets to Vercel.

## Railway Env Setup

Use `.env.railway.example`:

```bash
NODE_ENV=production
PORT=3000
DATABASE_URL=
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=
SOLR_MINT=
SOLR_DECIMALS=9
ADMIN_WALLET_PUBLIC_KEY=
ADMIN_API_KEY=
ENABLE_AUTO_PAYOUTS=false
PAYOUT_INTERVAL_MINUTES=30
MIN_PAYOUT_AMOUNT=100
CLAIM_COOLDOWN_MINUTES=30
DAILY_REWARD_CAP=500
MAX_ACTIVE_SESSION_HOURS=24
REWARD_WALLET_SECRET_JSON=
NETWORK_START_AT_ISO=2026-06-08T18:00:00.000Z
ALLOWED_ORIGINS=https://your-vercel-domain.vercel.app,https://www.solaraproject.live
```

Railway runs:

```bash
npm start
```

Add Railway Postgres before real users. See
[docs/postgres-migration.md](docs/postgres-migration.md). Do not launch with
SQLite in production.

`REWARD_WALLET_SECRET_JSON` is optional. If set, Railway can process approved
payouts automatically or through the admin panel. Treat it as a hot wallet:
fund it only with the amount needed for near-term rewards.

Start with `ENABLE_AUTO_PAYOUTS=false` and use manual approval first. Fund the
reward wallet with a small launch amount, monitor payout volume, then increase
funding gradually.

## Admin Local Env Setup

Use `.env.admin.example` for local payout operations:

```bash
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=
SOLR_MINT=
SOLR_DECIMALS=9
ADMIN_WALLET_PUBLIC_KEY=
ADMIN_API_KEY=
ADMIN_KEYPAIR_PATH=
REWARD_WALLET_KEYPAIR_PATH=
REWARD_WALLET_SECRET_JSON=
DATABASE_URL=
API_BASE_URL=http://localhost:3000
```

`ADMIN_KEYPAIR_PATH` and `REWARD_WALLET_KEYPAIR_PATH` stay local. Do not commit
them and do not upload them to Vercel or Railway.

## Admin Panel

Open:

```text
/admin
```

Steps:

1. Connect the admin wallet.
2. Sign the admin authorization message.
3. Review summary cards and reward wallet balance.
4. Approve or reject pending payout requests.
5. Click `Process approved batch` to send SOLR to users.
6. Update GPU reward rates when needed.
7. Pause/resume rewards during incidents.
8. Update safety settings.
9. Blacklist suspicious wallets.
10. Review audit logs.

The browser admin panel never receives a private key. Admin authorization is a
wallet signature verified by the backend.

Emergency controls:

- Pause blocks new validation sessions.
- Blacklist blocks a wallet from starting sessions or requesting payouts.
- Rejecting a payout returns the reserved amount to the user's pending balance.
- Audit logs record pause, resume, rate updates, payout approval/rejection,
  batch processing, blacklist changes, and safety setting updates.

## Payout Processing

Manual local batch:

```bash
npm run process-payouts
```

The script requires:

- `ADMIN_KEYPAIR_PATH` for signing the admin request locally
- `API_BASE_URL`
- `REWARD_WALLET_KEYPAIR_PATH` or `REWARD_WALLET_SECRET_JSON`

`ADMIN_API_KEY` is kept as a backend-only operations secret, but browser admin
actions and the local batch script use wallet-signed admin authentication. Do not
upload the admin keypair to Vercel or Railway.

Optional Railway automation:

```bash
ENABLE_AUTO_PAYOUTS=true
PAYOUT_INTERVAL_MINUTES=30
REWARD_WALLET_SECRET_JSON=[...]
```

The batch processor pays approved requests only. It creates the user SOLR ATA if
needed, transfers SOLR from the reward wallet ATA, stores the transaction
signature, and marks failed payouts with an error.

## Deployment Order

1. Create or choose a reward wallet.
2. Fund the reward wallet with SOL and SOLR.
3. Set Railway envs.
4. Deploy backend to Railway.
5. Set Vercel envs, including `API_BASE_URL=<Railway backend URL>`.
6. Deploy frontend to Vercel.
7. Update Railway `ALLOWED_ORIGINS` with the Vercel and production domains.
8. Verify `/api/config`.
9. Verify `/api/stats/global`.
10. Test `Start validating` with a small wallet.
11. Wait briefly and test `Request Payout`.
12. Connect `/admin`, approve the request, and process a tiny payout.
13. Confirm reward wallet SOLR decreases.
14. Confirm user SOLR ATA balance increases.

## Future On-Chain Vault Mode

The optional Anchor program supports a future direct-claim model where a program
PDA owns the reward vault and users claim from on-chain validator accounts. That
mode requires Anchor deploy/config/vault funding and is not required for this
MVP ledger launch.

## Verification

```bash
npm run build
node --check server.js
npx tsc --noEmit scripts/*.ts
cargo test --manifest-path programs/solara_rewards/Cargo.toml
```

MIT.
