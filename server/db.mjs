// SQLite（Node 22.5+ 自带 node:sqlite，不用编译原生模块）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CFG } from './config.mjs';

mkdirSync(dirname(CFG.dbPath), { recursive: true });
export const db = new DatabaseSync(CFG.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (wallet TEXT PRIMARY KEY, created_at INTEGER, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS sessions (
  wallet TEXT PRIMARY KEY, address TEXT, enc_priv TEXT, expiry INTEGER, state TEXT, intent_id TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS strategies (
  wallet TEXT PRIMARY KEY, status TEXT, params TEXT, budget_usd REAL, spent_usd REAL DEFAULT 0, paper REAL DEFAULT 0,
  rounds INTEGER DEFAULT 0, period_id TEXT, started_at INTEGER, updated_at INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS fee_accounts (
  wallet TEXT PRIMARY KEY, balance REAL DEFAULT 0, prepaid_total REAL DEFAULT 0, charged_total REAL DEFAULT 0,
  period_id TEXT, period_loss REAL DEFAULT 0, period_charged REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS fee_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, kind TEXT, amount REAL, tx_hash TEXT UNIQUE, period_id TEXT, note TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, market TEXT, position_ids TEXT, cost_usd REAL, paper REAL, fee_usd REAL, detail TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, level TEXT, kind TEXT, msg TEXT, data TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS nonces (k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX IF NOT EXISTS events_wallet ON events(wallet, id);
CREATE INDEX IF NOT EXISTS rounds_wallet ON rounds(wallet, id);
CREATE INDEX IF NOT EXISTS fee_ledger_wallet ON fee_ledger(wallet, id);
`);

const now = () => Date.now();
const stmt = (sql) => db.prepare(sql);
const S = {
  userGet: stmt('SELECT * FROM users WHERE wallet = ?'),
  userUpsert: stmt('INSERT INTO users (wallet, created_at, last_seen) VALUES (?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET last_seen = excluded.last_seen'),
  sessGet: stmt('SELECT * FROM sessions WHERE wallet = ?'),
  sessPut: stmt(`INSERT INTO sessions (wallet, address, enc_priv, expiry, state, intent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET address = excluded.address, enc_priv = excluded.enc_priv, expiry = excluded.expiry, state = excluded.state, intent_id = excluded.intent_id, created_at = excluded.created_at`),
  sessState: stmt('UPDATE sessions SET state = ? WHERE wallet = ?'),
  stratGet: stmt('SELECT * FROM strategies WHERE wallet = ?'),
  stratAll: stmt('SELECT * FROM strategies'),
  stratPut: stmt(`INSERT INTO strategies (wallet, status, params, budget_usd, spent_usd, paper, rounds, period_id, started_at, updated_at, note)
    VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, NULL)
    ON CONFLICT(wallet) DO UPDATE SET status = excluded.status, params = excluded.params, budget_usd = excluded.budget_usd,
      spent_usd = 0, paper = 0, rounds = 0, period_id = excluded.period_id, started_at = excluded.started_at, updated_at = excluded.updated_at, note = NULL`),
  stratStatus: stmt('UPDATE strategies SET status = ?, note = ?, updated_at = ? WHERE wallet = ?'),
  stratParams: stmt('UPDATE strategies SET params = ?, budget_usd = ?, updated_at = ? WHERE wallet = ?'),
  stratRound: stmt('UPDATE strategies SET spent_usd = spent_usd + ?, paper = paper + ?, rounds = rounds + 1, updated_at = ? WHERE wallet = ?'),
  feeGet: stmt('SELECT * FROM fee_accounts WHERE wallet = ?'),
  feeEnsure: stmt('INSERT OR IGNORE INTO fee_accounts (wallet, balance, prepaid_total, charged_total, period_id, period_loss, period_charged) VALUES (?, 0, 0, 0, NULL, 0, 0)'),
  feePrepay: stmt('UPDATE fee_accounts SET balance = balance + ?, prepaid_total = prepaid_total + ? WHERE wallet = ?'),
  feePeriod: stmt('UPDATE fee_accounts SET period_id = ?, period_loss = 0, period_charged = 0 WHERE wallet = ?'),
  feeSettle: stmt('UPDATE fee_accounts SET balance = balance - ?, charged_total = charged_total + ?, period_loss = ?, period_charged = ? WHERE wallet = ?'),
  ledgerAdd: stmt('INSERT INTO fee_ledger (wallet, kind, amount, tx_hash, period_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  ledgerList: stmt('SELECT * FROM fee_ledger WHERE wallet = ? ORDER BY id DESC LIMIT ?'),
  ledgerByTx: stmt('SELECT * FROM fee_ledger WHERE tx_hash = ?'),
  roundAdd: stmt('INSERT INTO rounds (wallet, market, position_ids, cost_usd, paper, fee_usd, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  roundList: stmt('SELECT * FROM rounds WHERE wallet = ? ORDER BY id DESC LIMIT ?'),
  globalStats: stmt('SELECT COUNT(*) AS rounds, COUNT(DISTINCT wallet) AS users, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(paper),0) AS paper, COALESCE(SUM(fee_usd),0) AS fee FROM rounds WHERE created_at > ?'),
  recentRounds: stmt('SELECT wallet, market, cost_usd, paper, created_at FROM rounds WHERE paper > 0 ORDER BY id DESC LIMIT ?'),
  activeCount: stmt("SELECT COUNT(*) AS n FROM strategies WHERE status = 'running'"),
  roundStats: stmt('SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(paper),0) AS paper, COALESCE(SUM(fee_usd),0) AS fee FROM rounds WHERE wallet = ? AND created_at > ?'),
  eventAdd: stmt('INSERT INTO events (wallet, level, kind, msg, data, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  eventList: stmt('SELECT * FROM events WHERE wallet = ? AND id > ? ORDER BY id DESC LIMIT ?'),
  eventPrune: stmt('DELETE FROM events WHERE created_at < ?'),
  kvGet: stmt('SELECT v FROM kv WHERE k = ?'),
  kvSet: stmt('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
  kvDel: stmt('DELETE FROM kv WHERE k = ?'),
  nonceGet: stmt('SELECT v FROM nonces WHERE k = ?'),
  nonceSet: stmt('INSERT INTO nonces (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
};
const json = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));

// ---- users / sessions ----
export const getUser = (w) => S.userGet.get(w.toLowerCase());
export const touchUser = (w) => S.userUpsert.run(w.toLowerCase(), now(), now());
export const getSession = (w) => S.sessGet.get(w.toLowerCase());
export const putSession = (w, { address, encPriv, expiry, state, intentId }) => S.sessPut.run(w.toLowerCase(), address.toLowerCase(), encPriv, Number(expiry), state, intentId ?? null, now());
export const setSessionState = (w, state) => S.sessState.run(state, w.toLowerCase());

// ---- strategies ----
export const getStrategy = (w) => { const r = S.stratGet.get(w.toLowerCase()); return r ? { ...r, params: JSON.parse(r.params) } : null; };
export const allStrategies = () => S.stratAll.all().map((r) => ({ ...r, params: JSON.parse(r.params) }));
export const startStrategy = (w, params, budgetUsd, periodId) => S.stratPut.run(w.toLowerCase(), 'running', json(params), budgetUsd, periodId, now(), now());
export const setStrategyStatus = (w, status, note = null) => S.stratStatus.run(status, note, now(), w.toLowerCase());
export const updateStrategyParams = (w, params, budgetUsd) => S.stratParams.run(json(params), budgetUsd, now(), w.toLowerCase());

// ---- fees ----
export function feeAccount(w) { S.feeEnsure.run(w.toLowerCase()); return S.feeGet.get(w.toLowerCase()); }
export const feeRequired = (budgetUsd, bps = CFG.feeBps, min = CFG.feeMinUsdc) => Math.max(min, (budgetUsd * bps) / 10000);
export function feePrepay(w, amount, txHash, note = null) {
  w = w.toLowerCase();
  if (txHash && S.ledgerByTx.get(txHash)) return { duplicate: true };
  S.feeEnsure.run(w);
  S.feePrepay.run(amount, amount, w);
  S.ledgerAdd.run(w, 'prepay', amount, txHash ?? null, null, note, now());
  return { duplicate: false, balance: S.feeGet.get(w).balance };
}
export function feeStartPeriod(w, periodId) { S.feeEnsure.run(w.toLowerCase()); S.feePeriod.run(periodId, w.toLowerCase()); }
// 每轮平仓后结算：本期费 = max(0, 本期净亏损) × bps；多收的退，少收的补。返回 { delta, balance }
export function feeSettleRound(w, periodId, costUsd, bps = CFG.feeBps) {
  w = w.toLowerCase();
  const a = feeAccount(w);
  const loss = (a.period_id === periodId ? a.period_loss : 0) + costUsd;
  const charged = a.period_id === periodId ? a.period_charged : 0;
  const due = Math.max(0, loss) * (bps / 10000);
  const delta = Math.round((due - charged) * 1e6) / 1e6;
  if (a.period_id !== periodId) S.feePeriod.run(periodId, w);
  S.feeSettle.run(delta, Math.max(0, delta), loss, due, w);
  if (Math.abs(delta) > 1e-9) S.ledgerAdd.run(w, delta > 0 ? 'charge' : 'refund', Math.abs(delta), null, periodId, null, now());
  return { delta, due, loss, balance: S.feeGet.get(w).balance };
}
export const feeLedger = (w, limit = 50) => S.ledgerList.all(w.toLowerCase(), limit);

// ---- rounds / events ----
export function addRound(w, { market, ids, cost, paper, fee, detail }) {
  S.roundAdd.run(w.toLowerCase(), market, ids.join('|'), cost, paper, fee, detail, now());
  S.stratRound.run(cost, paper, now(), w.toLowerCase());
}
export const listRounds = (w, limit = 50) => S.roundList.all(w.toLowerCase(), limit);
export const roundStats = (w, sinceMs) => S.roundStats.get(w.toLowerCase(), sinceMs);
export const globalStats = (windowMs = 0) => ({ ...S.globalStats.get(windowMs ? now() - windowMs : 0), active: S.activeCount.get().n });
export const recentRounds = (limit = 12) => S.recentRounds.all(limit).map((r) => ({ who: r.wallet.slice(0, 6) + '…' + r.wallet.slice(-4), market: r.market, cost: r.cost_usd, paper: r.paper, at: r.created_at }));
export function addEvent(w, level, kind, msg, data = null) { S.eventAdd.run(w ? w.toLowerCase() : null, level, kind, msg, data ? json(data) : null, now()); }
export const listEvents = (w, afterId = 0, limit = 100) => S.eventList.all(w.toLowerCase(), afterId, limit).map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null }));
export const pruneEvents = (olderThanMs) => S.eventPrune.run(now() - olderThanMs);

// ---- kv / nonces ----
export const kvGet = (k, dflt = null) => { const r = S.kvGet.get(k); return r ? JSON.parse(r.v) : dflt; };
export const kvSet = (k, v) => S.kvSet.run(k, json(v));
export const kvDel = (k) => S.kvDel.run(k);
export const nonceStorage = { getItem: (k) => S.nonceGet.get(k)?.v ?? null, setItem: (k, v) => S.nonceSet.run(k, String(v)) };
