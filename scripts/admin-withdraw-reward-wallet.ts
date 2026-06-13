/// <reference lib="es2020" />
/// <reference types="node" />

import bs58 from 'bs58';
import { connection, loadEnv, publicKey, requireEnv, splTokenSdk, web3Sdk } from './common';

function toUnits(amount: string, decimals: number) {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error('Amount must be a positive SOLR number');
  const [whole, frac = ''] = amount.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  let multiplier = BigInt(1);
  for (let i = 0; i < decimals; i += 1) multiplier *= BigInt(10);
  return BigInt(whole) * multiplier + BigInt(padded || '0');
}

async function main() {
  loadEnv();
  const destination = process.argv[2];
  const amount = process.argv[3];
  if (!destination || !amount) {
    throw new Error('Usage: npm run admin:withdraw-reward-wallet -- <destination-wallet-or-token-account> <amount-solr>');
  }

  const { Keypair, PublicKey } = await web3Sdk();
  const {
    getAccount,
    getOrCreateAssociatedTokenAccount,
    transfer,
  } = await splTokenSdk();

  const conn = await connection();
  const mint = await publicKey(requireEnv('SOLR_MINT'));
  const decimals = Number(process.env.SOLR_DECIMALS || 9);
  const privateKey = requireEnv('REWARD_WALLET_PRIVATE_KEY');
  const rewardWallet = Keypair.fromSecretKey(bs58.decode(privateKey));
  const sourceAta = await getOrCreateAssociatedTokenAccount(conn, rewardWallet, mint, rewardWallet.publicKey);
  const destinationPubkey = new PublicKey(destination);

  let destinationAta = destinationPubkey;
  try {
    const account = await getAccount(conn, destinationPubkey);
    if (!account.mint.equals(mint)) throw new Error('Destination token account mint does not match SOLR_MINT');
  } catch (error: any) {
    if (/mint does not match/i.test(String(error?.message || error))) throw error;
    destinationAta = (await getOrCreateAssociatedTokenAccount(conn, rewardWallet, mint, destinationPubkey)).address;
  }

  const signature = await transfer(
    conn,
    rewardWallet,
    sourceAta.address,
    destinationAta,
    rewardWallet,
    toUnits(amount, decimals),
  );

  console.log(`Transferred ${amount} SOLR`);
  console.log(`From reward wallet: ${rewardWallet.publicKey.toBase58()}`);
  console.log(`Destination token account: ${destinationAta.toBase58()}`);
  console.log(`Signature: ${signature}`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
