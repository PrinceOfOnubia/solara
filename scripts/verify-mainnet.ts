import { configPda, loadEnv, publicKey, requireEnv, splTokenSdk, TOKEN_RATES, web3Sdk } from './common';
import * as crypto from 'crypto';

loadEnv();

const CONFIG_DISC = crypto.createHash('sha256').update('account:Config').digest().subarray(0, 8);

function missingMainnetEnvs() {
  const required = [
    'SOLANA_CLUSTER',
    'SOLANA_RPC_URL',
    'SOLARA_PROGRAM_ID',
    'SOLR_MINT',
    'SOLR_REWARD_VAULT',
    'SOLR_DECIMALS',
    'ADMIN_WALLET_PUBLIC_KEY',
    'NETWORK_START_AT_ISO',
  ];
  return required.filter(name => !process.env[name]);
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

async function readPubkey(data: Buffer, offset: number) {
  return publicKey(data.subarray(offset, offset + 32));
}

function readU64(data: Buffer, offset: number) {
  return data.readBigUInt64LE(offset);
}

async function decodeConfig(data: Buffer) {
  assert(data.length >= 8 + 32 + 32 + 32 + 1 + 24 + 8 + 8 + 8 + 8 + 1, 'Config account data is too small');
  assert(data.subarray(0, 8).equals(CONFIG_DISC), 'Config account discriminator mismatch');
  let o = 8;
  const admin = await readPubkey(data, o); o += 32;
  const mint = await readPubkey(data, o); o += 32;
  const rewardVault = await readPubkey(data, o); o += 32;
  const paused = data.readUInt8(o) !== 0; o += 1;
  const tierRates = [readU64(data, o), readU64(data, o + 8), readU64(data, o + 16)]; o += 24;
  const activeValidators = readU64(data, o); o += 8;
  const activeRewardRateUnitsPerMinute = readU64(data, o); o += 8;
  const totalEarned = readU64(data, o); o += 8;
  const totalClaims = readU64(data, o); o += 8;
  const bump = data.readUInt8(o);
  return { admin, mint, rewardVault, paused, tierRates, activeValidators, activeRewardRateUnitsPerMinute, totalEarned, totalClaims, bump };
}

async function main() {
  const missing = missingMainnetEnvs();
  if (missing.length > 0 || process.env.SOLANA_CLUSTER !== 'mainnet-beta') {
    const invalid = process.env.SOLANA_CLUSTER && process.env.SOLANA_CLUSTER !== 'mainnet-beta' ? ['SOLANA_CLUSTER=mainnet-beta'] : [];
    throw new Error(`Mainnet envs are missing. Fill .env with real deployed values before launch. Missing/invalid: ${missing.concat(invalid).join(', ')}`);
  }

  const rpcUrl = requireEnv('SOLANA_RPC_URL');
  const { Connection } = await web3Sdk();
  const { getAccount, getMint } = await splTokenSdk();
  const conn = new Connection(rpcUrl, 'confirmed');
  const version = await conn.getVersion();
  console.log(`RPC connection ok: solana-core ${version['solana-core']}`);

  const programId = await publicKey(requireEnv('SOLARA_PROGRAM_ID'));
  const mint = await publicKey(requireEnv('SOLR_MINT'));
  const rewardVault = await publicKey(requireEnv('SOLR_REWARD_VAULT'));
  const admin = await publicKey(requireEnv('ADMIN_WALLET_PUBLIC_KEY'));

  const programAccount = await conn.getAccountInfo(programId);
  assert(programAccount, 'Program account does not exist');
  assert(programAccount.executable, 'Program account exists but is not executable');
  console.log('Program account ok');

  const mintAccount = await getMint(conn, mint);
  assert(mintAccount.decimals === Number(requireEnv('SOLR_DECIMALS')), 'SOLR mint decimals do not match SOLR_DECIMALS');
  console.log('SOLR mint ok');

  const vaultAccount = await getAccount(conn, rewardVault);
  assert(vaultAccount.mint.equals(mint), 'Reward vault mint does not match SOLR_MINT');
  assert(vaultAccount.amount > BigInt(0), 'Reward vault exists but has zero balance');
  console.log(`Reward vault ok: balance units=${vaultAccount.amount.toString()}`);

  const config = await configPda(programId);
  const configAccount = await conn.getAccountInfo(config);
  assert(configAccount, 'Config PDA does not exist');
  const decoded = await decodeConfig(Buffer.from(configAccount.data));
  assert(decoded.admin.equals(admin), 'Config admin does not match ADMIN_WALLET_PUBLIC_KEY');
  assert(decoded.mint.equals(mint), 'Config mint does not match SOLR_MINT');
  assert(decoded.rewardVault.equals(rewardVault), 'Config reward vault does not match SOLR_REWARD_VAULT');
  for (let i = 0; i < TOKEN_RATES.length; i += 1) {
    assert(decoded.tierRates[i] === BigInt(TOKEN_RATES[i].toString()), `Tier ${i} rate is incorrect`);
  }
  assert(!decoded.paused, 'Program config is paused');
  console.log('Config PDA ok');
  console.log('Tier rates ok');
  console.log('Program is not paused');
  console.log('Mainnet verification passed');
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
