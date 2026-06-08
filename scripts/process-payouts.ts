/// <reference lib="es2020" />
/// <reference types="node" />

import * as fs from 'fs';
import * as path from 'path';

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

async function main() {
  loadEnv();
  requireEnv('ADMIN_API_KEY');
  if (!process.env.REWARD_WALLET_KEYPAIR_PATH && !process.env.REWARD_WALLET_SECRET_JSON) {
    throw new Error('REWARD_WALLET_KEYPAIR_PATH or REWARD_WALLET_SECRET_JSON is required to process payouts');
  }

  const base = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const res = await fetch(`${base}/api/admin/payouts/process-batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
    },
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
