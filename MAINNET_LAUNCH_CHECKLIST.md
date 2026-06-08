# SOLARA Mainnet Launch Checklist

1. Choose RPC provider
   - Pick a production Solana mainnet-beta RPC provider.
   - Confirm it supports `getProgramAccounts` for your deployed program.
   - Set `SOLANA_RPC_URL` locally.

2. Create admin wallet
   - Create or choose the wallet that will deploy the program, create the mint,
     own mint authority, initialize config, and fund the reward vault.
   - Store the keypair locally only.
   - Set `ANCHOR_WALLET=/path/to/admin-keypair.json` locally.

3. Fund admin wallet with SOL
   - Fund the admin wallet with enough SOL for mainnet deployment, account rent,
     mint creation, vault creation, and verification transactions.
   - Confirm balance:
     ```bash
     solana balance --url <SOLANA_RPC_URL>
     ```

4. Create SOLR mint
   ```bash
   npm run admin:create-mint
   ```
   - Copy the printed `SOLR_MINT=<mint>` into `.env`.

5. Deploy Anchor program to mainnet-beta
   ```bash
   anchor build
   anchor keys sync
   anchor deploy --provider.cluster mainnet-beta
   ```
   - Copy the deployed program id into `.env` as `SOLARA_PROGRAM_ID`.

6. Create reward vault
   ```bash
   npm run admin:create-reward-vault
   ```
   - Copy the printed `SOLR_REWARD_VAULT=<vault>` into `.env`.

7. Fund reward vault
   ```bash
   npm run admin:fund-vault -- <SOLR_AMOUNT>
   ```
   - Use a small amount first for launch testing, then top up for production.

8. Initialize config
   ```bash
   npm run admin:initialize-config
   ```
   - Confirm the configured rates:
     - RTX 4090 = 5 SOLR/min
     - A100 = 7 SOLR/min
     - H100 = 10 SOLR/min

9. Set Vercel/Railway envs
   ```bash
   SOLANA_CLUSTER=mainnet-beta
   SOLANA_RPC_URL=<mainnet RPC URL>
   SOLARA_PROGRAM_ID=<deployed program id>
   SOLR_MINT=<mint>
   SOLR_REWARD_VAULT=<vault>
   SOLR_DECIMALS=9
   ADMIN_WALLET_PUBLIC_KEY=<admin public key>
   NETWORK_START_AT_ISO=2026-06-08T18:00:00.000Z
   ```

10. Verify `/api/config`
    ```bash
    curl https://<your-host>/api/config
    ```
    - Confirm cluster is `mainnet-beta`.
    - Confirm program id, SOLR mint, reward vault, and network start are correct.

11. Verify `/api/stats/global`
    ```bash
    curl https://<your-host>/api/stats/global
    ```
    - Confirm the reward vault balance is nonzero.
    - Confirm no error is returned.

12. Run mainnet verifier
    ```bash
    npm run verify:mainnet
    ```
    - Do not proceed until it passes.

13. Test Start Validating with a small wallet
    - Connect a non-admin test wallet.
    - Select a GPU tier.
    - Click `Start Validating`.
    - Confirm the mainnet transaction.
    - Refresh the page and confirm status still reads active from chain.

14. Test Claim with a tiny reward
    - Wait briefly until claimable SOLR is greater than zero.
    - Click `Claim`.
    - Confirm the mainnet transaction.
    - Confirm the UI refreshes after confirmation.

15. Confirm vault balance decreases
    ```bash
    npm run verify:mainnet
    ```
    - Compare reward vault balance before and after the claim.

16. Confirm user SOLR ATA balance increases
    - In the wallet or SPL Token CLI, confirm the test wallet’s SOLR associated
      token account balance increased by the claimed amount.
