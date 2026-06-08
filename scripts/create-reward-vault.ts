import { ensureRewardVault, loadEnv, program, publicKey, requireEnv } from './common';

loadEnv();

async function main() {
  const { conn, admin, programId } = await program();
  const mint = await publicKey(requireEnv('SOLR_MINT'));
  const vault = await ensureRewardVault(conn, admin, programId, mint);
  console.log(`SOLR_REWARD_VAULT=${vault.toBase58()}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
