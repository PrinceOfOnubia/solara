import { configPda, loadEnv, program, tokenRatesBn } from './common';

loadEnv();

async function main() {
  const { program: rewards, programId, admin } = await program();
  const config = await configPda(programId);
  const rates = await tokenRatesBn();
  for (let tier = 0; tier < rates.length; tier += 1) {
    const sig = await rewards.methods.updateTierRate(tier, rates[tier]).accounts({
      config,
      admin: admin.publicKey,
    }).rpc();
    console.log(`update_tier_rate tier=${tier} tx=${sig}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
