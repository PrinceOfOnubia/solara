/// <reference lib="es2020" />
/// <reference types="node" />

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const TOKEN_RATES = [
  '5000000000',
  '7000000000',
  '10000000000',
];

export async function runtimeImport(specifier: string): Promise<any> {
  return Function('specifier', 'return import(specifier)')(specifier);
}

export async function anchorSdk() {
  return runtimeImport('@coral-xyz/anchor');
}

export async function web3Sdk() {
  return runtimeImport('@solana/web3.js');
}

export async function splTokenSdk() {
  return runtimeImport('@solana/spl-token');
}

export async function tokenRatesBn() {
  const anchor = await anchorSdk();
  return TOKEN_RATES.map(rate => new anchor.BN(rate));
}

export function loadEnv() {
  for (const file of ['.env.admin', '.env']) {
    const envPath = path.join(process.cwd(), file);
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!match || line.trim().startsWith('#')) continue;
      if (process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
}

export function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function adminKeypair() {
  const { Keypair } = await web3Sdk();
  const walletPath = process.env.ADMIN_KEYPAIR_PATH || process.env.ANCHOR_WALLET || path.join(os.homedir(), '.config/solana/id.json');
  const expanded = walletPath.startsWith('~') ? path.join(os.homedir(), walletPath.slice(1)) : walletPath;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(expanded, 'utf8'))));
}

export async function connection() {
  const { Connection } = await web3Sdk();
  const cluster = process.env.SOLANA_CLUSTER || 'mainnet-beta';
  if (cluster !== 'mainnet-beta') throw new Error('SOLANA_CLUSTER must be mainnet-beta');
  return new Connection(requireEnv('SOLANA_RPC_URL'), 'confirmed');
}

export const IDL: any = {
  version: '0.1.0',
  name: 'solara_rewards',
  instructions: [
    { name: 'initializeConfig', accounts: [
      { name: 'config', isMut: true, isSigner: false },
      { name: 'admin', isMut: true, isSigner: true },
      { name: 'mint', isMut: false, isSigner: false },
      { name: 'rewardVault', isMut: false, isSigner: false },
      { name: 'systemProgram', isMut: false, isSigner: false },
    ], args: [{ name: 'tierRates', type: { array: ['u64', 3] } }] },
    { name: 'updateTierRate', accounts: [
      { name: 'config', isMut: true, isSigner: false },
      { name: 'admin', isMut: false, isSigner: true },
    ], args: [{ name: 'gpuTier', type: 'u8' }, { name: 'unitsPerMinute', type: 'u64' }] },
    { name: 'pause', accounts: [
      { name: 'config', isMut: true, isSigner: false },
      { name: 'admin', isMut: false, isSigner: true },
    ], args: [] },
    { name: 'resume', accounts: [
      { name: 'config', isMut: true, isSigner: false },
      { name: 'admin', isMut: false, isSigner: true },
    ], args: [] },
    { name: 'adminWithdraw', accounts: [
      { name: 'config', isMut: false, isSigner: false },
      { name: 'admin', isMut: false, isSigner: true },
      { name: 'rewardVault', isMut: true, isSigner: false },
      { name: 'adminDestinationTokenAccount', isMut: true, isSigner: false },
      { name: 'tokenProgram', isMut: false, isSigner: false },
    ], args: [{ name: 'amount', type: 'u64' }] },
  ],
};

export async function program() {
  const anchor = await anchorSdk();
  const { PublicKey } = await web3Sdk();
  const conn = await connection();
  const admin = await adminKeypair();
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  const programId = new PublicKey(requireEnv('SOLARA_PROGRAM_ID'));
  return { conn, admin, provider, program: new anchor.Program({ ...IDL, address: programId.toBase58() }, provider), programId };
}

export async function publicKey(value: string | Uint8Array) {
  const { PublicKey } = await web3Sdk();
  return new PublicKey(value);
}

export async function systemProgramId() {
  const { SystemProgram } = await web3Sdk();
  return SystemProgram.programId;
}

export async function tokenProgramId() {
  const { TOKEN_PROGRAM_ID } = await splTokenSdk();
  return TOKEN_PROGRAM_ID;
}

export async function configPda(programId: any) {
  const { PublicKey } = await web3Sdk();
  return PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0];
}

export async function rewardVaultAddress(programId: any, mint: any) {
  const { getAssociatedTokenAddressSync } = await splTokenSdk();
  return getAssociatedTokenAddressSync(mint, await configPda(programId), true);
}

export async function ensureRewardVault(conn: any, payer: any, programId: any, mint: any) {
  const { Transaction, sendAndConfirmTransaction } = await web3Sdk();
  const {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    getAccount,
  } = await splTokenSdk();
  const owner = await configPda(programId);
  const vault = await rewardVaultAddress(programId, mint);
  try {
    await getAccount(conn, vault);
    return vault;
  } catch (_) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        vault,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
    return vault;
  }
}
