import { connection, adminKeypair, loadEnv, splTokenSdk } from './common';

loadEnv();

async function main() {
  const { createMint } = await splTokenSdk();
  const conn = await connection();
  const admin = await adminKeypair();
  if (process.env.SOLR_MINT) {
    console.log(`SOLR_MINT already set: ${process.env.SOLR_MINT}`);
    return;
  }
  const mint = await createMint(conn, admin, admin.publicKey, admin.publicKey, Number(process.env.SOLR_DECIMALS || 9));
  console.log(`SOLR_MINT=${mint.toBase58()}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
