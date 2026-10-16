process.env.KEY_SECRET = 'ab'.repeat(32); process.env.JWT_SECRET = 'test-secret-1234567890'; process.env.TREASURY = '0x' + '1'.repeat(40);
process.env.DB_PATH = './data/test.db';
import { rmSync } from 'node:fs';
try { rmSync('./data/test.db'); rmSync('./data/test.db-wal'); rmSync('./data/test.db-shm'); } catch {}
const { encrypt, decrypt, signJwt, verifyJwt } = await import('../server/crypto.mjs');
const DB = await import('../server/db.mjs');
const { planFor, roundEstimate, candidates, normalizeParams, directPerPaper } = await import('../server/strategy.mjs');
const assert = (c, m) => { if (!c) throw new Error('断言失败: ' + m); console.log('ok', m); };

// crypto
assert(decrypt(encrypt('0xdeadbeef')) === '0xdeadbeef', '加解密');
assert(verifyJwt(signJwt({ sub: '0xabc' })).sub === '0xabc', 'jwt');
assert(verifyJwt(signJwt({ sub: '0xabc' }) + 'x') === null, 'jwt 篡改');

// fees
const w = '0xF5A3c2Af859325d79927382954D4b0722275927f';
assert(DB.feeRequired(100) === 3, '预算100 → 需预付 $3');
assert(DB.feeRequired(10) === 1, '预算10 → 最低 $1');
DB.feePrepay(w, 3, '0xtx1'); assert(DB.feePrepay(w, 3, '0xtx1').duplicate, '重复 tx 不记两次');
DB.touchUser(w); DB.startStrategy(w, normalizeParams({}), 100, 'p1'); DB.feeStartPeriod(w, 'p1');
let r = DB.feeSettleRound(w, 'p1', 2.55); assert(Math.abs(r.delta - 0.0765) < 1e-6 && Math.abs(r.balance - 2.9235) < 1e-6, '第一轮 2.55 → 收 0.0765');
r = DB.feeSettleRound(w, 'p1', -1.0); assert(Math.abs(r.delta - (-0.03)) < 1e-6, '净赚 1 → 退 0.03');
r = DB.feeSettleRound(w, 'p1', 10); assert(Math.abs(r.due - (11.55 * 0.03)) < 1e-6, '累计净亏 11.55 → 本期应收 0.3465');
DB.addRound(w, { market: 'BTC', ids: [1, 2], cost: 2.55, paper: 188, fee: 0.0765, detail: 'x' });
const st = DB.getStrategy(w); assert(st.rounds === 1 && st.spent_usd === 2.55 && st.paper === 188, 'rounds 记账');
assert(DB.feeLedger(w).length === 4, 'ledger 4 条');

// strategy sizing with synthetic BTC instrument (官方参数)
const wad = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const inst = { id: 0, symbol: 'BTC', priceScale: 10n, openable: true, maxLeverage: 1000, baseRateRaw: wad(0.1), rateMultiplierRaw: wad(15000), positionMultiplierRaw: wad(814.598), referenceNotionalRaw: wad(100000), bustBufferRaw: wad(0.000476), maxPositionNotionalRaw: wad(10_000_000), longOiRaw: 0n, shortOiRaw: 0n, longCapRaw: wad(100), shortCapRaw: wad(100) };
const trading = { minimumTradeSizeRaw: wad(10), minimumOpenNotionalRaw: wad(1000) };
const params = normalizeParams({ leverage: 'max', targetPct: 0.005 });
const plan = planFor({ inst, trading, avail: 83.18, params });
console.log(plan);
assert(plan.m === 41.09 && plan.L === 100 && plan.target === 0.005, '83.18 可用 → $41.09×100x ±0.5%');
const est = roundEstimate({ inst, price: 82000, plan, rate: 14.6, feeBps: 300 });
console.log(est);
assert(est.cost > 2.8 && est.cost < 3.6 && est.paper > 280 && est.paper < 320, '一轮成本 ~$3.2 铸 ~290');
assert(Math.abs(est.fee - est.cost * 0.03) < 1e-9, '服务费 3%');
const p3 = planFor({ inst, trading, avail: 83.18, params: normalizeParams({ leverage: 100, targetPct: 0.003 }) });
assert(p3.L === 100 && p3.target === 0.003, '指定 100x ±0.3%');
const small = planFor({ inst, trading, avail: 15, params });
assert(small.err, '余额太小报错: ' + small.err);
const { best, list } = candidates({ insts: { BTC: inst }, trading, prices: { BTC: 82000 }, avail: 83.18, params, rate: 14.6, feeBps: 300, headroom: (i, side, price) => 100 * price });
assert(best && best.sym === 'BTC' && best.first === 'long', '选币');
console.log('直接亏着挖 $/PAPER', directPerPaper(14.6).toFixed(4), '对冲', est.perPaper.toFixed(4));
console.log('全部通过');
