'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solara-ledger-smoke-'));
const dbPath = path.join(tmp, 'ledger.sqlite');
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = dbPath;
process.env.MIN_PAYOUT_AMOUNT = '10';
process.env.CLAIM_COOLDOWN_MINUTES = '0';
process.env.MAX_ACTIVE_SESSION_HOURS = '24';
process.env.ENABLE_AUTO_PAYOUTS = 'false';

const app = require('../server');

const UNIT = 1_000_000_000n;
const wallet = '11111111111111111111111111111111';
const wallet2 = 'So11111111111111111111111111111111111111112';

function assert(ok, message) {
  if (!ok) throw new Error(message);
}
async function main() {
  await app.ready;
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = new Database(dbPath);
  async function req(pathname, options = {}) {
    const res = await fetch(base + pathname, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const json = await res.json().catch(() => ({}));
    return { res, json };
  }

  try {
    let r = await req('/api/validate/start', { method: 'POST', body: JSON.stringify({ wallet, gpuTier: 'A100' }) });
    assert(r.res.ok, 'A100 start should succeed');
    db.prepare('UPDATE reward_balances SET last_accrued_at = ? WHERE wallet = ?').run(new Date(Date.now() - 60050).toISOString(), wallet);
    r = await req(`/api/user/${wallet}/rewards`);
    assert(r.res.ok, 'Rewards fetch should succeed');
    assert(r.json.pendingAmount === '7', `A100 should accrue exactly 7 SOLR after 60 seconds, got ${r.json.pendingAmount}`);

    db.prepare('UPDATE reward_balances SET pending_amount = ?, last_accrued_at = ? WHERE wallet = ?').run('0', new Date(Date.now() - 120050).toISOString(), wallet);
    r = await req(`/api/user/${wallet}/rewards`);
    assert(r.json.pendingAmount === '14', `A100 should accrue exactly 14 SOLR after 120 seconds, got ${r.json.pendingAmount}`);

    r = await req('/api/validate/stop', { method: 'POST', body: JSON.stringify({ wallet }) });
    assert(r.res.ok && r.json.rewards.active === false, 'Stop should make session inactive');
    const stoppedPending = r.json.rewards.pendingAmount;
    db.prepare('UPDATE reward_balances SET last_accrued_at = ? WHERE wallet = ?').run(new Date(Date.now() - 60050).toISOString(), wallet);
    r = await req(`/api/user/${wallet}/rewards`);
    assert(r.json.active === false, 'Stopped session must not auto-restart');
    assert(r.json.pendingAmount === stoppedPending, 'Stopped session must not keep accruing');

    db.prepare('UPDATE reward_balances SET pending_amount = ? WHERE wallet = ?').run((7n * UNIT).toString(), wallet);
    r = await req('/api/claim/request', { method: 'POST', body: JSON.stringify({ wallet }) });
    assert(!r.res.ok && /Minimum withdrawal is 10 SOLR/.test(r.json.error), 'Below-minimum withdrawal should return readable 10 SOLR error');

    db.prepare('UPDATE reward_balances SET pending_amount = ? WHERE wallet = ?').run((10n * UNIT).toString(), wallet);
    r = await req('/api/claim/request', { method: 'POST', body: JSON.stringify({ wallet }) });
    assert(r.res.ok && r.json.request.amount === '10', 'At-minimum withdrawal should create request');
    const payout = db.prepare('SELECT status, approved_at FROM payout_requests WHERE wallet = ? ORDER BY id DESC LIMIT 1').get(wallet);
    assert(payout.status === 'approved' && payout.approved_at, 'Eligible withdrawal should auto-approve');

    r = await req('/api/validate/start', { method: 'POST', body: JSON.stringify({ wallet, gpuTier: 'RTX 4090' }) });
    assert(r.res.ok, 'New session should start');
    r = await req('/api/validate/start', { method: 'POST', body: JSON.stringify({ wallet, gpuTier: 'H100' }) });
    assert(r.res.ok, 'Switching plan should start');
    const activeCount = db.prepare('SELECT COUNT(*) AS c FROM validation_sessions WHERE wallet = ? AND active = 1').get(wallet).c;
    assert(activeCount === 1, `Wallet should have one active session, got ${activeCount}`);
    const activeSession = db.prepare('SELECT gpu_tier, rate_per_minute FROM validation_sessions WHERE wallet = ? AND active = 1').get(wallet);
    assert(activeSession.gpu_tier === 'H100', `Active session should switch to H100, got ${activeSession.gpu_tier}`);
    assert(activeSession.rate_per_minute === (10n * UNIT).toString(), `H100 rate should be 10 SOLR/min, got ${activeSession.rate_per_minute}`);
    db.prepare('UPDATE reward_balances SET pending_amount = ?, last_accrued_at = ? WHERE wallet = ?').run('0', new Date(Date.now() - 60050).toISOString(), wallet);
    r = await req(`/api/user/${wallet}/rewards`);
    assert(r.json.pendingAmount === '10', `H100 should accrue exactly 10 SOLR after 60 seconds, got ${r.json.pendingAmount}`);

    db.prepare("INSERT INTO system_settings (key,value,updated_at) VALUES ('PAUSE_REWARDS','true',?) ON CONFLICT(key) DO UPDATE SET value='true', updated_at=?").run(new Date().toISOString(), new Date().toISOString());
    r = await req('/api/validate/start', { method: 'POST', body: JSON.stringify({ wallet: wallet2, gpuTier: 'H200' }) });
    assert(!r.res.ok && /paused/i.test(r.json.error), 'Pause should block new validation sessions');
    db.prepare("UPDATE system_settings SET value='false' WHERE key='PAUSE_REWARDS'").run();

    db.prepare('INSERT INTO wallet_blacklist (wallet, reason, created_at, created_by_admin) VALUES (?, ?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET reason = ?').run(wallet2, 'smoke', new Date().toISOString(), 'smoke', 'smoke');
    r = await req('/api/validate/start', { method: 'POST', body: JSON.stringify({ wallet: wallet2, gpuTier: 'H200' }) });
    assert(!r.res.ok && /blacklisted/i.test(r.json.error), 'Blacklist should block start');
    r = await req('/api/claim/request', { method: 'POST', body: JSON.stringify({ wallet: wallet2 }) });
    assert(!r.res.ok && /blacklisted/i.test(r.json.error), 'Blacklist should block withdrawals');

    console.log('SOLARA rewards smoke checks passed');
  } finally {
    db.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
