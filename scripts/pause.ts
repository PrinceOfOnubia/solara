import { configPda, loadEnv, program } from './common';

loadEnv();

async function main() {
  const { program: rewards, programId, admin } = await program();
  const sig = await rewards.methods.pause().accounts({ config: await configPda(programId), admin: admin.publicKey }).rpc();
  console.log(`pause tx=${sig}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
