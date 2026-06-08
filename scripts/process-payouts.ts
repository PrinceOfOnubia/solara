/// <reference lib="es2020" />
/// <reference types="node" />

import * as fs from 'fs';
import * as path from 'path';
import * as nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';

declare const fetch: any;

function loadEnv() {
  for (const file of ['.env.admin', '.env']) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readKeypair(filePath: string) {
  const expanded = filePath.replace(/^~(?=$|\/)/, process.env.HOME || '');
  const raw = JSON.parse(fs.readFileSync(expanded, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function adminHeaders() {
  const keypair = readKeypair(requireEnv('ADMIN_KEYPAIR_PATH'));
  const wallet = keypair.publicKey.toBase58();
  if (process.env.ADMIN_WALLET_PUBLIC_KEY && process.env.ADMIN_WALLET_PUBLIC_KEY !== wallet) {
    throw new Error('ADMIN_KEYPAIR_PATH does not match ADMIN_WALLET_PUBLIC_KEY');
  }
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const message = `SOLARA admin auth\nWallet: ${wallet}\nNonce: ${nonce}\nTimestamp: ${new Date().toISOString()}`;
  const messageBytes = Buffer.from(message);
  const signature = Buffer.from(nacl.sign.detached(messageBytes, keypair.secretKey)).toString('base64');
  return {
    'Content-Type': 'application/json',
    'X-Admin-Wallet': wallet,
    'X-Admin-Message': messageBytes.toString('base64'),
    'X-Admin-Signature': signature,
  };
}

async function main() {
  loadEnv();
  requireEnv('ADMIN_KEYPAIR_PATH');
  if (!process.env.REWARD_WALLET_KEYPAIR_PATH && !process.env.REWARD_WALLET_SECRET_JSON) {
    throw new Error('REWARD_WALLET_KEYPAIR_PATH or REWARD_WALLET_SECRET_JSON is required to process payouts');
  }

  const base = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const res = await fetch(`${base}/api/admin/payouts/process-batch`, {
    method: 'POST',
    headers: adminHeaders(),
    body: '{}',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Backend returned ${res.status}`);
  console.log(JSON.stringify(body, null, 2));
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
