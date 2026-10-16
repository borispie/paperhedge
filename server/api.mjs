// HTTP API（node:http，无框架）。只读写数据库 + 代用户向 relayer 提交他钱包签好的意图；交易由 worker 跑。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http, verifyMessage, parseAbiItem, decodeEventLog, formatUnits } from 'viem';
import {
  PapertradeTrader, fetchWalletState, createSessionKey, restoreSessionKey, isSessionKeyActive, pendingStakingRewardRaw, priceFromRaw, wadToNumber, MAINNET,
} from 'papertrade-sdk';
import { CFG, requireSecrets } from './config.mjs';
import * as DB from './db.mjs';
import { encrypt, decrypt, signJwt, verifyJwt, randomId } from './crypto.mjs';
import { tg } from './notify.mjs';
import { S, client, refreshProtocol, getPrice, mintRate, headroomUsd, dividend24h } from './shared.mjs';
import { candidates, normalizeParams, directPerPaper, DEFAULT_PARAMS } from './strategy.mjs';

requireSecrets();
const WEB_DIR = resolve(new URL('.', import.meta.url).pathname, '../web');
const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z', '[api]', ...a);
const now = () => Date.now();
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');
const jsonSafe = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)));
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------- 让钱包在浏览器里签：服务端先把 EIP-712 内容算好，等浏览器回传签名 ----------
class DeferredSigner {
  constructor(address) { this.address = address; this.pending = null; this.ready = new Promise((r) => { this._ready = r; }); }
  signTypedData(args) { return new Promise((resolve, reject) => { this.pending = { args, resolve, reject }; this._ready(); }); }
}
const pendingSigs = new Map(); // requestId -> { wallet, kind, signer, promise, trader, session?, ttlDays?, at }
setInterval(() => { for (const [id, p] of pendingSigs) if (now() - p.at > 10 * 60_000) { p.signer.pending?.reject(new Error('expired')); pendingSigs.delete(id); } }, 60_000);

async function deferSign(wallet, kind, build) {
  const signer = new DeferredSigner(wallet);
  const sess = DB.getSession(wallet);
  const session = sess?.state === 'active' ? restoreSessionKey(decrypt(sess.enc_priv), BigInt(sess.expiry)) : undefined;
  const trader = new PapertradeTrader({ user: wallet, wallet: signer, session, client, nonceStorage: DB.nonceStorage });
  const ctx = { trader, signer };
  const promise = build(ctx); promise.catch(() => {});
  await Promise.race([signer.ready, promise]);          // 要么等到签名请求，要么 build 自己先抛错
  if (!signer.pending) await promise;                    // 没走到签名就结束 → 把错误抛出来
  const requestId = randomId(12);
  pendingSigs.set(requestId, { wallet, kind, signer, promise, trader, ...ctx, at: now() });
  const { domain, types, primaryType, message } = signer.pending.args;
  return { requestId, typedData: jsonSafe({ domain, types: { EIP712Domain: eip712DomainTypes(domain), ...types }, primaryType, message }), summary: '' };
}
function eip712DomainTypes(domain) {
  const t = [];
  if (domain.name !== undefined) t.push({ name: 'name', type: 'string' });
  if (domain.version !== undefined) t.push({ name: 'version', type: 'string' });
  if (domain.chainId !== undefined) t.push({ name: 'chainId', type: 'uint256' });
  if (domain.verifyingContract !== undefined) t.push({ name: 'verifyingContract', type: 'address' });
  return t;
}
async function finishSign(requestId, signature, wallet) {
  const p = pendingSigs.get(requestId);
  if (!p || p.wallet !== wallet) throw new HttpError(404, '签名请求不存在或已过期');
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature || '')) throw new HttpError(400, '签名格式不对');
  pendingSigs.delete(requestId);
  p.signer.pending.resolve(signature);
  const prepared = await p.promise;   // 签名 → prepared intent（或 registerSession 的 { prepared, session }）
  return { p, prepared };
}

// ---------- 链上：查用户给国库转 USDC 的交易 ----------
const pub = createPublicClient({ transport: http(CFG.rpcUrl) });
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
async function verifyFeeTx(txHash, wallet) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) throw new HttpError(400, '交易哈希格式不对');
  const rc = await pub.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!rc) throw new HttpError(404, '链上还没查到这笔交易，等确认后再试');
  if (rc.status !== 'success') throw new HttpError(400, '这笔交易失败了');
  let total = 0n;
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== MAINNET.contracts.usdc) continue;
    try {
      const ev = decodeEventLog({ abi: [TRANSFER], data: l.data, topics: l.topics });
      if (ev.eventName === 'Transfer' && ev.args.to.toLowerCase() === CFG.treasury && ev.args.from.toLowerCase() === wallet) total += ev.args.value;
    } catch {}
  }
  if (total === 0n) throw new HttpError(400, '这笔交易里没有从你的钱包转给国库的 USDC');
  return Number(formatUnits(total, 6));
}

// ---------- 钱包状态（5 秒缓存） ----------
const wcache = new Map();
async function walletState(wallet) {
  const c = wcache.get(wallet);
  if (c && now() - c.at < 5000) return c.W;
  const W = await fetchWalletState(wallet, { timeoutMs: 15000 });
  wcache.set(wallet, { W, at: now() });
  return W;
}

// ---------- 登录（钱包签一条消息） ----------
const nonces = new Map();
function loginMessage(wallet, nonce) { return `Paper Farm 登录\n\n钱包: ${wallet}\n随机数: ${nonce}\n\n这只是登录签名，不花钱、不授权交易。`; }

// ---------- 路由 ----------
const routes = [];
const route = (method, path, handler, auth = false) => routes.push({ method, path, handler, auth });

route('GET', '/api/market', async () => {
  await refreshProtocol();
  const inst = [];
  for (const [sym, i] of Object.entries(S.insts)) {
    const price = await getPrice(sym).catch(() => null);
    inst.push({ symbol: sym, id: i.id, openable: i.openable, maxLeverage: i.maxLeverage, price, headroomLongUsd: price ? headroomUsd(i, 'long', price) : null, headroomShortUsd: price ? headroomUsd(i, 'short', price) : null, bustBufferBps: wadToNumber(i.bustBufferRaw) * 1e4 });
  }
  const div = await dividend24h();
  return {
    asOf: S.protoAt, mintRate: mintRate(), directPerPaper: directPerPaper(mintRate()), halt: S.halt, dip: S.dip,
    lpUsd: wadToNumber(S.summary.balances.lp), queueUsd: wadToNumber(S.summary.balances.queue), supply: wadToNumber(S.summary.paper.supply), staked: wadToNumber(S.summary.paper.staked),
    dividend24hPer1000: div?.perThousand ?? null,
    fee: { bps: CFG.feeBps, pct: CFG.feeBps / 100, free: CFG.feeBps <= 0, minUsdc: CFG.feeMinUsdc, treasury: CFG.treasury, token: MAINNET.contracts.usdc, decimals: 6, chainId: MAINNET.chainId },
    limits: { minMarginUsd: wadToNumber(S.trading.minimumTradeSizeRaw), minNotionalUsd: wadToNumber(S.trading.minimumOpenNotionalRaw), maxBudgetUsd: CFG.maxBudgetUsd, minStakePaper: wadToNumber(S.trading.intake.minimumPaperStakeRaw) || 1000, sessionTtlDays: CFG.sessionTtlDays },
    presets: CFG.presets, defaults: DEFAULT_PARAMS, emergencyFrac: CFG.emergencyFrac, instruments: inst,
  };
});

// 全站公开数据（首页用）
route('GET', '/api/stats', async () => { const all = DB.globalStats(0), day = DB.globalStats(86400e3); const rate = S.summary ? mintRate() : 0; const direct = rate ? 1 / (0.98 * rate) : 0; return { all: { ...all, savedUsd: direct ? Math.max(0, all.paper * direct - all.cost) : 0 }, day, recent: DB.recentRounds(12) }; });

// 不登录也能估算：avail = 打算放进 Papertrade 的钱
route('POST', '/api/estimate', async (b) => {
  await refreshProtocol();
  const params = normalizeParams(b.params);
  const avail = Math.max(0, Number(b.avail) || 0);
  const prices = {};
  for (const sym of Object.keys(S.insts)) prices[sym] = await getPrice(sym);
  const { best, list } = candidates({ insts: S.insts, trading: S.trading, prices, avail, params, rate: mintRate(), feeBps: CFG.feeBps, emergencyFrac: CFG.emergencyFrac, minHeadroomUsd: CFG.minHeadroomUsd, headroom: headroomUsd });
  const budget = Math.max(0, Number(b.budgetUsd) || 0);
  return jsonSafe({ params, avail, mintRate: mintRate(), directPerPaper: directPerPaper(mintRate()), best: best ? { sym: best.sym, price: best.price, plan: best.plan, est: best.est, first: best.first } : null,
    list: list.map((c) => (c.est ? { sym: c.sym, price: c.price, plan: c.plan, est: c.est } : { sym: c.sym, why: c.why })),
    feeRequired: DB.feeRequired(budget), budgetRounds: best && budget ? Math.floor(budget / best.est.cost) : null, budgetPaper: best && budget ? Math.floor(budget / best.est.cost) * best.est.paper : null });
});

route('GET', '/api/auth/nonce', async (b, q) => {
  const wallet = (q.get('wallet') || '').toLowerCase();
  if (!isAddr(wallet)) throw new HttpError(400, '钱包地址不对');
  const nonce = randomId(8); nonces.set(wallet, { nonce, at: now() });
  return { message: loginMessage(wallet, nonce) };
});
route('POST', '/api/auth/verify', async (b) => {
  const wallet = (b.wallet || '').toLowerCase(), n = nonces.get(wallet);
  if (!isAddr(wallet) || !n || now() - n.at > 10 * 60_000) throw new HttpError(400, '先取 nonce');
  const ok = await verifyMessage({ address: wallet, message: loginMessage(wallet, n.nonce), signature: b.signature }).catch(() => false);
  if (!ok) throw new HttpError(401, '签名不对');
  nonces.delete(wallet); if (!DB.getUser(wallet)) tg(`👤 新用户登录 ${wallet.slice(0, 6)}…${wallet.slice(-4)}`); DB.touchUser(wallet);
  return { token: signJwt({ sub: wallet }), wallet };
});

route('GET', '/api/me', async (b, q, wallet) => {
  await refreshProtocol();
  const W = await walletState(wallet);
  const sess = DB.getSession(wallet);
  if (sess && sess.state !== 'active' && isSessionKeyActive(W.sessionKeys, sess.address)) { DB.setSessionState(wallet, 'active'); sess.state = 'active'; }
  if (sess && sess.state === 'active' && !isSessionKeyActive(W.sessionKeys, sess.address)) { DB.setSessionState(wallet, 'expired'); sess.state = 'expired'; }
  const positions = [];
  for (const p of W.positions) {
    const inst = S.instById[p.instrumentId]; if (!inst) continue;
    const price = await getPrice(inst.symbol).catch(() => null);
    const entry = priceFromRaw(p.entryPriceRaw, inst.priceScale);
    positions.push({ id: String(p.positionId), symbol: inst.symbol, isLong: p.isLong, marginUsd: wadToNumber(p.marginRaw), leverage: p.leverage, entry, bust: priceFromRaw(p.bustPriceRaw, inst.priceScale), price, changePct: price ? ((price - entry) / entry) * (p.isLong ? 1 : -1) * 100 : null });
  }
  const pending = wadToNumber(pendingStakingRewardRaw({ stakedRaw: W.paper.staked, accRewardPerShareRaw: S.trading.accRewardPerShareRaw, rewardDebtRaw: W.paper.rewardDebt, pendingBaseRaw: W.paper.pendingBase }));
  const st = DB.getStrategy(wallet), fee = DB.feeAccount(wallet);
  return jsonSafe({
    wallet, balanceUsd: wadToNumber(W.balance), availableUsd: wadToNumber(W.funds.availableBalance), paper: wadToNumber(W.paper.balance), staked: wadToNumber(W.paper.staked), pendingRewardUsd: pending,
    positions, queuedOps: (W.operations ?? []).filter((o) => o.state === 'queued').map((o) => ({ action: o.action, intentId: o.intentId })),
    session: sess ? { address: sess.address, state: sess.state, expiry: sess.expiry } : null,
    strategy: st, fee: { ...fee, required: st ? DB.feeRequired(st.budget_usd) : DB.feeRequired(0) },
    stats24h: DB.roundStats(wallet, now() - 86400e3), statsAll: DB.roundStats(wallet, 0),
  });
}, true);

// 交易授权：生成 session key → 浏览器签 RegisterSessionKey → 提交
route('POST', '/api/session/prepare', async (b, q, wallet) => {
  const days = CFG.sessionTtlDays.includes(Number(b.ttlDays)) ? Number(b.ttlDays) : 1;
  const session = createSessionKey(days * 86400);
  const r = await deferSign(wallet, 'register', ({ trader }) => trader.prepareRegisterSession(session));
  pendingSigs.get(r.requestId).session = session;
  return { ...r, sessionAddress: session.account.address, expiry: Number(session.expiry), summary: `授权 ${session.account.address} 在 ${days} 天内替你开/平仓（不能提现、不能质押）` };
}, true);
route('POST', '/api/session/submit', async (b, q, wallet) => {
  const { p, prepared } = await finishSign(b.requestId, b.signature, wallet);
  const sent = await p.trader.submit(prepared.prepared);
  DB.putSession(wallet, { address: p.session.account.address, encPriv: encrypt(p.session.privateKey), expiry: p.session.expiry, state: 'submitted', intentId: sent.receipt.intentId });
  DB.addEvent(wallet, 'info', 'session', `授权已提交 ${sent.receipt.intentId.slice(0, 12)}… ${sent.receipt.state}`);
  return { intentId: sent.receipt.intentId, state: sent.receipt.state };
}, true);

// 质押 / 解押 / 领分红：浏览器签 PaperStaking 意图 → 提交
route('POST', '/api/wallet/prepare', async (b, q, wallet) => {
  const action = b.action;
  if (!['stake', 'unstake', 'claim'].includes(action)) throw new HttpError(400, 'action 要是 stake|unstake|claim');
  const amount = String(b.amount ?? '');
  const r = await deferSign(wallet, action, ({ trader }) => (action === 'stake' ? trader.prepareStake(amount) : action === 'unstake' ? trader.prepareUnstake(amount) : trader.prepareClaim()));
  return { ...r, summary: action === 'claim' ? '领取 USDC 分红' : `${action === 'stake' ? '质押' : '解押'} ${amount} PAPER` };
}, true);
route('POST', '/api/wallet/submit', async (b, q, wallet) => {
  const { p, prepared } = await finishSign(b.requestId, b.signature, wallet);
  const sent = await p.trader.submit(prepared);
  DB.addEvent(wallet, 'info', p.kind, `${p.kind} 已提交 ${sent.receipt.intentId.slice(0, 12)}… ${sent.receipt.state}`);
  wcache.delete(wallet);
  return { intentId: sent.receipt.intentId, state: sent.receipt.state };
}, true);

// 服务费：预付登记（用户已把 USDC 转到国库）
route('GET', '/api/fee', async (b, q, wallet) => ({ account: DB.feeAccount(wallet), ledger: DB.feeLedger(wallet, 50), config: { bps: CFG.feeBps, minUsdc: CFG.feeMinUsdc, treasury: CFG.treasury, token: MAINNET.contracts.usdc } }), true);
route('POST', '/api/fee/register', async (b, q, wallet) => {
  const amount = await verifyFeeTx(b.txHash, wallet);
  const r = DB.feePrepay(wallet, amount, b.txHash.toLowerCase());
  if (r.duplicate) throw new HttpError(409, '这笔交易已经登记过了');
  DB.addEvent(wallet, 'info', 'fee-prepay', `${CFG.feeBps > 0 ? '预付' : '收到支持'} $${amount.toFixed(2)} · ${b.txHash.slice(0, 10)}…`);
  tg(`💵 ${wallet.slice(0, 6)}… ${CFG.feeBps > 0 ? '预付服务费' : '转来支持'} $${amount.toFixed(2)}（累计 $${r.balance.toFixed(2)}）`);
  const st = DB.getStrategy(wallet);
  if (st && st.status === 'halted_fee' && r.balance > 0) DB.setStrategyStatus(wallet, 'running', '预付后恢复');
  return { credited: amount, balance: r.balance };
}, true);

// 策略
route('POST', '/api/strategy/start', async (b, q, wallet) => {
  const sess = DB.getSession(wallet);
  if (!sess || sess.state !== 'active') {
    const W = await walletState(wallet);
    if (sess && isSessionKeyActive(W.sessionKeys, sess.address)) DB.setSessionState(wallet, 'active'); else throw new HttpError(400, '先完成交易授权（等链上确认）');
  }
  const budget = Number(b.budgetUsd);
  if (!(budget >= 1) || budget > CFG.maxBudgetUsd) throw new HttpError(400, `成本预算要在 1–${CFG.maxBudgetUsd} USDC`);
  const params = normalizeParams(b.params);
  if (params.market !== 'auto' && !S.insts[params.market]) throw new HttpError(400, '市场不支持');
  const need = DB.feeRequired(budget), fee = DB.feeAccount(wallet);
  if (fee.balance + 1e-9 < need) throw new HttpError(402, `服务费余额 $${fee.balance.toFixed(2)}，启动需要 $${need.toFixed(2)}（预算 × ${CFG.feeBps / 100}%，最低 $${CFG.feeMinUsdc}）`);
  const cur = DB.getStrategy(wallet);
  if (cur && ['running', 'stopping', 'stopping_soft'].includes(cur.status)) throw new HttpError(409, '策略已在运行，先停止');
  const periodId = randomId(8);
  DB.startStrategy(wallet, params, budget, periodId); DB.feeStartPeriod(wallet, periodId);
  DB.addEvent(wallet, 'info', 'start', `用户启动策略 预算 $${budget}`, params);
  tg(`🚀 ${wallet.slice(0, 6)}… 启动策略 预算 $${budget} ${params.market} ${params.leverage}x ±${(params.targetPct * 100).toFixed(2)}%`);
  return { ok: true, strategy: DB.getStrategy(wallet) };
}, true);
route('POST', '/api/strategy/stop', async (b, q, wallet) => {
  const cur = DB.getStrategy(wallet);
  if (!cur || !['running', 'stopping', 'stopping_soft', 'halted_fee', 'halted_session'].includes(cur.status)) throw new HttpError(400, '没有在运行的策略');
  const soft = b.mode === 'soft';
  DB.setStrategyStatus(wallet, soft ? 'stopping_soft' : 'stopping', soft ? '用户要求本轮平完停' : '用户要求全平停');
  if (['halted_fee', 'halted_session'].includes(cur.status)) DB.setStrategyStatus(wallet, 'stopped', '用户停止');
  DB.addEvent(wallet, 'info', 'stop', soft ? '用户：本轮平完后停止' : '用户：立即全平停止');
  return { ok: true };
}, true);
route('POST', '/api/strategy/params', async (b, q, wallet) => {
  const cur = DB.getStrategy(wallet); if (!cur) throw new HttpError(400, '还没有策略');
  const params = normalizeParams({ ...cur.params, ...b.params });
  const budget = b.budgetUsd !== undefined ? Number(b.budgetUsd) : cur.budget_usd;
  if (!(budget >= 1) || budget > CFG.maxBudgetUsd) throw new HttpError(400, '预算范围不对');
  DB.updateStrategyParams(wallet, params, budget);
  DB.addEvent(wallet, 'info', 'params', '参数已更新', { params, budget });
  return { ok: true, strategy: DB.getStrategy(wallet) };
}, true);
route('POST', '/api/strategy/resume', async (b, q, wallet) => {
  const cur = DB.getStrategy(wallet); if (!cur) throw new HttpError(400, '还没有策略');
  if (!['halted_fee', 'halted_session', 'stopped', 'done_budget'].includes(cur.status)) throw new HttpError(400, '当前状态不能恢复');
  const need = DB.feeRequired(cur.budget_usd), fee = DB.feeAccount(wallet);
  if (fee.balance + 1e-9 < need && fee.balance <= 0) throw new HttpError(402, '先预付服务费');
  DB.setStrategyStatus(wallet, 'running', '用户恢复');
  return { ok: true };
}, true);
route('GET', '/api/events', async (b, q, wallet) => ({ events: DB.listEvents(wallet, Number(q.get('after') || 0), Math.min(200, Number(q.get('limit') || 100))) }), true);
route('GET', '/api/rounds', async (b, q, wallet) => ({ rounds: DB.listRounds(wallet, Math.min(200, Number(q.get('limit') || 50))) }), true);

// ---------- 服务器 ----------
const hits = new Map(); // ip -> { n, at }
function rateLimit(ip) { const h = hits.get(ip) ?? { n: 0, at: now() }; if (now() - h.at > 60_000) { h.n = 0; h.at = now(); } h.n++; hits.set(ip, h); if (h.n > 240) throw new HttpError(429, '太频繁了'); }
const CORS = { 'access-control-allow-origin': process.env.CORS_ORIGIN || '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const server = createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const url = new URL(req.url, 'http://x');
    rateLimit(req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress);
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {   // 静态页
      const file = url.pathname === '/' || url.pathname === '/index.html' ? 'index.html' : url.pathname.slice(1).replace(/\.\./g, '');
      try { const body = readFileSync(resolve(WEB_DIR, file)); res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream', 'cache-control': 'no-cache' }); return res.end(body); }
      catch { throw new HttpError(404, 'not found'); }
    }
    const r = routes.find((x) => x.method === req.method && x.path === url.pathname);
    if (!r) throw new HttpError(404, 'not found');
    let body = {};
    if (req.method === 'POST') {
      const chunks = []; for await (const c of req) { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 64 * 1024) throw new HttpError(413, 'too big'); }
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {};
    }
    let wallet = null;
    if (r.auth) {
      const tok = (req.headers.authorization || '').replace(/^Bearer /i, '');
      const p = verifyJwt(tok); if (!p?.sub) throw new HttpError(401, '请先登录');
      wallet = p.sub.toLowerCase();
    }
    send(200, await r.handler(body, url.searchParams, wallet));
  } catch (e) {
    const status = e.status ?? (e.name === 'PapertradeApiError' ? 502 : 500);
    if (status >= 500) log('错误', req.method, req.url, e.message);
    send(status, { error: e.message ?? String(e), reason: e.reason });
  }
});
refreshProtocol(true).then(() => { server.listen(CFG.port, () => log(`API 监听 :${CFG.port}，服务费 ${CFG.feeBps / 100}%`)); }).catch((e) => { log('启动失败:', e.message); process.exit(1); });
