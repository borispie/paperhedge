// 全站共享的协议读数：交易参数、协议汇总、价格、公告、参数基线、抄底判断。
// 所有用户共用一份，避免 N 个用户 × N 次请求把 relayer 打爆。
import { PapertradeClient, paperMintRate, wadToNumber } from 'papertrade-sdk';
import { CFG } from './config.mjs';
import { kvGet, kvSet, addEvent } from './db.mjs';

export const client = new PapertradeClient({ clientBuild: 'paper-farm-v1' });

export const S = {
  trading: null, summary: null, insts: {}, instById: {},
  prices: {},            // sym -> { price, at }
  notices: [], noticesAt: 0,
  protoAt: 0,
  halt: null,            // { reason } 全站停开新仓
  dip: false,
};

const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z', ...a);

let protoInflight = null;
export function refreshProtocol(force = false) {
  if (!force && now() - S.protoAt < 30_000) return Promise.resolve();
  if (!protoInflight) protoInflight = refreshProtocolNow().finally(() => { protoInflight = null; });
  return protoInflight;
}
async function refreshProtocolNow() {
  const [trading, summary] = await Promise.all([client.tradingState(), client.protocolSummary()]);
  S.trading = trading; S.summary = summary; S.protoAt = now();
  for (const sym of CFG.markets) {
    const i = trading.instruments.find((x) => x.symbol === sym);
    if (i) { S.insts[sym] = i; S.instById[i.id] = i; }
  }
  checkBaseline();
  checkDip();
  await refreshNotices();
  S.halt = haltReason();
}

export async function refreshNotices() {
  if (now() - S.noticesAt < 60_000) return;
  try { S.notices = (await client.notices()).notices ?? []; S.noticesAt = now(); } catch (e) { log('读公告失败:', e.message); }
}

// 价格：官方 price-history 最后一个点（125ms 级），失败用 Hyperliquid allMids；2 秒内复用
export async function getPrice(sym) {
  const c = S.prices[sym];
  if (c && now() - c.at < 2000) return c.price;
  const inst = S.insts[sym];
  try {
    const { points } = await client.priceHistory({ instrumentId: inst.id, lookbackMs: 60_000 });
    const last = points.at(-1);
    if (last && Number.isFinite(last.price)) { S.prices[sym] = { price: last.price, at: now() }; return last.price; }
  } catch (e) { log(`${sym} 官方价格失败，改用 Hyperliquid:`, e.message); }
  const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }) });
  const j = await r.json();
  S.prices[sym] = { price: Number(j[sym]), at: now() };
  return S.prices[sym].price;
}

export const mintRate = () => paperMintRate({ trackedLpUsd: wadToNumber(S.summary.paper.trackedLp), tailProgressUsd: wadToNumber(S.summary.paper.tailProgress) });
export function headroomUsd(inst, side, price) {
  const oi = side === 'long' ? inst.longOiRaw : inst.shortOiRaw;
  const cap = side === 'long' ? inst.longCapRaw : inst.shortCapRaw;
  return wadToNumber(cap - oi) * price;
}

// 参数基线：铸币曲线和各币的 haircut 参数变了就全站停开新仓（人工确认后 kv 删掉 baseline 即恢复）
export function paramSnapshot() {
  const s = S.summary.paper, out = { cap: String(s.cap), cliff: String(s.cliff), decay: String(s.decay), flatRate: String(s.rate), minMargin: S.trading.minimumTradeSizeRaw.toString(), minNotional: S.trading.minimumOpenNotionalRaw.toString() };
  for (const [sym, i] of Object.entries(S.insts)) out[sym] = [i.baseRateRaw, i.rateMultiplierRaw, i.positionMultiplierRaw, i.referenceNotionalRaw, i.bustBufferRaw, i.maxLeverage].map(String).join('/');
  return out;
}
let baselineDiff = null;
function checkBaseline() {
  const snap = paramSnapshot(), base = kvGet('baseline');
  if (!base) { kvSet('baseline', snap); addEvent(null, 'info', 'baseline', '已记录参数基线', snap); baselineDiff = null; return; }
  const diff = Object.keys(snap).filter((k) => String(snap[k]) !== String(base[k]));
  if (diff.length && !baselineDiff) addEvent(null, 'warn', 'baseline', '协议参数变了: ' + diff.join(','), { was: base, now: snap });
  baselineDiff = diff.length ? diff : null;
}
export const resetBaseline = () => { kvSet('baseline', paramSnapshot()); baselineDiff = null; };

function checkDip() {
  const lp = wadToNumber(S.summary.balances.lp), queue = wadToNumber(S.summary.balances.queue);
  const dip = lp < CFG.dipLpThresholdUsd || queue > 0 || kvGet('forceDip', false);
  if (dip !== S.dip) addEvent(null, 'info', 'dip', dip ? `抄底模式开启: 池子 $${lp.toFixed(0)} 队列 $${queue.toFixed(0)} 铸币率 ${mintRate().toFixed(1)}/$` : '抄底模式结束');
  S.dip = dip;
}

function haltReason() {
  if (kvGet('stopAll', false)) return '管理员停开新仓';
  if (S.trading.tradingPaused) return '交易已暂停';
  if (!S.trading.intake.actions.openPosition) return 'relayer 不接受开仓';
  if (S.notices.length) return '平台有新公告: ' + JSON.stringify(S.notices).slice(0, 200);
  if (!S.dip && BigInt(S.summary.balances.queue) > 0n) return '队列有欠款 $' + wadToNumber(S.summary.balances.queue).toFixed(0);
  if (baselineDiff) return '协议参数变了: ' + baselineDiff.join(',');
  return null;
}

// 24 小时分红 / 每 1000 质押 PAPER（给前端"PAPER 值多少"面板）
export async function dividend24h() {
  try {
    const pay = await client.http.get('/query/house/staker-payouts', { interval: '1m' });
    const pts = pay.points ?? [], last = pts.at(-1);
    if (!last) return null;
    const t = last[0] - 86400e3; let v = pay.baseUsd; for (const [a, b] of pts) { if (a <= t) v = b; else break; }
    const pay24 = last[1] - v;
    return { pay24, perThousand: pay24 / (wadToNumber(S.summary.paper.staked) / 1000) };
  } catch { return null; }
}
