import { loadEnv, adminKeypair, connection, publicKey, requireEnv, splTokenSdk } from './common';

loadEnv();

async function main() {
  const amountTokens = process.argv[2];
  if (!amountTokens) throw new Error('Usage: npm run admin:fund-vault -- <SOLR amount>');
  const decimals = Number(process.env.SOLR_DECIMALS || 9);
  const units = BigInt(Math.floor(Number(amountTokens) * 10 ** decimals));
  const { getOrCreateAssociatedTokenAccount, mintTo, transfer } = await splTokenSdk();
  const conn = await connection();
  const admin = await adminKeypair();
  const mint = await publicKey(requireEnv('SOLR_MINT'));
  const vault = await publicKey(requireEnv('SOLR_REWARD_VAULT'));
  const adminToken = await getOrCreateAssociatedTokenAccount(conn, admin, mint, admin.publicKey);
  const balance = await conn.getTokenAccountBalance(adminToken.address).catch(() => null);
  const current = BigInt(balance?.value.amount || '0');
  if (current < units) {
    await mintTo(conn, admin, mint, adminToken.address, admin, units - current);
  }
  const sig = await transfer(conn, admin, adminToken.address, vault, admin, units);
  console.log(`fund_vault tx=${sig}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
