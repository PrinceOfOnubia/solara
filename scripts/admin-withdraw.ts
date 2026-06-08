import { anchorSdk, configPda, loadEnv, program, publicKey, requireEnv, tokenProgramId } from './common';

loadEnv();

function toUnits(amount: string, decimals: number) {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error('Amount must be a positive number');
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > decimals) throw new Error(`Amount has more than ${decimals} decimals`);
  const padded = fraction.padEnd(decimals, '0');
  const scale = BigInt(`1${'0'.repeat(decimals)}`);
  const units = BigInt(whole) * scale + BigInt(padded || '0');
  if (units <= BigInt(0)) throw new Error('Amount must be greater than zero');
  return units.toString();
}

async function main() {
  if (!process.env.ADMIN_KEYPAIR_PATH) throw new Error('ADMIN_KEYPAIR_PATH is required for admin withdrawal');
  const amount = process.argv[2];
  if (!amount) throw new Error('Usage: npm run admin:withdraw -- <SOLR amount>');
  const anchor = await anchorSdk();
  const { program: rewards, programId, admin } = await program();
  const config = await configPda(programId);
  const rewardVault = await publicKey(requireEnv('SOLR_REWARD_VAULT'));
  const destination = await publicKey(requireEnv('WITHDRAW_DESTINATION_TOKEN_ACCOUNT'));
  const units = new anchor.BN(toUnits(amount, Number(process.env.SOLR_DECIMALS || 9)));
  const sig = await rewards.methods.adminWithdraw(units).accounts({
    config,
    admin: admin.publicKey,
    rewardVault,
    adminDestinationTokenAccount: destination,
    tokenProgram: await tokenProgramId(),
  }).rpc();
  console.log(`admin_withdraw tx=${sig}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
