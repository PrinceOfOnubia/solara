'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');

(() => {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      const k = m[1];
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (_) {}
})();

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const xfproto = req.headers['x-forwarded-proto'];
  if (process.env.NODE_ENV === 'production' && xfproto && xfproto !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const localDev = !ALLOWED_ORIGINS.length && origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (origin && (ALLOWED_ORIGINS.includes(origin) || localDev)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

const CLUSTER = process.env.SOLANA_CLUSTER || 'mainnet-beta';
const RPC_URL = process.env.SOLANA_RPC_URL || '';
const PROGRAM_ID = process.env.SOLARA_PROGRAM_ID || '';
const SOLR_MINT = process.env.SOLR_MINT || '';
const REWARD_VAULT = process.env.SOLR_REWARD_VAULT || '';
const SOLR_DECIMALS = Number(process.env.SOLR_DECIMALS || 9);
const NETWORK_START_AT_ISO = process.env.NETWORK_START_AT_ISO || '2026-06-08T18:00:00.000Z';
const ADMIN_WALLET_PUBLIC_KEY = process.env.ADMIN_WALLET_PUBLIC_KEY || '';
const TOKEN_UNIT = 10 ** SOLR_DECIMALS;
const API_BASE_URL = process.env.API_BASE_URL || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const GPU_TIERS = [
  { id: 0, name: 'RTX 4090', tokensPerMinute: 5, unitsPerMinute: String(5 * TOKEN_UNIT) },
  { id: 1, name: 'A100', tokensPerMinute: 7, unitsPerMinute: String(7 * TOKEN_UNIT) },
  { id: 2, name: 'H100', tokensPerMinute: 10, unitsPerMinute: String(10 * TOKEN_UNIT) },
];

const USER_VALIDATOR_DISC = crypto.createHash('sha256').update('account:UserValidator').digest().subarray(0, 8);
const USER_VALIDATOR_SIZE = 8 + 32 + 1 + 1 + 8 + 8 + 8 + 8 + 1;

function requiredConfigPresent() {
  return Boolean(RPC_URL && PROGRAM_ID && SOLR_MINT && REWARD_VAULT);
}

function connection() {
  if (!RPC_URL) throw new Error('SOLANA_RPC_URL is required');
  return new Connection(RPC_URL, 'confirmed');
}

function readI64LE(buf, offset) {
  return buf.readBigInt64LE(offset);
}

function readU64LE(buf, offset) {
  return buf.readBigUInt64LE(offset);
}

function decodeUserValidator(data) {
  if (data.length < USER_VALIDATOR_SIZE) return null;
  if (!data.subarray(0, 8).equals(USER_VALIDATOR_DISC)) return null;
  let o = 8;
  const user = new PublicKey(data.subarray(o, o + 32)).toBase58(); o += 32;
  const gpuTier = data.readUInt8(o); o += 1;
  const active = data.readUInt8(o) !== 0; o += 1;
  const startedAt = readI64LE(data, o); o += 8;
  const lastClaimAt = readI64LE(data, o); o += 8;
  const rewardRateUnitsPerMinute = readU64LE(data, o); o += 8;
  const totalClaimed = readU64LE(data, o); o += 8;
  const bump = data.readUInt8(o);
  return {
    user,
    gpuTier,
    active,
    startedAt: startedAt.toString(),
    lastClaimAt: lastClaimAt.toString(),
    rewardRateUnitsPerMinute: rewardRateUnitsPerMinute.toString(),
    totalClaimed: totalClaimed.toString(),
    bump,
  };
}

function tokensFromUnits(units) {
  return Number(units) / Math.pow(10, SOLR_DECIMALS);
}

function publicConfig() {
  if (CLUSTER !== 'mainnet-beta') {
    return { error: 'SOLANA_CLUSTER must be mainnet-beta', cluster: CLUSTER };
  }
  return {
    networkStartAtIso: new Date(Date.parse(NETWORK_START_AT_ISO)).toISOString(),
    solana: {
      cluster: 'mainnet-beta',
      rpcUrl: RPC_URL,
      programId: PROGRAM_ID,
      tokenMint: SOLR_MINT,
      rewardVault: REWARD_VAULT,
      tokenDecimals: SOLR_DECIMALS,
      adminWalletPublicKey: ADMIN_WALLET_PUBLIC_KEY,
    },
    apiBaseUrl: API_BASE_URL,
    gpuTiers: GPU_TIERS,
  };
}

async function globalStats() {
  if (CLUSTER !== 'mainnet-beta') throw new Error('SOLANA_CLUSTER must be mainnet-beta');
  if (!requiredConfigPresent()) {
    return {
      configured: false,
      activeValidators: 0,
      validatorsEverStarted: 0,
      totalClaimedUnits: '0',
      totalClaimedTokens: 0,
      rewardVaultBalanceUnits: '0',
      rewardVaultBalanceTokens: 0,
      rewardVaultNeedsFunding: true,
      solrMint: SOLR_MINT,
      programId: PROGRAM_ID,
      networkStartAtIso: new Date(Date.parse(NETWORK_START_AT_ISO)).toISOString(),
      recentActivity: [],
    };
  }

  const conn = connection();
  const programId = new PublicKey(PROGRAM_ID);
  const accounts = await conn.getProgramAccounts(programId, {
    filters: [
      { dataSize: USER_VALIDATOR_SIZE },
      { memcmp: { offset: 0, bytes: bs58Encode(USER_VALIDATOR_DISC) } },
    ],
  });

  let activeValidators = 0;
  let totalClaimed = 0n;
  const validators = [];
  for (const account of accounts) {
    const decoded = decodeUserValidator(account.account.data);
    if (!decoded) continue;
    validators.push(decoded);
    if (decoded.active) activeValidators += 1;
    totalClaimed += BigInt(decoded.totalClaimed);
  }

  let vaultUnits = '0';
  try {
    const bal = await conn.getTokenAccountBalance(new PublicKey(REWARD_VAULT));
    vaultUnits = bal.value.amount;
  } catch (_) {
    vaultUnits = '0';
  }

  const recentActivity = validators
    .filter(v => BigInt(v.lastClaimAt || '0') > 0n)
    .sort((a, b) => Number(BigInt(b.lastClaimAt) - BigInt(a.lastClaimAt)))
    .slice(0, 12)
    .map(v => ({
      wallet: v.user,
      gpuTier: v.gpuTier,
      active: v.active,
      lastClaimAt: v.lastClaimAt,
      totalClaimedUnits: v.totalClaimed,
      totalClaimedTokens: tokensFromUnits(v.totalClaimed),
    }));

  return {
    configured: true,
    activeValidators,
    validatorsEverStarted: validators.length,
    totalClaimedUnits: totalClaimed.toString(),
    totalClaimedTokens: tokensFromUnits(totalClaimed.toString()),
    rewardVaultBalanceUnits: vaultUnits,
    rewardVaultBalanceTokens: tokensFromUnits(vaultUnits),
    rewardVaultNeedsFunding: BigInt(vaultUnits || '0') === 0n,
    solrMint: SOLR_MINT,
    programId: PROGRAM_ID,
    networkStartAtIso: new Date(Date.parse(NETWORK_START_AT_ISO)).toISOString(),
    recentActivity,
  };
}

function bs58Encode(buf) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let x = BigInt('0x' + Buffer.from(buf).toString('hex'));
  let out = '';
  while (x > 0n) {
    const mod = x % 58n;
    out = alphabet[Number(mod)] + out;
    x /= 58n;
  }
  for (const byte of buf) {
    if (byte === 0) out = '1' + out;
    else break;
  }
  return out || '1';
}

app.get('/api/config', (_req, res) => {
  res.json(publicConfig());
});

app.get('/runtime-config.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`window.SOLARA_API_BASE_URL=${JSON.stringify(API_BASE_URL)};`);
});

app.get('/api/stats/global', async (_req, res) => {
  try {
    res.json(await globalStats());
  } catch (e) {
    res.status(500).json({
      configured: requiredConfigPresent(),
      error: String(e.message || e),
      activeValidators: 0,
      validatorsEverStarted: 0,
      totalClaimedUnits: '0',
      totalClaimedTokens: 0,
      rewardVaultBalanceUnits: '0',
      rewardVaultBalanceTokens: 0,
      rewardVaultNeedsFunding: true,
      solrMint: SOLR_MINT,
      programId: PROGRAM_ID,
      networkStartAtIso: NETWORK_START_AT_ISO,
      recentActivity: [],
    });
  }
});

app.get('/api/stats/activity', (_req, res) => {
  res.status(410).json({ error: 'activity endpoint removed; use /api/stats/global recentActivity from indexed program accounts' });
});

app.get(['/admin', '/admin/'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`SOLARA -> http://localhost:${PORT}`);
    console.log(`cluster: ${CLUSTER}`);
  });
}

module.exports = app;
