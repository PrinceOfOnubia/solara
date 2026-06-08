# SOLARA Mainnet Rewards

SOLARA is a mainnet-beta Solana dashboard for GPU validation rewards. Users
connect a wallet, choose a GPU tier, start validating through the Anchor
program, accrue SOLR from on-chain timestamps, and claim SOLR from the funded
developer reward vault.

## Environment

Copy `.env.example` to `.env` for local runs, or set the same values in your
host:

```bash
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=
SOLARA_PROGRAM_ID=
SOLR_MINT=
SOLR_REWARD_VAULT=
SOLR_DECIMALS=9
ADMIN_WALLET_PUBLIC_KEY=
NETWORK_START_AT_ISO=2026-06-08T18:00:00.000Z
```

Admin wallet secrets stay local. The browser and web server only receive public
addresses and RPC configuration.

## Install And Run

```bash
npm install
npm run build
npm start
```

Open `http://localhost:3000`.

## Vercel Env Setup

Use `.env.vercel.example` as the template for Vercel project variables.

Required public/runtime values:

```bash
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=<mainnet RPC URL>
SOLARA_PROGRAM_ID=<program id>
SOLR_MINT=<mint>
SOLR_REWARD_VAULT=<vault>
SOLR_DECIMALS=9
ADMIN_WALLET_PUBLIC_KEY=<admin public key>
NETWORK_START_AT_ISO=2026-06-08T18:00:00.000Z
API_BASE_URL=
```

Set `API_BASE_URL` only if the frontend is served from Vercel while the backend
API is served from Railway. Do not put private keys in Vercel.

## Railway Env Setup

Use `.env.railway.example` as the template for Railway variables.

```bash
NODE_ENV=production
PORT=3000
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=<mainnet RPC URL>
SOLARA_PROGRAM_ID=<program id>
SOLR_MINT=<mint>
SOLR_REWARD_VAULT=<vault>
SOLR_DECIMALS=9
ADMIN_WALLET_PUBLIC_KEY=<admin public key>
NETWORK_START_AT_ISO=2026-06-08T18:00:00.000Z
ALLOWED_ORIGINS=https://your-vercel-domain.vercel.app,https://www.solaraproject.live,https://solaraprojec.live
```

Railway runs `npm start` and must not receive any admin private key.

## Admin Local Env Setup

Use `.env.admin.example` as the template for local-only deployment and vault
operations:

```bash
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=<mainnet RPC URL>
SOLARA_PROGRAM_ID=<program id>
SOLR_MINT=<mint>
SOLR_REWARD_VAULT=<vault>
SOLR_DECIMALS=9
ADMIN_WALLET_PUBLIC_KEY=<admin public key>
ADMIN_KEYPAIR_PATH=/absolute/path/to/admin-keypair.json
REWARD_VAULT_INITIAL_FUND_AMOUNT=1000
WITHDRAW_DESTINATION_TOKEN_ACCOUNT=<admin SOLR token account>
```

The admin keypair is local only. Contract deployment and script-based admin
operations must be done locally from the admin machine. Browser admin actions
use `/admin` and are signed by the connected wallet extension.

## Anchor Build

```bash
anchor build
anchor keys sync
```

Deploy to mainnet-beta:

```bash
anchor deploy --provider.cluster mainnet-beta
```

Set the deployed program id:

```bash
SOLARA_PROGRAM_ID=<program id>
```

## MAINNET DEPLOYMENT

## Before Going Live

Do not publicly announce or link the site until all of these are true:

- The Anchor program is deployed to mainnet-beta.
- The reward vault is created and funded.
- Program config is initialized with the production SOLR mint, reward vault,
  and tier rates.
- `npm run verify:mainnet` passes.
- A real small-wallet `Start Validating` transaction succeeds.
- A tiny `Claim` transaction succeeds and the vault/user balances move as
  expected.

1. Create the SOLR mint:

```bash
npm run admin:create-mint
```

Set `SOLR_MINT` to the printed mint address.

2. Create the reward vault. The vault is the associated token account for the
Config PDA and the SOLR mint:

```bash
npm run admin:create-reward-vault
```

Set `SOLR_REWARD_VAULT` to the printed vault address.

3. Initialize config with rates:

```bash
npm run admin:initialize-config
```

Rates:

- RTX 4090 = 5 SOLR/min
- A100 = 7 SOLR/min
- H100 = 10 SOLR/min

4. Fund the reward vault:

```bash
npm run admin:fund-vault -- 1000
```

The script mints SOLR to the admin token account if needed, then transfers the
requested amount into the reward vault.

5. Set hosted environment values:

```bash
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=<mainnet RPC URL>
SOLARA_PROGRAM_ID=<program id>
SOLR_MINT=<mint>
SOLR_REWARD_VAULT=<vault>
SOLR_DECIMALS=9
ADMIN_WALLET_PUBLIC_KEY=<admin public key>
NETWORK_START_AT_ISO=2026-06-08T18:00:00.000Z
```

6. Verify dashboard:

```bash
curl -I https://<your-host>
curl https://<your-host>/api/config
curl https://<your-host>/api/stats/global
```

7. Start validating from a wallet:

- Open the dashboard.
- Connect Phantom, Solflare, or Backpack.
- Choose a GPU tier.
- Click `Start Validating`.
- Confirm the mainnet transaction in the wallet.
- Refresh and confirm the validator status still reads from chain.

8. Claim a small amount:

- Wait until claimable SOLR is greater than zero.
- Click `Claim`.
- Confirm the transaction.
- Confirm total claimed and user SOLR balance update after confirmation.

9. Monitor reward vault balance:

```bash
spl-token balance SOLR_MINT --owner SOLR_REWARD_VAULT --url <mainnet RPC URL>
curl https://<your-host>/api/stats/global
```

If the vault is empty, claims fail on-chain and the UI displays
`Reward vault not funded`.

## Vault Funding

Fund from the local admin machine:

```bash
npm run admin:fund-vault -- 1000
```

This mints to the admin token account if needed and transfers SOLR into the
program-owned reward vault.

## Admin Vault Withdrawal

Withdraw unused SOLR from the reward vault to an admin SOLR token account:

```bash
npm run admin:withdraw -- 1000
```

Requirements:

- Run locally only with `.env.admin`.
- `ADMIN_KEYPAIR_PATH` must point to the config admin wallet keypair.
- `WITHDRAW_DESTINATION_TOKEN_ACCOUNT` must be a SOLR token account.
- Vercel and Railway must never receive `ADMIN_KEYPAIR_PATH`.

## Admin Panel

Open:

```text
https://<your-domain>/admin
```

Connect the configured admin wallet. The page unlocks only when the connected
wallet address equals `ADMIN_WALLET_PUBLIC_KEY`.

Admin actions available from the browser:

- Fund vault: transfers SOLR from the admin wallet SOLR ATA to the
  program-owned reward vault.
- Pause rewards: calls `pause()`.
- Resume rewards: calls `resume()`.
- Update rates: calls `update_rates([rtx4090, a100, h100])`.
- Withdraw vault funds: calls `admin_withdraw(amount)` to the admin wallet
  SOLR ATA.
- Refresh state: reloads config, vault balance, tier rates, and indexed global
  stats.

Security rules:

- Only the public admin wallet address goes in Vercel or Railway envs.
- Never upload the admin private key to Vercel or Railway.
- All `/admin` actions are signed from Phantom, Solflare, or Backpack.
- The backend never signs admin transactions.
- The reward vault remains owned by the Config PDA.

## Final Go-Live Checklist

Before launch:

- `npm run deploy:mainnet:checklist`
- `npm run verify:mainnet`
- Start validation succeeds from a small non-admin wallet.
- Claim succeeds for a tiny reward.
- Reward vault balance decreases.
- User SOLR associated token account balance increases.

## Admin Commands

```bash
npm run admin:create-mint
npm run admin:create-reward-vault
npm run admin:initialize-config
npm run admin:fund-vault -- 1000
npm run admin:update-rates
npm run admin:pause
npm run admin:resume
npm run admin:withdraw -- 1000
```

## Dashboard Data

User values come from the connected wallet, the user SOLR token account, the
Config PDA, and the UserValidator PDA derived from `[b"validator", wallet]`.

Global values come from `/api/stats/global`, which connects to
`SOLANA_RPC_URL`, fetches all UserValidator program accounts for
`SOLARA_PROGRAM_ID`, decodes them, counts active validators, sums total claimed,
and reads the reward vault token balance.

## Safety

- Claim uses checked math and fails when the vault balance is too low.
- The reward vault authority is the Config PDA.
- Only the admin can initialize config, pause, resume, or update rates.
- Users cannot mint SOLR through the dashboard or program.
- No admin private key is used by the frontend or hosted server.

MIT.
