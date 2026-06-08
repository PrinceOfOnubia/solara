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
4. Backend creates a SQLite validation session.
5. Backend accrues pending SOLR from elapsed time and the selected plan.
6. User clicks `Request Payout`.
7. Pending rewards are reserved in `payout_requests`.
8. Admin approves or rejects the request in `/admin`.
9. Admin processes a batch payout from the reward wallet SOLR ATA to user ATAs.

The frontend shows ledger values only for user rewards: pending rewards, paid
rewards, active plan, and payout history all come from the backend ledger.

## Database

SQLite is used by default. Set `DATABASE_URL` to a file path or leave it empty
to use `./data/solara-ledger.sqlite`.

Tables:

- `users`
- `validation_sessions`
- `reward_balances`
- `payout_requests`
- `payout_batches`
- `reward_rates`

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
```

Admin endpoints accept either:

- `Authorization: Bearer ADMIN_API_KEY` for local scripts and server-to-server
  calls.
- A browser wallet signed message from `ADMIN_WALLET_PUBLIC_KEY`.

Never expose `ADMIN_API_KEY` to Vercel or browser JavaScript.

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
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=
SOLR_MINT=
SOLR_DECIMALS=9
ADMIN_WALLET_PUBLIC_KEY=
ADMIN_API_KEY=
DATABASE_URL=
ENABLE_AUTO_PAYOUTS=false
PAYOUT_INTERVAL_MINUTES=30
REWARD_WALLET_SECRET_JSON=
NETWORK_START_AT_ISO=2026-06-08T18:00:00.000Z
ALLOWED_ORIGINS=https://your-vercel-domain.vercel.app,https://www.solaraproject.live
```

Railway runs:

```bash
npm start
```

`REWARD_WALLET_SECRET_JSON` is optional. If set, Railway can process approved
payouts automatically or through the admin panel. Treat it as a hot wallet:
fund it only with the amount needed for near-term rewards.

## Admin Local Env Setup

Use `.env.admin.example` for local payout operations:

```bash
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=
SOLR_MINT=
SOLR_DECIMALS=9
ADMIN_WALLET_PUBLIC_KEY=
ADMIN_API_KEY=
REWARD_WALLET_KEYPAIR_PATH=
REWARD_WALLET_SECRET_JSON=
DATABASE_URL=
API_BASE_URL=http://localhost:3000
```

`REWARD_WALLET_KEYPAIR_PATH` stays local. Do not commit it and do not upload it
to Vercel.

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

The browser admin panel never receives a private key. Admin authorization is a
wallet signature verified by the backend.

## Payout Processing

Manual local batch:

```bash
npm run process-payouts
```

The script requires:

- `ADMIN_API_KEY`
- `API_BASE_URL`
- `REWARD_WALLET_KEYPAIR_PATH` or `REWARD_WALLET_SECRET_JSON`

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
