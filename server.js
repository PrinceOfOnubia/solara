'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const nacl = require('tweetnacl');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;

let web3Promise;
let splTokenPromise;
const usedAdminMessages = new Map();

function solanaWeb3() {
  if (!web3Promise) web3Promise = import('@solana/web3.js');
  return web3Promise;
}
function splToken() {
  if (!splTokenPromise) splTokenPromise = import('@solana/spl-token');
  return splTokenPromise;
}
function loadEnvFile(name) {
  try {
    const file = path.join(__dirname, name);
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
}
loadEnvFile('.env');

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const RAW_DATABASE_URL = process.env.DATABASE_URL || '';
const USE_POSTGRES = /^postgres(ql)?:\/\//i.test(RAW_DATABASE_URL);
if (IS_PROD && !USE_POSTGRES) {
  throw new Error('Production requires PostgreSQL DATABASE_URL. SQLite is local development only.');
}

const CLUSTER = process.env.SOLANA_CLUSTER || 'mainnet-beta';
const RPC_URL = process.env.SOLANA_RPC_URL || '';
const SOLR_MINT = process.env.SOLR_MINT || '';
const SOLR_DECIMALS = Number(process.env.SOLR_DECIMALS || 9);
const ADMIN_WALLET_PUBLIC_KEY = process.env.ADMIN_WALLET_PUBLIC_KEY || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const NETWORK_START_AT_ISO = process.env.NETWORK_START_AT_ISO || '2026-06-08T18:00:00.000Z';
const API_BASE_URL = process.env.API_BASE_URL || '';
const PAYOUT_INTERVAL_MINUTES = Math.max(1, Number(process.env.PAYOUT_INTERVAL_MINUTES || 30));
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const TOKEN_UNIT = 10n ** BigInt(SOLR_DECIMALS);
const DEFAULT_RATES = [
  { gpuTier: 'RTX 4080', ratePerMinute: 4 },
  { gpuTier: 'RTX 4090', ratePerMinute: 5 },
  { gpuTier: 'A100', ratePerMinute: 7 },
  { gpuTier: 'H100', ratePerMinute: 10 },
  { gpuTier: 'H200', ratePerMinute: 12 },
];
const DEFAULT_SETTINGS = {
  MIN_PAYOUT_AMOUNT: process.env.MIN_PAYOUT_AMOUNT || '10',
  CLAIM_COOLDOWN_MINUTES: process.env.CLAIM_COOLDOWN_MINUTES || '30',
  MAX_ACTIVE_SESSION_HOURS: process.env.MAX_ACTIVE_SESSION_HOURS || '24',
  ENABLE_AUTO_PAYOUTS: process.env.ENABLE_AUTO_PAYOUTS || 'false',
  PAUSE_REWARDS: process.env.PAUSE_REWARDS || 'false',
  ALLOW_PAYOUT_REQUESTS_WHEN_PAUSED: process.env.ALLOW_PAYOUT_REQUESTS_WHEN_PAUSED || 'false',
};

let sqlite;
let pgPool;
const txStorage = new AsyncLocalStorage();
let rewardWalletKeypairCache = null;
function sqlitePath() {
  let raw = RAW_DATABASE_URL || path.join(__dirname, 'data', 'solara-ledger.sqlite');
  if (raw.startsWith('sqlite://')) raw = raw.slice('sqlite://'.length);
  if (raw.startsWith('file:')) raw = raw.slice('file:'.length);
  if (!path.isAbsolute(raw)) raw = path.join(__dirname, raw);
  fs.mkdirSync(path.dirname(raw), { recursive: true });
  return raw;
}
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
async function all(sql, params = []) {
  if (USE_POSTGRES) return (await (txStorage.getStore() || pgPool).query(toPg(sql), params)).rows;
  return sqlite.prepare(sql).all(params);
}
async function get(sql, params = []) {
  if (USE_POSTGRES) return (await (txStorage.getStore() || pgPool).query(toPg(sql), params)).rows[0] || null;
  return sqlite.prepare(sql).get(params) || null;
}
async function run(sql, params = []) {
  if (USE_POSTGRES) return (txStorage.getStore() || pgPool).query(toPg(sql), params);
  return sqlite.prepare(sql).run(params);
}
async function insertId(sql, params = []) {
  if (USE_POSTGRES) {
    const rows = (await (txStorage.getStore() || pgPool).query(toPg(sql) + ' RETURNING id', params)).rows;
    return rows[0].id;
  }
  return sqlite.prepare(sql).run(params).lastInsertRowid;
}
async function withTx(fn) {
  if (!USE_POSTGRES) return fn();
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const result = await txStorage.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function nowIso() {
  return new Date().toISOString();
}
function unitsFromTokens(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Amount must be a positive number');
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(SOLR_DECIMALS)).slice(0, SOLR_DECIMALS);
  return BigInt(whole) * TOKEN_UNIT + BigInt(padded || '0');
}
function tokensFromUnits(units) {
  const n = BigInt(units || '0');
  const whole = n / TOKEN_UNIT;
  const frac = (n % TOKEN_UNIT).toString().padStart(SOLR_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
function numberTokens(units) {
  return Number(tokensFromUnits(units));
}
function normalizeTier(input) {
  const key = String(input || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (key === '0' || key === 'rtx4080' || key === '4080') return 'RTX 4080';
  if (key === '1' || key === 'rtx4090' || key === '4090') return 'RTX 4090';
  if (key === '2' || key === 'a100') return 'A100';
  if (key === '3' || key === 'h100') return 'H100';
  if (key === '4' || key === 'h200') return 'H200';
  throw new Error('Invalid GPU tier');
}
function boolVal(v) {
  return ['true', '1', 'yes', 'on'].includes(String(v || '').toLowerCase());
}
function minutesBetween(a, b) {
  return Math.max(0, Math.ceil((Date.parse(b) - Date.parse(a)) / 60000));
}
function mapSession(row) {
  if (!row) return null;
  return {
    ...row,
    gpu_tier: row.gpu_tier ?? row.gputier,
    rate_per_minute: row.rate_per_minute ?? row.rateperminute,
    started_at: row.started_at ?? row.startedat,
    stopped_at: row.stopped_at ?? row.stoppedat,
    active: row.active === true || row.active === 1,
  };
}
function mapBalance(row) {
  return row ? {
    wallet: row.wallet,
    pending_amount: row.pending_amount ?? row.pendingamount ?? '0',
    paid_amount: row.paid_amount ?? row.paidamount ?? '0',
    last_accrued_at: row.last_accrued_at ?? row.lastaccruedat,
    updated_at: row.updated_at ?? row.updatedat,
  } : null;
}

async function initDb() {
  if (USE_POSTGRES) {
    pgPool = new Pool({ connectionString: RAW_DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
    await pgPool.query('SELECT 1');
    await pgPool.query(`
CREATE TABLE IF NOT EXISTS users (wallet TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS validation_sessions (id BIGSERIAL PRIMARY KEY, wallet TEXT NOT NULL, gpu_tier TEXT NOT NULL, rate_per_minute TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL, stopped_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE IF NOT EXISTS reward_balances (wallet TEXT PRIMARY KEY, pending_amount TEXT NOT NULL DEFAULT '0', paid_amount TEXT NOT NULL DEFAULT '0', last_accrued_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS payout_requests (id BIGSERIAL PRIMARY KEY, wallet TEXT NOT NULL, amount TEXT NOT NULL, status TEXT NOT NULL, requested_at TIMESTAMPTZ NOT NULL, approved_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, tx_signature TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS payout_batches (id BIGSERIAL PRIMARY KEY, status TEXT NOT NULL, total_amount TEXT NOT NULL DEFAULT '0', tx_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS reward_rates (gpu_tier TEXT PRIMARY KEY, rate_per_minute TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS admin_audit_logs (id BIGSERIAL PRIMARY KEY, admin_wallet TEXT, action TEXT NOT NULL, details TEXT, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS wallet_blacklist (wallet TEXT PRIMARY KEY, reason TEXT, created_at TIMESTAMPTZ NOT NULL, created_by_admin TEXT);
CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL, updated_by_admin TEXT);
CREATE TABLE IF NOT EXISTS reward_accrual_events (id BIGSERIAL PRIMARY KEY, wallet TEXT NOT NULL, amount TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sessions_wallet_active ON validation_sessions(wallet, active);
CREATE INDEX IF NOT EXISTS idx_payout_status ON payout_requests(status);
CREATE INDEX IF NOT EXISTS idx_accrual_wallet_created ON reward_accrual_events(wallet, created_at);
`);
  } else {
    sqlite = new Database(sqlitePath());
    sqlite.pragma('journal_mode = WAL');
    sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (wallet TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS validation_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, gpu_tier TEXT NOT NULL, rate_per_minute TEXT NOT NULL, started_at TEXT NOT NULL, stopped_at TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS reward_balances (wallet TEXT PRIMARY KEY, pending_amount TEXT NOT NULL DEFAULT '0', paid_amount TEXT NOT NULL DEFAULT '0', last_accrued_at TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payout_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, amount TEXT NOT NULL, status TEXT NOT NULL, requested_at TEXT NOT NULL, approved_at TEXT, paid_at TEXT, tx_signature TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS payout_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, total_amount TEXT NOT NULL DEFAULT '0', tx_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, completed_at TEXT);
CREATE TABLE IF NOT EXISTS reward_rates (gpu_tier TEXT PRIMARY KEY, rate_per_minute TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_wallet TEXT, action TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wallet_blacklist (wallet TEXT PRIMARY KEY, reason TEXT, created_at TEXT NOT NULL, created_by_admin TEXT);
CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by_admin TEXT);
CREATE TABLE IF NOT EXISTS reward_accrual_events (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, amount TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sessions_wallet_active ON validation_sessions(wallet, active);
CREATE INDEX IF NOT EXISTS idx_payout_status ON payout_requests(status);
CREATE INDEX IF NOT EXISTS idx_accrual_wallet_created ON reward_accrual_events(wallet, created_at);
`);
  }
  await seedRates();
  await seedSettings();
}
async function seedRates() {
  for (const r of DEFAULT_RATES) {
    await run('INSERT INTO reward_rates (gpu_tier, rate_per_minute, updated_at) VALUES (?, ?, ?) ON CONFLICT(gpu_tier) DO NOTHING', [r.gpuTier, unitsFromTokens(r.ratePerMinute).toString(), nowIso()]);
  }
}
async function seedSettings() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (process.env[key] !== undefined) {
      await run('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?', [key, value, nowIso(), value, nowIso()]);
    } else {
      await run('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING', [key, value, nowIso()]);
    }
  }
}
async function setting(key) {
  const row = await get('SELECT value FROM system_settings WHERE key = ?', [key]);
  return row ? row.value : DEFAULT_SETTINGS[key];
}
async function settingsObject() {
  const rows = await all('SELECT key, value FROM system_settings ORDER BY key');
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}
async function audit(adminWallet, action, details = {}) {
  await run('INSERT INTO admin_audit_logs (admin_wallet, action, details, created_at) VALUES (?, ?, ?, ?)', [adminWallet || null, action, JSON.stringify(details), nowIso()]);
}
async function validateWallet(wallet) {
  const { PublicKey } = await solanaWeb3();
  try {
    return new PublicKey(wallet).toBase58();
  } catch (_) {
    throw new Error('Invalid Solana wallet address');
  }
}
async function isBlacklisted(wallet) {
  return Boolean(await get('SELECT wallet FROM wallet_blacklist WHERE wallet = ?', [wallet]));
}
async function requireNotBlacklisted(wallet) {
  if (await isBlacklisted(wallet)) throw new Error('Wallet is blacklisted.');
}
async function ensureUser(wallet) {
  const ts = nowIso();
  await run('INSERT INTO users (wallet, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET updated_at = ?', [wallet, ts, ts, ts]);
  await run('INSERT INTO reward_balances (wallet, pending_amount, paid_amount, last_accrued_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(wallet) DO NOTHING', [wallet, '0', '0', ts, ts]);
}
async function activeSession(wallet) {
  return mapSession(await get('SELECT * FROM validation_sessions WHERE wallet = ? AND active = ? ORDER BY id DESC LIMIT 1', [wallet, USE_POSTGRES ? true : 1]));
}
async function getRateUnits(gpuTier) {
  const row = await get('SELECT rate_per_minute FROM reward_rates WHERE gpu_tier = ?', [gpuTier]);
  if (!row) throw new Error('Reward rate is not configured for GPU tier');
  return row.rate_per_minute ?? row.rateperminute;
}
async function getRates() {
  const rows = await all("SELECT gpu_tier AS \"gpuTier\", rate_per_minute AS \"ratePerMinuteUnits\" FROM reward_rates ORDER BY CASE gpu_tier WHEN 'RTX 4080' THEN 0 WHEN 'RTX 4090' THEN 1 WHEN 'A100' THEN 2 WHEN 'H100' THEN 3 WHEN 'H200' THEN 4 ELSE 9 END");
  return rows.map(r => ({ gpuTier: r.gpuTier ?? r.gputier, ratePerMinuteUnits: r.ratePerMinuteUnits ?? r.rateperminuteunits, ratePerMinute: tokensFromUnits(r.ratePerMinuteUnits ?? r.rateperminuteunits) }));
}
async function dailyEarnedUnits(wallet, sinceIso) {
  const rows = await all('SELECT amount FROM reward_accrual_events WHERE wallet = ? AND created_at >= ?', [wallet, sinceIso]);
  return rows.reduce((sum, r) => sum + BigInt(r.amount || '0'), 0n);
}
async function closeExpiredSessions(wallet) {
  const session = await activeSession(wallet);
  if (!session) return;
  const maxHours = Number(await setting('MAX_ACTIVE_SESSION_HOURS'));
  if (maxHours <= 0) return;
  const expiresAt = Date.parse(session.started_at) + maxHours * 3600000;
  if (Date.now() >= expiresAt) {
    await run('UPDATE validation_sessions SET active = ?, stopped_at = ? WHERE id = ?', [USE_POSTGRES ? false : 0, new Date(expiresAt).toISOString(), session.id]);
  }
}
async function accrueWallet(wallet) {
  await ensureUser(wallet);
  await closeExpiredSessions(wallet);
  const session = await activeSession(wallet);
  const bal = mapBalance(await get('SELECT * FROM reward_balances WHERE wallet = ?', [wallet]));
  if (!session) return { balance: bal, dailyEarnedUnits: await dailyEarnedUnits(wallet, new Date(Date.now() - 86400000).toISOString()), capReached: false };
  const last = Date.parse(bal.last_accrued_at || session.started_at);
  const now = Date.now();
  const since = new Date(now - 86400000).toISOString();
  const already = await dailyEarnedUnits(wallet, since);
  if (!Number.isFinite(last) || now <= last) {
    return { balance: bal, dailyEarnedUnits: already, capReached: false };
  }
  const elapsedSeconds = BigInt(Math.floor((now - last) / 1000));
  if (elapsedSeconds <= 0n) {
    return { balance: bal, dailyEarnedUnits: already, capReached: false };
  }
  const earned = BigInt(session.rate_per_minute) * elapsedSeconds / 60n;
  const accruedThrough = last + Number(elapsedSeconds) * 1000;
  const ts = new Date(accruedThrough).toISOString();
  if (earned > 0n) {
    await run('INSERT INTO reward_accrual_events (wallet, amount, created_at) VALUES (?, ?, ?)', [wallet, earned.toString(), ts]);
    await run('UPDATE reward_balances SET pending_amount = ?, last_accrued_at = ?, updated_at = ? WHERE wallet = ?', [(BigInt(bal.pending_amount || '0') + earned).toString(), ts, ts, wallet]);
  }
  const updated = mapBalance(await get('SELECT * FROM reward_balances WHERE wallet = ?', [wallet]));
  return { balance: updated, dailyEarnedUnits: already + earned, capReached: false };
}
async function accrueAllActive() {
  const rows = await all('SELECT DISTINCT wallet FROM validation_sessions WHERE active = ?', [USE_POSTGRES ? true : 1]);
  for (const r of rows) await accrueWallet(r.wallet);
}
async function startSession(wallet, gpuTier) {
  if (boolVal(await setting('PAUSE_REWARDS'))) throw new Error('Rewards are paused. New validation sessions are disabled.');
  await requireNotBlacklisted(wallet);
  await withTx(async () => {
    await accrueWallet(wallet);
    const ts = nowIso();
    const rate = await getRateUnits(gpuTier);
    await run('UPDATE validation_sessions SET active = ?, stopped_at = ? WHERE wallet = ? AND active = ?', [USE_POSTGRES ? false : 0, ts, wallet, USE_POSTGRES ? true : 1]);
    await run('INSERT INTO validation_sessions (wallet, gpu_tier, rate_per_minute, started_at, active) VALUES (?, ?, ?, ?, ?)', [wallet, gpuTier, rate, ts, USE_POSTGRES ? true : 1]);
    await run('UPDATE reward_balances SET last_accrued_at = ?, updated_at = ? WHERE wallet = ?', [ts, ts, wallet]);
  });
}
async function stopSession(wallet) {
  await withTx(async () => {
    await accrueWallet(wallet);
    await run('UPDATE validation_sessions SET active = ?, stopped_at = ? WHERE wallet = ? AND active = ?', [USE_POSTGRES ? false : 0, nowIso(), wallet, USE_POSTGRES ? true : 1]);
  });
}
async function payoutHistory(wallet) {
  const rows = await all('SELECT id, amount, status, requested_at AS "requestedAt", approved_at AS "approvedAt", paid_at AS "paidAt", tx_signature AS "txSignature", error FROM payout_requests WHERE wallet = ? ORDER BY id DESC LIMIT 25', [wallet]);
  return rows.map(r => ({
    id: r.id,
    amount: r.amount,
    status: r.status,
    requestedAt: r.requestedAt ?? r.requestedat,
    approvedAt: r.approvedAt ?? r.approvedat,
    paidAt: r.paidAt ?? r.paidat,
    txSignature: r.txSignature ?? r.txsignature,
    error: r.error,
    amountTokens: tokensFromUnits(r.amount),
  }));
}
async function rewardsPayload(wallet) {
  const accrued = await accrueWallet(wallet);
  const bal = accrued.balance;
  const session = await activeSession(wallet);
  const settings = await settingsObject();
  const lastReq = await get('SELECT requested_at FROM payout_requests WHERE wallet = ? ORDER BY requested_at DESC LIMIT 1', [wallet]);
  const lastRequestedAt = lastReq ? (lastReq.requested_at ?? lastReq.requestedat) : null;
  const cooldownMinutes = Number(settings.CLAIM_COOLDOWN_MINUTES);
  const cooldownRemainingMinutes = lastRequestedAt ? Math.max(0, cooldownMinutes - minutesBetween(lastRequestedAt, nowIso())) : 0;
  const minPayoutUnits = unitsFromTokens(settings.MIN_PAYOUT_AMOUNT);
  const paused = boolVal(settings.PAUSE_REWARDS);
  const allowPaused = boolVal(settings.ALLOW_PAYOUT_REQUESTS_WHEN_PAUSED);
  const blacklisted = await isBlacklisted(wallet);
  return {
    wallet,
    gpuTier: session ? session.gpu_tier : null,
    active: Boolean(session),
    ratePerMinuteUnits: session ? session.rate_per_minute : '0',
    ratePerMinute: session ? tokensFromUnits(session.rate_per_minute) : '0',
    startedAt: session ? session.started_at : null,
    pendingAmountUnits: bal.pending_amount,
    pendingAmount: tokensFromUnits(bal.pending_amount),
    paidAmountUnits: bal.paid_amount,
    paidAmount: tokensFromUnits(bal.paid_amount),
    lastAccruedAt: bal.last_accrued_at,
    payoutRequests: await payoutHistory(wallet),
    minimumPayoutAmount: settings.MIN_PAYOUT_AMOUNT,
    cooldownRemainingMinutes,
    dailyEarnedUnits: accrued.dailyEarnedUnits.toString(),
    dailyEarned: tokensFromUnits(accrued.dailyEarnedUnits),
    capReached: false,
    paused,
    payoutRequestsDisabled: paused && !allowPaused,
    blacklisted,
    canRequestPayout: BigInt(bal.pending_amount || '0') >= minPayoutUnits && cooldownRemainingMinutes === 0 && !blacklisted && !(paused && !allowPaused),
  };
}
async function createClaimRequest(wallet, amountInput) {
  await requireNotBlacklisted(wallet);
  const settings = await settingsObject();
  if (boolVal(settings.PAUSE_REWARDS) && !boolVal(settings.ALLOW_PAYOUT_REQUESTS_WHEN_PAUSED)) {
    throw new Error('Payout requests are paused.');
  }
  return withTx(async () => {
    const accrued = await accrueWallet(wallet);
    const bal = accrued.balance;
    const pending = BigInt(bal.pending_amount || '0');
    const amount = amountInput === undefined || amountInput === null || amountInput === '' ? pending : unitsFromTokens(amountInput);
    const min = unitsFromTokens(settings.MIN_PAYOUT_AMOUNT);
    if (amount <= 0n) throw new Error('No pending rewards available to request');
    if (amount > pending) throw new Error('Requested amount exceeds pending rewards');
    if (amount < min) throw new Error(`Minimum payout is ${settings.MIN_PAYOUT_AMOUNT} SOLR. Keep validating to reach the payout threshold.`);
    const openReq = await get('SELECT id, status FROM payout_requests WHERE wallet = ? AND status IN (?, ?) ORDER BY requested_at DESC LIMIT 1', [wallet, 'pending', 'approved']);
    if (openReq) throw new Error('You already have a payout request pending approval.');
    const lastReq = await get('SELECT requested_at FROM payout_requests WHERE wallet = ? ORDER BY requested_at DESC LIMIT 1', [wallet]);
    if (lastReq) {
      const requestedAt = lastReq.requested_at ?? lastReq.requestedat;
      const elapsed = minutesBetween(requestedAt, nowIso());
      const cooldown = Number(settings.CLAIM_COOLDOWN_MINUTES);
      if (elapsed < cooldown) throw new Error(`Please wait ${cooldown - elapsed} minutes before requesting another payout.`);
    }
    const ts = nowIso();
    await run('UPDATE reward_balances SET pending_amount = ?, updated_at = ? WHERE wallet = ?', [(pending - amount).toString(), ts, wallet]);
    const id = await insertId('INSERT INTO payout_requests (wallet, amount, status, requested_at, approved_at) VALUES (?, ?, ?, ?, ?)', [wallet, amount.toString(), 'approved', ts, ts]);
    return { id, amountUnits: amount.toString(), amount: tokensFromUnits(amount) };
  });
}

function decodeBase64(s) {
  return Buffer.from(String(s || ''), 'base64');
}
async function verifyAdminSignature(req) {
  if (!ADMIN_WALLET_PUBLIC_KEY) return null;
  const wallet = req.headers['x-admin-wallet'];
  const message64 = req.headers['x-admin-message'];
  const signature64 = req.headers['x-admin-signature'];
  if (!wallet || wallet !== ADMIN_WALLET_PUBLIC_KEY || !message64 || !signature64) return null;
  const message = decodeBase64(message64);
  const key = `${wallet}:${message64}:${signature64}`;
  const now = Date.now();
  for (const [k, exp] of usedAdminMessages) if (exp <= now) usedAdminMessages.delete(k);
  if (usedAdminMessages.has(key)) throw new Error('Admin signature replay rejected');
  const text = message.toString('utf8');
  const tsMatch = text.match(/Timestamp:\s*(.+)$/m);
  const nonceMatch = text.match(/Nonce:\s*([A-Za-z0-9._:-]+)/m);
  if (!text.includes(`Wallet: ${wallet}`) || !tsMatch || !nonceMatch) return null;
  const ageMs = Math.abs(now - Date.parse(tsMatch[1]));
  if (!Number.isFinite(ageMs) || ageMs > 5 * 60 * 1000) return null;
  const { PublicKey } = await solanaWeb3();
  const ok = nacl.sign.detached.verify(message, new Uint8Array(decodeBase64(signature64)), new PublicKey(wallet).toBytes());
  if (!ok) return null;
  usedAdminMessages.set(key, now + 5 * 60 * 1000);
  return wallet;
}
async function requireAdmin(req, res, next) {
  try {
    const wallet = await verifyAdminSignature(req);
    if (wallet) {
      req.adminWallet = wallet;
      return next();
    }
    res.status(401).json({ error: 'Admin authorization required' });
  } catch (e) {
    res.status(401).json({ error: String(e.message || e) });
  }
}

function rewardWalletPrivateKey() {
  return String(process.env.REWARD_WALLET_PRIVATE_KEY || '').trim();
}
function decodeRewardWalletSecretKey() {
  const key = rewardWalletPrivateKey();
  if (!key) return null;
  try {
    return bs58.decode(key);
  } catch (_) {
    throw new Error('REWARD_WALLET_PRIVATE_KEY must be a valid Solana Base58 private key string.');
  }
}
async function validateRewardWalletConfig() {
  const secretKey = decodeRewardWalletSecretKey();
  if (!secretKey) {
    console.warn('Reward wallet private key not configured. Payout processing disabled.');
    return;
  }
  const { Keypair } = await solanaWeb3();
  try {
    rewardWalletKeypairCache = Keypair.fromSecretKey(secretKey);
  } catch (_) {
    throw new Error('REWARD_WALLET_PRIVATE_KEY decoded but is not a valid Solana secret key.');
  }
}
async function rewardWalletKeypair() {
  if (rewardWalletKeypairCache) return rewardWalletKeypairCache;
  const secretKey = decodeRewardWalletSecretKey();
  if (!secretKey) throw new Error('Reward wallet private key not configured. Payout processing disabled.');
  const { Keypair } = await solanaWeb3();
  rewardWalletKeypairCache = Keypair.fromSecretKey(secretKey);
  return rewardWalletKeypairCache;
}
async function connection() {
  if (!RPC_URL) throw new Error('SOLANA_RPC_URL is required');
  const { Connection } = await solanaWeb3();
  return new Connection(RPC_URL, 'confirmed');
}
async function rewardWalletBalance() {
  try {
    if (!RPC_URL || !SOLR_MINT) return { configured: false, balanceUnits: '0', balance: '0' };
    const kp = await rewardWalletKeypair();
    const conn = await connection();
    const { PublicKey } = await solanaWeb3();
    const { getAssociatedTokenAddress } = await splToken();
    const ata = await getAssociatedTokenAddress(new PublicKey(SOLR_MINT), kp.publicKey);
    const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
    const amount = bal ? bal.value.amount : '0';
    return { configured: true, rewardWallet: kp.publicKey.toBase58(), tokenAccount: ata.toBase58(), balanceUnits: amount, balance: tokensFromUnits(amount) };
  } catch (e) {
    return { configured: false, balanceUnits: '0', balance: '0', error: String(e.message || e) };
  }
}
async function payRequest(row) {
  if (!RPC_URL || !SOLR_MINT) throw new Error('SOLANA_RPC_URL and SOLR_MINT are required');
  const conn = await connection();
  const { PublicKey } = await solanaWeb3();
  const { getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, transfer } = await splToken();
  const payer = await rewardWalletKeypair();
  const mint = new PublicKey(SOLR_MINT);
  const destinationOwner = new PublicKey(row.wallet);
  const sourceAta = await getAssociatedTokenAddress(mint, payer.publicKey);
  await getOrCreateAssociatedTokenAccount(conn, payer, mint, destinationOwner);
  const destinationAta = await getAssociatedTokenAddress(mint, destinationOwner);
  return transfer(conn, payer, sourceAta, destinationAta, payer.publicKey, BigInt(row.amount));
}
async function processApprovedPayouts(adminWallet = 'system') {
  const rows = await all('SELECT * FROM payout_requests WHERE status = ? ORDER BY id ASC', ['approved']);
  const started = nowIso();
  const total = rows.reduce((a, r) => a + BigInt(r.amount), 0n);
  const batchId = await insertId('INSERT INTO payout_batches (status, total_amount, tx_count, created_at) VALUES (?, ?, ?, ?)', ['processing', total.toString(), 0, started]);
  let paid = 0;
  for (const row of rows) {
    try {
      const sig = await payRequest(row);
      const ts = nowIso();
      await run('UPDATE payout_requests SET status = ?, paid_at = ?, tx_signature = ?, error = NULL WHERE id = ?', ['paid', ts, sig, row.id]);
      const bal = mapBalance(await get('SELECT paid_amount FROM reward_balances WHERE wallet = ?', [row.wallet]));
      await run('UPDATE reward_balances SET paid_amount = ?, updated_at = ? WHERE wallet = ?', [(BigInt(bal.paid_amount || '0') + BigInt(row.amount)).toString(), ts, row.wallet]);
      paid += 1;
    } catch (e) {
      const ts = nowIso();
      await run('UPDATE payout_requests SET status = ?, error = ? WHERE id = ?', ['failed', String(e.message || e), row.id]);
      const bal = mapBalance(await get('SELECT pending_amount FROM reward_balances WHERE wallet = ?', [row.wallet]));
      await run('UPDATE reward_balances SET pending_amount = ?, updated_at = ? WHERE wallet = ?', [(BigInt(bal.pending_amount || '0') + BigInt(row.amount)).toString(), ts, row.wallet]);
    }
  }
  const status = paid === rows.length ? 'completed' : paid > 0 ? 'partial' : 'failed';
  await run('UPDATE payout_batches SET status = ?, tx_count = ?, completed_at = ? WHERE id = ?', [status, paid, nowIso(), batchId]);
  await audit(adminWallet, 'process payout', { batchId, status, txCount: paid, requested: rows.length, totalAmount: tokensFromUnits(total) });
  return { batchId, status, txCount: paid, requested: rows.length, totalAmount: tokensFromUnits(total) };
}
async function adminSummary() {
  await accrueAllActive();
  const reward = await rewardWalletBalance();
  const pendingRows = await all('SELECT pending_amount, paid_amount FROM reward_balances');
  const totalPending = pendingRows.reduce((a, r) => a + BigInt(r.pending_amount || '0'), 0n);
  const totalPaid = pendingRows.reduce((a, r) => a + BigInt(r.paid_amount || '0'), 0n);
  const settings = await settingsObject();
  return {
    totalUsers: Number((await get('SELECT COUNT(*) AS c FROM users')).c),
    activeValidators: Number((await get('SELECT COUNT(*) AS c FROM validation_sessions WHERE active = ?', [USE_POSTGRES ? true : 1])).c),
    validatorsEverStarted: Number((await get('SELECT COUNT(*) AS c FROM validation_sessions')).c),
    totalPendingRewards: tokensFromUnits(totalPending),
    totalPendingRewardsUnits: totalPending.toString(),
    totalPaidRewards: tokensFromUnits(totalPaid),
    totalPaidRewardsUnits: totalPaid.toString(),
    pendingPayoutRequestCount: Number((await get('SELECT COUNT(*) AS c FROM payout_requests WHERE status = ?', ['pending'])).c),
    approvedPayoutRequestCount: Number((await get('SELECT COUNT(*) AS c FROM payout_requests WHERE status = ?', ['approved'])).c),
    rewardWallet: reward,
    rates: await getRates(),
    settings,
    paused: boolVal(settings.PAUSE_REWARDS),
    autoPayoutsEnabled: boolVal(settings.ENABLE_AUTO_PAYOUTS),
    payoutIntervalMinutes: PAYOUT_INTERVAL_MINUTES,
  };
}

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const xfproto = req.headers['x-forwarded-proto'];
  if (IS_PROD && xfproto && xfproto !== 'https') return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  next();
});
app.use(express.json({ limit: '512kb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const localDev = !ALLOWED_ORIGINS.length && origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (origin && (ALLOWED_ORIGINS.includes(origin) || localDev)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Wallet,X-Admin-Message,X-Admin-Signature');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

async function publicConfig() {
  const settings = await settingsObject();
  return {
    mode: 'gpu-rewards',
    database: USE_POSTGRES ? 'postgres' : 'sqlite-local',
    networkStartAtIso: new Date(Date.parse(NETWORK_START_AT_ISO)).toISOString(),
    solana: { cluster: CLUSTER, rpcUrl: RPC_URL, tokenMint: SOLR_MINT, tokenDecimals: SOLR_DECIMALS, adminWalletPublicKey: ADMIN_WALLET_PUBLIC_KEY },
    apiBaseUrl: API_BASE_URL,
    gpuTiers: await getRates(),
    settings: {
      minPayoutAmount: settings.MIN_PAYOUT_AMOUNT,
      claimCooldownMinutes: settings.CLAIM_COOLDOWN_MINUTES,
      maxActiveSessionHours: settings.MAX_ACTIVE_SESSION_HOURS,
      paused: boolVal(settings.PAUSE_REWARDS),
      payoutRequestsDisabled: boolVal(settings.PAUSE_REWARDS) && !boolVal(settings.ALLOW_PAYOUT_REQUESTS_WHEN_PAUSED),
    },
  };
}

app.get('/api/config', async (_req, res) => res.json(await publicConfig()));
app.get('/runtime-config.js', async (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`window.SOLARA_API_BASE_URL=${JSON.stringify(API_BASE_URL)};window.SOLARA_CONFIG=${JSON.stringify(await publicConfig())};`);
});
app.post('/api/validate/start', async (req, res) => {
  try {
    const wallet = await validateWallet(req.body.wallet);
    const gpuTier = normalizeTier(req.body.gpuTier);
    await startSession(wallet, gpuTier);
    res.json({ ok: true, rewards: await rewardsPayload(wallet) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.post('/api/validate/stop', async (req, res) => {
  try {
    const wallet = await validateWallet(req.body.wallet);
    await stopSession(wallet);
    res.json({ ok: true, rewards: await rewardsPayload(wallet) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.get('/api/user/:wallet/rewards', async (req, res) => {
  try {
    const wallet = await validateWallet(req.params.wallet);
    res.json(await rewardsPayload(wallet));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.post('/api/claim/request', async (req, res) => {
  try {
    const wallet = await validateWallet(req.body.wallet);
    const request = await createClaimRequest(wallet, req.body.amount);
    res.json({ ok: true, request, rewards: await rewardsPayload(wallet) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.get('/api/stats/global', async (_req, res) => {
  try {
    const s = await adminSummary();
    res.json({
      mode: 'gpu-rewards',
      activeValidators: s.activeValidators,
      validatorsEverStarted: s.validatorsEverStarted,
      totalClaimedTokens: numberTokens(s.totalPaidRewardsUnits),
      totalClaimedUnits: s.totalPaidRewardsUnits,
      totalPendingRewards: s.totalPendingRewards,
      rewardWalletBalanceTokens: Number(s.rewardWallet.balance || 0),
      rewardWalletBalanceUnits: s.rewardWallet.balanceUnits,
      solrMint: SOLR_MINT,
      networkStartAtIso: NETWORK_START_AT_ISO,
      paused: s.paused,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get('/api/stats/activity', async (_req, res) => {
  const rows = await all('SELECT id, wallet, amount, status, requested_at AS "requestedAt", approved_at AS "approvedAt", paid_at AS "paidAt", tx_signature AS "txSignature", error FROM payout_requests ORDER BY id DESC LIMIT 30');
  res.json({ activity: rows.map(r => ({ ...r, requestedAt: r.requestedAt ?? r.requestedat, amountTokens: tokensFromUnits(r.amount) })) });
});

app.get('/api/admin/summary', requireAdmin, async (_req, res) => res.json(await adminSummary()));
app.get('/api/admin/settings', requireAdmin, async (_req, res) => res.json({ settings: await settingsObject() }));
app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  const allowed = ['MIN_PAYOUT_AMOUNT', 'CLAIM_COOLDOWN_MINUTES', 'MAX_ACTIVE_SESSION_HOURS', 'ENABLE_AUTO_PAYOUTS', 'ALLOW_PAYOUT_REQUESTS_WHEN_PAUSED'];
  const updates = req.body.settings || req.body;
  const ts = nowIso();
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      await run('INSERT INTO system_settings (key, value, updated_at, updated_by_admin) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?, updated_by_admin = ?', [key, String(updates[key]), ts, req.adminWallet, String(updates[key]), ts, req.adminWallet]);
    }
  }
  await audit(req.adminWallet, 'update system settings', updates);
  res.json({ ok: true, settings: await settingsObject() });
});
app.post('/api/admin/pause', requireAdmin, async (req, res) => {
  const ts = nowIso();
  await run('INSERT INTO system_settings (key, value, updated_at, updated_by_admin) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?, updated_by_admin = ?', ['PAUSE_REWARDS', 'true', ts, req.adminWallet, 'true', ts, req.adminWallet]);
  await audit(req.adminWallet, 'pause', {});
  res.json({ ok: true, settings: await settingsObject() });
});
app.post('/api/admin/resume', requireAdmin, async (req, res) => {
  const ts = nowIso();
  await run('INSERT INTO system_settings (key, value, updated_at, updated_by_admin) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?, updated_by_admin = ?', ['PAUSE_REWARDS', 'false', ts, req.adminWallet, 'false', ts, req.adminWallet]);
  await audit(req.adminWallet, 'resume', {});
  res.json({ ok: true, settings: await settingsObject() });
});
app.get('/api/admin/payouts', requireAdmin, async (req, res) => {
  const status = req.query.status ? String(req.query.status) : 'pending';
  const rows = await all('SELECT id, wallet, amount, status, requested_at AS "requestedAt", approved_at AS "approvedAt", paid_at AS "paidAt", tx_signature AS "txSignature", error FROM payout_requests WHERE status = ? ORDER BY id ASC', [status]);
  res.json({ payouts: rows.map(r => ({ ...r, requestedAt: r.requestedAt ?? r.requestedat, amountTokens: tokensFromUnits(r.amount) })) });
});
app.post('/api/admin/payouts/:id/approve', requireAdmin, async (req, res) => {
  await run('UPDATE payout_requests SET status = ?, approved_at = ?, error = NULL WHERE id = ? AND status = ?', ['approved', nowIso(), req.params.id, 'pending']);
  await audit(req.adminWallet, 'approve payout', { id: req.params.id });
  res.json({ ok: true });
});
app.post('/api/admin/payouts/:id/reject', requireAdmin, async (req, res) => {
  const row = await get('SELECT * FROM payout_requests WHERE id = ? AND status IN (?, ?)', [req.params.id, 'pending', 'approved']);
  if (!row) return res.status(404).json({ error: 'Payout request not found or already finalized' });
  const ts = nowIso();
  const bal = mapBalance(await get('SELECT pending_amount FROM reward_balances WHERE wallet = ?', [row.wallet]));
  await run('UPDATE reward_balances SET pending_amount = ?, updated_at = ? WHERE wallet = ?', [(BigInt(bal.pending_amount || '0') + BigInt(row.amount)).toString(), ts, row.wallet]);
  await run('UPDATE payout_requests SET status = ?, error = ? WHERE id = ?', ['rejected', req.body.reason || null, row.id]);
  await audit(req.adminWallet, 'reject payout', { id: row.id, wallet: row.wallet, amount: row.amount, reason: req.body.reason || null });
  res.json({ ok: true });
});
app.post('/api/admin/payouts/process-batch', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, result: await processApprovedPayouts(req.adminWallet) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.post('/api/admin/rates', requireAdmin, async (req, res) => {
  try {
    const updates = req.body.rates || req.body;
    const ts = nowIso();
    for (const name of DEFAULT_RATES.map(r => r.gpuTier)) {
      const raw = updates[name] ?? updates[name.replace(/\s+/g, '')] ?? updates[name.toLowerCase().replace(/\s+/g, '')];
      if (raw !== undefined) await run('INSERT INTO reward_rates (gpu_tier, rate_per_minute, updated_at) VALUES (?, ?, ?) ON CONFLICT(gpu_tier) DO UPDATE SET rate_per_minute = ?, updated_at = ?', [name, unitsFromTokens(raw).toString(), ts, unitsFromTokens(raw).toString(), ts]);
    }
    await audit(req.adminWallet, 'update rates', updates);
    res.json({ ok: true, rates: await getRates() });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.post('/api/admin/sessions/:wallet/stop', requireAdmin, async (req, res) => {
  try {
    const wallet = await validateWallet(req.params.wallet);
    await stopSession(wallet);
    await audit(req.adminWallet, 'stop session', { wallet });
    res.json({ ok: true, rewards: await rewardsPayload(wallet) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.post('/api/admin/blacklist', requireAdmin, async (req, res) => {
  try {
    const wallet = await validateWallet(req.body.wallet);
    await run('INSERT INTO wallet_blacklist (wallet, reason, created_at, created_by_admin) VALUES (?, ?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET reason = ?, created_by_admin = ?', [wallet, req.body.reason || '', nowIso(), req.adminWallet, req.body.reason || '', req.adminWallet]);
    await run('UPDATE validation_sessions SET active = ?, stopped_at = ? WHERE wallet = ? AND active = ?', [USE_POSTGRES ? false : 0, nowIso(), wallet, USE_POSTGRES ? true : 1]);
    await audit(req.adminWallet, 'blacklist wallet', { wallet, reason: req.body.reason || '' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.post('/api/admin/unblacklist', requireAdmin, async (req, res) => {
  const wallet = await validateWallet(req.body.wallet);
  await run('DELETE FROM wallet_blacklist WHERE wallet = ?', [wallet]);
  await audit(req.adminWallet, 'unblacklist wallet', { wallet });
  res.json({ ok: true });
});
app.get('/api/admin/blacklist', requireAdmin, async (_req, res) => {
  res.json({ blacklist: await all('SELECT wallet, reason, created_at AS "createdAt", created_by_admin AS "createdByAdmin" FROM wallet_blacklist ORDER BY created_at DESC') });
});
app.get('/api/admin/audit-logs', requireAdmin, async (_req, res) => {
  const rows = await all('SELECT id, admin_wallet AS "adminWallet", action, details, created_at AS "createdAt" FROM admin_audit_logs ORDER BY id DESC LIMIT 50');
  res.json({ logs: rows.map(r => ({ ...r, adminWallet: r.adminWallet ?? r.adminwallet, createdAt: r.createdAt ?? r.createdat, details: (() => { try { return JSON.parse(r.details || '{}'); } catch (_) { return {}; } })() })) });
});

app.get(['/admin', '/admin/'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let autoTimer;
async function maybeStartAutoPayouts() {
  const settings = await settingsObject();
  if (boolVal(settings.ENABLE_AUTO_PAYOUTS)) {
    if (!rewardWalletPrivateKey()) {
      console.warn('Reward wallet private key not configured. Auto payout scheduler disabled.');
      return;
    }
    autoTimer = setInterval(() => processApprovedPayouts('auto').catch(e => console.error('auto payout failed:', e.message || e)), PAYOUT_INTERVAL_MINUTES * 60000);
  }
}

const ready = initDb().then(validateRewardWalletConfig).then(maybeStartAutoPayouts);
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  ready.then(() => {
    app.listen(PORT, () => {
      console.log(`SOLARA rewards API -> http://localhost:${PORT}`);
      console.log(`database: ${USE_POSTGRES ? 'postgres' : 'sqlite-local'}`);
      console.log(`cluster: ${CLUSTER}`);
    });
  }).catch(e => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = app;
module.exports.ready = ready;
module.exports.processApprovedPayouts = processApprovedPayouts;
module.exports._internals = { initDb, settingsObject, USE_POSTGRES, autoTimer };
