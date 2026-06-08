'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const nacl = require('tweetnacl');

let web3Promise;
let splTokenPromise;
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

const CLUSTER = process.env.SOLANA_CLUSTER || 'mainnet-beta';
const RPC_URL = process.env.SOLANA_RPC_URL || '';
const SOLR_MINT = process.env.SOLR_MINT || '';
const SOLR_DECIMALS = Number(process.env.SOLR_DECIMALS || 9);
const ADMIN_WALLET_PUBLIC_KEY = process.env.ADMIN_WALLET_PUBLIC_KEY || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const NETWORK_START_AT_ISO = process.env.NETWORK_START_AT_ISO || '2026-06-08T18:00:00.000Z';
const API_BASE_URL = process.env.API_BASE_URL || '';
const ENABLE_AUTO_PAYOUTS = String(process.env.ENABLE_AUTO_PAYOUTS || 'false').toLowerCase() === 'true';
const PAYOUT_INTERVAL_MINUTES = Math.max(1, Number(process.env.PAYOUT_INTERVAL_MINUTES || 30));
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const TOKEN_UNIT = 10n ** BigInt(SOLR_DECIMALS);
const DEFAULT_RATES = [
  { gpuTier: 'RTX 4090', ratePerMinute: 5 },
  { gpuTier: 'A100', ratePerMinute: 7 },
  { gpuTier: 'H100', ratePerMinute: 10 },
];

function dbPath() {
  let raw = process.env.DATABASE_URL || path.join(__dirname, 'data', 'solara-ledger.sqlite');
  if (raw.startsWith('sqlite://')) raw = raw.slice('sqlite://'.length);
  if (raw.startsWith('file:')) raw = raw.slice('file:'.length);
  if (!path.isAbsolute(raw)) raw = path.join(__dirname, raw);
  fs.mkdirSync(path.dirname(raw), { recursive: true });
  return raw;
}

const db = new Database(dbPath());
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  wallet TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS validation_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  gpu_tier TEXT NOT NULL,
  rate_per_minute TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS reward_balances (
  wallet TEXT PRIMARY KEY,
  pending_amount TEXT NOT NULL DEFAULT '0',
  paid_amount TEXT NOT NULL DEFAULT '0',
  last_accrued_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payout_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  approved_at TEXT,
  paid_at TEXT,
  tx_signature TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS payout_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  total_amount TEXT NOT NULL DEFAULT '0',
  tx_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS reward_rates (
  gpu_tier TEXT PRIMARY KEY,
  rate_per_minute TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_wallet_active ON validation_sessions(wallet, active);
CREATE INDEX IF NOT EXISTS idx_payout_status ON payout_requests(status);
`);

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
function rateUnits(tokensPerMinute) {
  return (unitsFromTokens(tokensPerMinute)).toString();
}
function normalizeTier(input) {
  const key = String(input || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (key === '0' || key === 'rtx4090' || key === '4090') return 'RTX 4090';
  if (key === '1' || key === 'a100') return 'A100';
  if (key === '2' || key === 'h100') return 'H100';
  throw new Error('Invalid GPU tier');
}
function seedRates() {
  const stmt = db.prepare('INSERT OR IGNORE INTO reward_rates (gpu_tier, rate_per_minute, updated_at) VALUES (?, ?, ?)');
  for (const r of DEFAULT_RATES) stmt.run(r.gpuTier, rateUnits(r.ratePerMinute), nowIso());
}
seedRates();
function getRateUnits(gpuTier) {
  const row = db.prepare('SELECT rate_per_minute FROM reward_rates WHERE gpu_tier = ?').get(gpuTier);
  if (!row) throw new Error('Reward rate is not configured for GPU tier');
  return row.rate_per_minute;
}
function getRates() {
  return db.prepare("SELECT gpu_tier AS gpuTier, rate_per_minute AS ratePerMinuteUnits FROM reward_rates ORDER BY CASE gpu_tier WHEN 'RTX 4090' THEN 0 WHEN 'A100' THEN 1 WHEN 'H100' THEN 2 ELSE 9 END").all()
    .map(r => ({ ...r, ratePerMinute: tokensFromUnits(r.ratePerMinuteUnits) }));
}
function ensureUser(wallet) {
  const ts = nowIso();
  db.prepare('INSERT INTO users (wallet, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET updated_at = excluded.updated_at').run(wallet, ts, ts);
  db.prepare('INSERT OR IGNORE INTO reward_balances (wallet, pending_amount, paid_amount, last_accrued_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(wallet, '0', '0', ts, ts);
}
async function validateWallet(wallet) {
  const { PublicKey } = await solanaWeb3();
  try {
    return new PublicKey(wallet).toBase58();
  } catch (_) {
    throw new Error('Invalid Solana wallet address');
  }
}
function activeSession(wallet) {
  return db.prepare('SELECT * FROM validation_sessions WHERE wallet = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(wallet);
}
function accrueWallet(wallet) {
  ensureUser(wallet);
  const session = activeSession(wallet);
  const bal = db.prepare('SELECT * FROM reward_balances WHERE wallet = ?').get(wallet);
  if (!session) return bal;
  const last = Date.parse(bal.last_accrued_at || session.started_at);
  const now = Date.now();
  if (!Number.isFinite(last) || now <= last) return bal;
  const elapsed = BigInt(now - last);
  const earned = BigInt(session.rate_per_minute) * elapsed / 60000n;
  const pending = BigInt(bal.pending_amount || '0') + earned;
  const ts = new Date(now).toISOString();
  db.prepare('UPDATE reward_balances SET pending_amount = ?, last_accrued_at = ?, updated_at = ? WHERE wallet = ?').run(pending.toString(), ts, ts, wallet);
  return db.prepare('SELECT * FROM reward_balances WHERE wallet = ?').get(wallet);
}
function accrueAllActive() {
  const rows = db.prepare('SELECT DISTINCT wallet FROM validation_sessions WHERE active = 1').all();
  for (const r of rows) accrueWallet(r.wallet);
}
function startSession(wallet, gpuTier) {
  return db.transaction(() => {
    accrueWallet(wallet);
    const ts = nowIso();
    const rate = getRateUnits(gpuTier);
    db.prepare('UPDATE validation_sessions SET active = 0, stopped_at = ? WHERE wallet = ? AND active = 1').run(ts, wallet);
    db.prepare('INSERT INTO validation_sessions (wallet, gpu_tier, rate_per_minute, started_at, active) VALUES (?, ?, ?, ?, 1)').run(wallet, gpuTier, rate, ts);
    db.prepare('UPDATE reward_balances SET last_accrued_at = ?, updated_at = ? WHERE wallet = ?').run(ts, ts, wallet);
  })();
}
function rewardsPayload(wallet) {
  const bal = accrueWallet(wallet);
  const session = activeSession(wallet);
  const history = db.prepare('SELECT id, amount, status, requested_at AS requestedAt, approved_at AS approvedAt, paid_at AS paidAt, tx_signature AS txSignature, error FROM payout_requests WHERE wallet = ? ORDER BY id DESC LIMIT 25').all(wallet)
    .map(r => ({ ...r, amountTokens: tokensFromUnits(r.amount) }));
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
    payoutRequests: history,
  };
}
function createClaimRequest(wallet, amountInput) {
  return db.transaction(() => {
    const bal = accrueWallet(wallet);
    const pending = BigInt(bal.pending_amount || '0');
    const amount = amountInput === undefined || amountInput === null || amountInput === '' ? pending : unitsFromTokens(amountInput);
    if (amount <= 0n) throw new Error('No pending rewards available to request');
    if (amount > pending) throw new Error('Requested amount exceeds pending rewards');
    const ts = nowIso();
    db.prepare('UPDATE reward_balances SET pending_amount = ?, updated_at = ? WHERE wallet = ?').run((pending - amount).toString(), ts, wallet);
    const info = db.prepare('INSERT INTO payout_requests (wallet, amount, status, requested_at) VALUES (?, ?, ?, ?)').run(wallet, amount.toString(), 'pending', ts);
    return { id: info.lastInsertRowid, amountUnits: amount.toString(), amount: tokensFromUnits(amount) };
  })();
}

function decodeBase64(s) {
  return Buffer.from(String(s || ''), 'base64');
}
async function verifyAdminSignature(req) {
  if (!ADMIN_WALLET_PUBLIC_KEY) return false;
  const wallet = req.headers['x-admin-wallet'];
  const message64 = req.headers['x-admin-message'];
  const signature64 = req.headers['x-admin-signature'];
  if (!wallet || wallet !== ADMIN_WALLET_PUBLIC_KEY || !message64 || !signature64) return false;
  const message = decodeBase64(message64);
  const text = message.toString('utf8');
  const tsMatch = text.match(/Timestamp:\s*(.+)$/m);
  if (!text.includes(`Wallet: ${wallet}`) || !tsMatch) return false;
  const ageMs = Math.abs(Date.now() - Date.parse(tsMatch[1]));
  if (!Number.isFinite(ageMs) || ageMs > 10 * 60 * 1000) return false;
  const { PublicKey } = await solanaWeb3();
  return nacl.sign.detached.verify(message, new Uint8Array(decodeBase64(signature64)), new PublicKey(wallet).toBytes());
}
async function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    if (ADMIN_API_KEY && auth === `Bearer ${ADMIN_API_KEY}`) return next();
    if (await verifyAdminSignature(req)) return next();
    res.status(401).json({ error: 'Admin authorization required' });
  } catch (e) {
    res.status(401).json({ error: String(e.message || e) });
  }
}

function loadRewardWalletSecret() {
  if (process.env.REWARD_WALLET_SECRET_JSON) return JSON.parse(process.env.REWARD_WALLET_SECRET_JSON);
  if (process.env.REWARD_WALLET_KEYPAIR_PATH) return JSON.parse(fs.readFileSync(process.env.REWARD_WALLET_KEYPAIR_PATH, 'utf8'));
  return null;
}
async function rewardWalletKeypair() {
  const secret = loadRewardWalletSecret();
  if (!secret) throw new Error('Reward wallet is not configured');
  const { Keypair } = await solanaWeb3();
  return Keypair.fromSecretKey(Uint8Array.from(secret));
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
async function processApprovedPayouts() {
  const rows = db.prepare('SELECT * FROM payout_requests WHERE status = ? ORDER BY id ASC').all('approved');
  const started = nowIso();
  const total = rows.reduce((a, r) => a + BigInt(r.amount), 0n);
  const batch = db.prepare('INSERT INTO payout_batches (status, total_amount, tx_count, created_at) VALUES (?, ?, ?, ?)').run('processing', total.toString(), 0, started);
  let paid = 0;
  for (const row of rows) {
    try {
      const sig = await payRequest(row);
      const ts = nowIso();
      db.prepare('UPDATE payout_requests SET status = ?, paid_at = ?, tx_signature = ?, error = NULL WHERE id = ?').run('paid', ts, sig, row.id);
      const bal = db.prepare('SELECT paid_amount FROM reward_balances WHERE wallet = ?').get(row.wallet);
      db.prepare('UPDATE reward_balances SET paid_amount = ?, updated_at = ? WHERE wallet = ?').run((BigInt(bal.paid_amount || '0') + BigInt(row.amount)).toString(), ts, row.wallet);
      paid += 1;
    } catch (e) {
      const ts = nowIso();
      db.prepare('UPDATE payout_requests SET status = ?, error = ? WHERE id = ?').run('failed', String(e.message || e), row.id);
      const bal = db.prepare('SELECT pending_amount FROM reward_balances WHERE wallet = ?').get(row.wallet);
      db.prepare('UPDATE reward_balances SET pending_amount = ?, updated_at = ? WHERE wallet = ?').run((BigInt(bal.pending_amount || '0') + BigInt(row.amount)).toString(), ts, row.wallet);
    }
  }
  const status = paid === rows.length ? 'completed' : paid > 0 ? 'partial' : 'failed';
  db.prepare('UPDATE payout_batches SET status = ?, tx_count = ?, completed_at = ? WHERE id = ?').run(status, paid, nowIso(), batch.lastInsertRowid);
  return { batchId: batch.lastInsertRowid, status, txCount: paid, requested: rows.length, totalAmount: tokensFromUnits(total) };
}

async function adminSummary() {
  accrueAllActive();
  const reward = await rewardWalletBalance();
  const pendingRows = db.prepare('SELECT pending_amount, paid_amount FROM reward_balances').all();
  const totalPending = pendingRows.reduce((a, r) => a + BigInt(r.pending_amount || '0'), 0n);
  const totalPaid = pendingRows.reduce((a, r) => a + BigInt(r.paid_amount || '0'), 0n);
  return {
    totalUsers: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    activeValidators: db.prepare('SELECT COUNT(*) AS c FROM validation_sessions WHERE active = 1').get().c,
    validatorsEverStarted: db.prepare('SELECT COUNT(*) AS c FROM validation_sessions').get().c,
    totalPendingRewards: tokensFromUnits(totalPending),
    totalPendingRewardsUnits: totalPending.toString(),
    totalPaidRewards: tokensFromUnits(totalPaid),
    totalPaidRewardsUnits: totalPaid.toString(),
    pendingPayoutRequestCount: db.prepare('SELECT COUNT(*) AS c FROM payout_requests WHERE status = ?').get('pending').c,
    approvedPayoutRequestCount: db.prepare('SELECT COUNT(*) AS c FROM payout_requests WHERE status = ?').get('approved').c,
    rewardWallet: reward,
    rates: getRates(),
    autoPayoutsEnabled: ENABLE_AUTO_PAYOUTS,
    payoutIntervalMinutes: PAYOUT_INTERVAL_MINUTES,
  };
}

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const xfproto = req.headers['x-forwarded-proto'];
  if (process.env.NODE_ENV === 'production' && xfproto && xfproto !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
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

function publicConfig() {
  return {
    mode: 'ledger-payout',
    networkStartAtIso: new Date(Date.parse(NETWORK_START_AT_ISO)).toISOString(),
    solana: { cluster: CLUSTER, rpcUrl: RPC_URL, tokenMint: SOLR_MINT, tokenDecimals: SOLR_DECIMALS, adminWalletPublicKey: ADMIN_WALLET_PUBLIC_KEY },
    apiBaseUrl: API_BASE_URL,
    gpuTiers: getRates(),
  };
}

app.get('/api/config', (_req, res) => res.json(publicConfig()));
app.get('/runtime-config.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`window.SOLARA_API_BASE_URL=${JSON.stringify(API_BASE_URL)};window.SOLARA_CONFIG=${JSON.stringify(publicConfig())};`);
});
app.post('/api/validate/start', async (req, res) => {
  try {
    const wallet = await validateWallet(req.body.wallet);
    const gpuTier = normalizeTier(req.body.gpuTier);
    startSession(wallet, gpuTier);
    res.json({ ok: true, rewards: rewardsPayload(wallet) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.get('/api/user/:wallet/rewards', async (req, res) => {
  try {
    const wallet = await validateWallet(req.params.wallet);
    res.json(rewardsPayload(wallet));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.post('/api/claim/request', async (req, res) => {
  try {
    const wallet = await validateWallet(req.body.wallet);
    const request = createClaimRequest(wallet, req.body.amount);
    res.json({ ok: true, request, rewards: rewardsPayload(wallet) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.get('/api/stats/global', async (_req, res) => {
  try {
    const s = await adminSummary();
    res.json({
      mode: 'ledger-payout',
      activeValidators: s.activeValidators,
      validatorsEverStarted: s.validatorsEverStarted,
      totalClaimedTokens: numberTokens(s.totalPaidRewardsUnits),
      totalClaimedUnits: s.totalPaidRewardsUnits,
      totalPendingRewards: s.totalPendingRewards,
      rewardWalletBalanceTokens: Number(s.rewardWallet.balance || 0),
      rewardWalletBalanceUnits: s.rewardWallet.balanceUnits,
      solrMint: SOLR_MINT,
      networkStartAtIso: NETWORK_START_AT_ISO,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get('/api/stats/activity', (_req, res) => {
  const rows = db.prepare('SELECT id, wallet, amount, status, requested_at AS requestedAt, approved_at AS approvedAt, paid_at AS paidAt, tx_signature AS txSignature, error FROM payout_requests ORDER BY id DESC LIMIT 30').all()
    .map(r => ({ ...r, amountTokens: tokensFromUnits(r.amount) }));
  res.json({ activity: rows });
});

app.get('/api/admin/summary', requireAdmin, async (_req, res) => res.json(await adminSummary()));
app.get('/api/admin/payouts', requireAdmin, (req, res) => {
  const status = req.query.status ? String(req.query.status) : 'pending';
  const rows = db.prepare('SELECT id, wallet, amount, status, requested_at AS requestedAt, approved_at AS approvedAt, paid_at AS paidAt, tx_signature AS txSignature, error FROM payout_requests WHERE status = ? ORDER BY id ASC').all(status)
    .map(r => ({ ...r, amountTokens: tokensFromUnits(r.amount) }));
  res.json({ payouts: rows });
});
app.post('/api/admin/payouts/:id/approve', requireAdmin, (req, res) => {
  db.prepare('UPDATE payout_requests SET status = ?, approved_at = ?, error = NULL WHERE id = ? AND status = ?').run('approved', nowIso(), req.params.id, 'pending');
  res.json({ ok: true });
});
app.post('/api/admin/payouts/:id/reject', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM payout_requests WHERE id = ? AND status IN (?, ?)').get(req.params.id, 'pending', 'approved');
  if (!row) return res.status(404).json({ error: 'Payout request not found or already finalized' });
  const ts = nowIso();
  const bal = db.prepare('SELECT pending_amount FROM reward_balances WHERE wallet = ?').get(row.wallet);
  db.prepare('UPDATE reward_balances SET pending_amount = ?, updated_at = ? WHERE wallet = ?').run((BigInt(bal.pending_amount || '0') + BigInt(row.amount)).toString(), ts, row.wallet);
  db.prepare('UPDATE payout_requests SET status = ?, error = ? WHERE id = ?').run('rejected', req.body.reason || null, row.id);
  res.json({ ok: true });
});
app.post('/api/admin/payouts/process-batch', requireAdmin, async (_req, res) => {
  try {
    res.json({ ok: true, result: await processApprovedPayouts() });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.post('/api/admin/rates', requireAdmin, (req, res) => {
  try {
    const updates = req.body.rates || req.body;
    const ts = nowIso();
    for (const name of ['RTX 4090', 'A100', 'H100']) {
      const raw = updates[name] ?? updates[name.replace(/\s+/g, '')] ?? updates[name.toLowerCase().replace(/\s+/g, '')];
      if (raw !== undefined) db.prepare('UPDATE reward_rates SET rate_per_minute = ?, updated_at = ? WHERE gpu_tier = ?').run(unitsFromTokens(raw).toString(), ts, name);
    }
    res.json({ ok: true, rates: getRates() });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.post('/api/admin/sessions/:wallet/stop', requireAdmin, async (req, res) => {
  try {
    const wallet = await validateWallet(req.params.wallet);
    accrueWallet(wallet);
    db.prepare('UPDATE validation_sessions SET active = 0, stopped_at = ? WHERE wallet = ? AND active = 1').run(nowIso(), wallet);
    res.json({ ok: true, rewards: rewardsPayload(wallet) });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.get(['/admin', '/admin/'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (ENABLE_AUTO_PAYOUTS) {
  setInterval(() => processApprovedPayouts().catch(e => console.error('auto payout failed:', e.message || e)), PAYOUT_INTERVAL_MINUTES * 60000);
}

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`SOLARA ledger API -> http://localhost:${PORT}`);
    console.log(`cluster: ${CLUSTER}`);
  });
}

module.exports = app;
module.exports.processApprovedPayouts = processApprovedPayouts;
