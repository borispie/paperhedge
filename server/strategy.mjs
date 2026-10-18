// 纯计算：规模、杠杆、目标、每轮成本估算、选币。不碰网络，前后端共用同一套公式。
import { estimateClose, priceToRaw, usdToWad, wadToNumber } from 'papertrade-sdk';

// 用户参数（保存在 strategies.params）
export const DEFAULT_PARAMS = { market: 'auto', marginPerLeg: 0, leverage: 'max', targetPct: 0.005, dipBoost: true };
export function normalizeParams(p = {}) {
  const out = { ...DEFAULT_PARAMS, ...p };
  out.market = String(out.market || 'auto').toUpperCase() === 'AUTO' ? 'auto' : String(out.market).toUpperCase();
  out.marginPerLeg = Math.max(0, Number(out.marginPerLeg) || 0);
  out.leverage = out.leverage === 'max' ? 'max' : Math.max(1, Math.floor(Number(out.leverage) || 0)) || 'max';
  out.targetPct = Math.min(0.05, Math.max(0.001, Number(out.targetPct) || 0.005));
  out.dipBoost = Boolean(out.dipBoost);
  out.stopOnEmpty = Boolean(out.stopOnEmpty); // 钱用完就停，不等充值
  return out;
}

// 给定可用余额 + 市场 + 用户参数：每边保证金 m、杠杆 L、目标走动 target（≤ 紧急线）
export function planFor({ inst, trading, avail, params, emergencyFrac = 0.6, minBustPct = 0.006 }) {
  const minNotional = wadToNumber(trading.minimumOpenNotionalRaw), minMargin = wadToNumber(trading.minimumTradeSizeRaw);
  const half = Math.floor(((avail - 1) / 2) * 100) / 100;
  let m = params.marginPerLeg > 0 ? Math.min(params.marginPerLeg, half) : half;
  if (m < minMargin) return { err: `可用 $${avail.toFixed(2)}，每边只能 $${m.toFixed(2)}，低于最小保证金 $${minMargin}` };
  let L = Math.max(1, Math.ceil(minNotional / m));
  if (m * L < minNotional) L += 1;
  const buf = wadToNumber(inst.bustBufferRaw);
  let want = 0;
  if (params.leverage === 'max') {
    const needBust = (params.targetPct + 0.0005) / emergencyFrac;      // 目标 + 0.05% 余量要落在紧急线以内
    want = Math.floor(1 / (needBust + buf) / 5) * 5;
  } else want = params.leverage;
  // 安全上限：强平距离至少 minBustPct（relayer 排队慢时单腿裸奔几分钟也不至于爆）
  const capL = Math.floor(1 / (minBustPct + buf) / 5) * 5;
  if (want > capL) want = capL;
  if (want > L) L = Math.min(want, inst.maxLeverage);
  if (L > inst.maxLeverage) return { err: `每边 $${m} 要 ${L}x 才够最小名义 $${minNotional}，超过 ${inst.symbol} 最高 ${inst.maxLeverage}x` };
  if (m * L > wadToNumber(inst.maxPositionNotionalRaw)) return { err: `名义 $${(m * L).toFixed(0)} 超过单仓上限` };
  const bustDist = 1 / L - buf;
  const target = Math.min(params.targetPct, Math.floor((emergencyFrac * bustDist - 0.0005) * 10000) / 10000);
  if (target <= 0.001) return { err: `${L}x 强平距离只有 ${(bustDist * 100).toFixed(2)}%，放不下 ±${(params.targetPct * 100).toFixed(2)}% 的目标，把杠杆调小` };
  return { m, L, bustDist, target, notional: m * L };
}

// 一轮（两腿到 ±target 一起平）的估算：亏、赢、净花、铸 PAPER、每 1000 PAPER 成本（含/不含服务费）
export function roundEstimate({ inst, price, plan, rate, feeBps = 0 }) {
  const e = priceToRaw(price, inst.priceScale), up = priceToRaw(price * (1 + plan.target), inst.priceScale);
  const marginRaw = usdToWad(String(plan.m));
  const win = estimateClose({ instrument: inst, isLong: true, entryPriceRaw: e, exitPriceRaw: up, marginRaw, leverage: plan.L });
  const loss = estimateClose({ instrument: inst, isLong: false, entryPriceRaw: e, exitPriceRaw: up, marginRaw, leverage: plan.L });
  const cost = -loss.netPnlUsd - win.netPnlUsd, paper = loss.paperMintBasisUsd * rate;
  const fee = Math.max(0, cost) * (feeBps / 10000);
  return { lossUsd: -loss.netPnlUsd, winUsd: win.netPnlUsd, cost, fee, costWithFee: cost + fee, paper, costPer1000: (cost / paper) * 1000, costPer1000WithFee: ((cost + fee) / paper) * 1000, perPaper: (cost + fee) / paper };
}

// 候选市场：开得了、OI 两边余量够，按每 1000 PAPER 成本排序
export function candidates({ insts, trading, prices, avail, params, rate, feeBps = 0, emergencyFrac = 0.6, minBustPct = 0.006, minHeadroomUsd = 5000, headroom }) {
  const list = [];
  const syms = params.market === 'auto' ? Object.keys(insts) : [params.market];
  for (const sym of syms) {
    const inst = insts[sym];
    if (!inst) { list.push({ sym, why: '未配置该市场' }); continue; }
    if (!inst.openable) { list.push({ sym, why: '不接受开仓' }); continue; }
    const price = prices[sym];
    if (!price) { list.push({ sym, why: '没有价格' }); continue; }
    const plan = planFor({ inst, trading, avail, params, emergencyFrac, minBustPct });
    if (plan.err) { list.push({ sym, why: plan.err }); continue; }
    const need = Math.max(minHeadroomUsd, plan.notional * 3);
    const hl = headroom(inst, 'long', price), hs = headroom(inst, 'short', price);
    if (hl < need || hs < need) { list.push({ sym, why: `OI 余量不够 多 $${hl.toFixed(0)} 空 $${hs.toFixed(0)}` }); continue; }
    const est = roundEstimate({ inst, price, plan, rate, feeBps });
    list.push({ sym, inst, price, plan, est, first: hl <= hs ? 'long' : 'short' });
  }
  const ok = list.filter((c) => c.est).sort((a, b) => a.est.costPer1000 - b.est.costPer1000);
  return { best: ok[0] ?? null, list };
}

// "直接亏着挖"的每枚成本（给页面对比用）：亏 1 块铸 0.98×rate 枚
export const directPerPaper = (rate) => 1 / (0.98 * rate);
