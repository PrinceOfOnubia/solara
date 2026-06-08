import { configPda, loadEnv, program, publicKey, requireEnv, systemProgramId, tokenRatesBn } from './common';

loadEnv();

async function main() {
  const { program: rewards, programId, admin } = await program();
  const mint = await publicKey(requireEnv('SOLR_MINT'));
  const rewardVault = await publicKey(requireEnv('SOLR_REWARD_VAULT'));
  const config = await configPda(programId);
  const sig = await rewards.methods.initializeConfig(await tokenRatesBn()).accounts({
    config,
    admin: admin.publicKey,
    mint,
    rewardVault,
    systemProgram: await systemProgramId(),
  }).rpc();
  console.log(`initialize_config tx=${sig}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
