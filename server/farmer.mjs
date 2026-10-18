// 一个用户一个 Farmer：用他授权的 session key 在他的 Papertrade 账户里跑多空对冲。
// 逻辑来自跑通的 pt-bot v2：开两腿 → ±target 一起平 → 记账 → 收服务费 → 歇 20 秒 → 再开。
import {
  PapertradeTrader, PapertradeApiError, streamWallet, fetchWalletState, restoreSessionKey, isSessionKeyActive,
  priceFromRaw, priceToRaw, wadToNumber,
} from 'papertrade-sdk';
import { CFG } from './config.mjs';
import { decrypt } from './crypto.mjs';
import * as DB from './db.mjs';
import { S, client, refreshProtocol, getPrice, mintRate, headroomUsd } from './shared.mjs';
import { candidates, normalizeParams } from './strategy.mjs';
import { tg } from './notify.mjs';

const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));

export class Farmer {
  constructor(wallet) {
    this.wallet = wallet.toLowerCase();
    this.W = null; this.trader = null; this.stopStream = null;
    this.running = false; this.loopPromise = null;
    this.roundState = 'idle'; this.pairIds = null; this.equityBefore = null; this.lastReason = null; this.unsettled = null; this.lastTick = now(); this.lastLogAt = 0;
    this.streamStatus = 'init';
  }

  log(level, kind, msg, data) {
    console.log(new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z', this.wallet.slice(0, 8), msg);
    DB.addEvent(this.wallet, level, kind, msg, data);
    if (level === 'error' || (level === 'warn' && !['stream', 'resync', 'gap'].includes(kind)) || ['round', 'stop', 'start', 'single'].includes(kind)) tg(`${level === 'error' ? '🔴' : level === 'warn' ? '🟠' : '🟢'} ${this.wallet.slice(0, 6)}… ${msg}`);
  }
  strategy() { return DB.getStrategy(this.wallet); }
  params() { return normalizeParams(this.strategy()?.params); }

  // ---------- 生命周期 ----------
  async start() {
    const sess = DB.getSession(this.wallet);
    if (!sess || sess.state !== 'active') throw new Error('没有有效的交易授权');
    const session = restoreSessionKey(decrypt(sess.enc_priv), BigInt(sess.expiry));
    this.trader = new PapertradeTrader({ user: this.wallet, session, client, nonceStorage: DB.nonceStorage });
    await refreshProtocol();
    this.stopStream = streamWallet({
      wallet: this.wallet,
      onState: (s) => { this.W = s; },
      onStatus: (s, d) => { if (s !== this.streamStatus) { this.streamStatus = s; if (s !== 'live') this.log('warn', 'stream', `钱包流: ${s} ${d ?? ''}`); } },
    });
    for (let i = 0; i < 60 && !this.W; i++) await sleep(500);
    if (!this.W) await this.resync();
    if (!this.W) throw new Error('拿不到钱包状态');
    if (!isSessionKeyActive(this.W.sessionKeys, session.account.address)) { DB.setSessionState(this.wallet, 'expired'); throw new Error('交易授权未生效或已过期'); }
    this.running = true;
    this.loopPromise = this.loop();
    this.log('info', 'start', `策略启动: ${JSON.stringify(this.params())}`);
  }
  async stop() {
    this.running = false;
    try { this.stopStream?.(); } catch {}
    await this.loopPromise?.catch(() => {});
  }

  // ---------- 钱包状态 ----------
  async resync() { try { this.W = await fetchWalletState(this.wallet, { timeoutMs: 15000 }); } catch (e) { this.log('warn', 'resync', '重新同步失败: ' + e.message); } }
  positions() { return (this.W?.positions ?? []).filter((p) => S.instById[p.instrumentId]); }
  pendingOps() { return (this.W?.operations ?? []).filter((o) => o.state === 'queued'); }
  equity() { return wadToNumber(this.W.balance); }
  avail() { return wadToNumber(this.W.funds.availableBalance); }

  // ---------- 决策：开不开新对子 ----------
  async decide() {
    const st = this.strategy();
    if (!st || st.status !== 'running') return { reason: '策略未在运行' };
    if (S.halt) return { reason: S.halt };
    const budget = st.budget_usd * (S.dip && this.params().dipBoost ? 3 : 1);
    if (st.spent_usd >= budget) return { reason: `预算已用完 $${n2(st.spent_usd)} / $${n2(st.budget_usd)}`, done: 'done_budget' };
    const fee = DB.feeAccount(this.wallet);
    if (CFG.feeBps > 0 && fee.balance <= 0) return { reason: `服务费余额 $${n2(fee.balance)} 不足，请预付`, done: 'halted_fee' };
    const params = this.params();
    const syms = params.market === 'auto' ? Object.keys(S.insts) : [params.market];
    const prices = {};
    for (const sym of syms) if (S.insts[sym]) prices[sym] = await getPrice(sym);
    const { best, list } = candidates({ insts: S.insts, trading: S.trading, prices, avail: this.avail(), params, rate: mintRate(), feeBps: CFG.feeBps, emergencyFrac: CFG.emergencyFrac, minBustPct: CFG.minBustPct, minHeadroomUsd: CFG.minHeadroomUsd, headroom: headroomUsd });
    if (!best) return { reason: '没有能开的币: ' + list.map((c) => `${c.sym} ${c.why}`).join('; ') };
    return { choice: best };
  }

  // ---------- 交易 ----------
  async waitFor(pred, timeoutMs, label) { const t0 = now(); while (now() - t0 < timeoutMs) { if (pred()) return true; await sleep(2000); } this.log('warn', 'timeout', `等待超时: ${label}`); return false; }
  async openLeg(c, side, price) {
    const inst = c.inst;
    const count = () => this.positions().filter((p) => p.instrumentId === inst.id && p.isLong === (side === 'long')).length;
    const before = count();
    let margin = c.plan.m;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        if (attempt) price = await getPrice(inst.symbol);
        const sent = await this.trader.openPosition({ market: inst.symbol, side, marginUsd: String(margin), leverage: c.plan.L, markPriceRaw: priceToRaw(price, inst.priceScale) });
        this.log('info', 'open', `${inst.symbol} 开${side === 'long' ? '多' : '空'} $${margin}×${c.plan.L}x 已提交 ${sent.receipt.intentId.slice(0, 12)}… ${sent.receipt.state}`);
        if (await this.waitFor(() => count() > before, CFG.intentTimeoutSec * 1000, `开${side}`)) return true;
        try { await this.trader.cancel(sent.receipt.intentId); this.log('warn', 'open', '已取消超时的开仓意图'); } catch (e) { this.log('warn', 'open', '取消失败(可能已执行): ' + e.message); }
        await sleep(5000); await this.resync();
        return count() > before;
      } catch (e) {
        if (e instanceof PapertradeApiError && e.reason === 'belowMinimumNotional' && attempt === 0) { margin = margin + 1; continue; }
        const oiCap = /open ?interest|cap/i.test(String(e.message) + String(e.reason ?? ''));
        if (oiCap && attempt < 3) { this.log('warn', 'open', `开${side}被 OI 上限挡住，5 秒后重试 (${attempt + 1}/3): ${e.message}`); await sleep(5000); continue; }
        this.log('error', 'open', `开${side}失败: ${e.message} ${e.reason ?? ''}`);
        return false;
      }
    }
    return false;
  }
  async closeIds(ids, label) {
    await this.resync();
    const open = new Set(this.positions().map((p) => String(p.positionId)));
    const live = ids.filter((id) => open.has(String(id))), gone = ids.filter((id) => !open.has(String(id)));
    if (gone.length) this.log('warn', 'close', `这些仓位已经不在了(可能被强平): ${gone.join(',')}`);
    if (!live.length) return true;
    const idSet = new Set(live.map(String));
    const stillOpen = () => this.positions().some((p) => idSet.has(String(p.positionId)));
    // 平仓意图可能排队很久甚至丢掉；没平掉就重新提交，最多 3 次，别让单腿裸奔
    for (let attempt = 0; attempt < 3; attempt++) {
      const pendingClose = this.pendingOps().some((o) => o.action === 'closePositions');
      if (!pendingClose || attempt === 0) {
        try {
          const sent = await this.trader.closePositions(live);
          this.log('info', 'close', `平仓已提交 (${label}${attempt ? ` 第${attempt + 1}次` : ''}) ${sent.map((s) => s.receipt.intentId.slice(0, 12)).join(',')}…`);
        } catch (e) {
          this.log('error', 'close', `平仓提交失败: ${e.message} ${e.reason ?? ''}`);
          await this.resync();
          if (e.reason === 'noOpenPositions' || !stillOpen()) return !stillOpen();
          await sleep(5000); continue;
        }
      } else this.log('warn', 'close', '上一笔平仓还在排队，继续等');
      const ok = await this.waitFor(() => !stillOpen(), CFG.intentTimeoutSec * 1000, '平仓');
      await this.resync();
      if (ok || !stillOpen()) return true;
    }
    return !stillOpen();
  }
  async closeAll(label = 'close-all') { await this.resync(); const ids = this.positions().map((p) => p.positionId); return ids.length ? this.closeIds(ids, label) : true; }

  // ---------- 记账 + 服务费 ----------
  async recordRound(ids, equityBefore, sym) {
    await sleep(4000); await this.resync();
    let rows = [];
    try { const page = await client.accountTrades(this.wallet); rows = (page.items ?? []).filter((t) => ids.map(String).includes(String(t.positionId))); } catch (e) { this.log('warn', 'record', '读成交记录失败: ' + e.message); }
    let paper = 0, pnlSum = 0; const detail = [];
    for (const t of rows) {
      const inst = S.instById[t.instrumentId] ?? S.insts[sym];
      const pnl = wadToNumber(t.adjustedPnlRaw) - wadToNumber(t.userPaidFeeRaw ?? '0');
      pnlSum += pnl; paper += wadToNumber(t.paperMintedRaw);
      detail.push(`${t.isLong ? '多' : '空'} 入 ${priceFromRaw(t.entryPriceRaw, inst.priceScale)} 出 ${priceFromRaw(t.exitPriceRaw, inst.priceScale)} 净 ${n2(pnl)} PAPER ${wadToNumber(t.paperMintedRaw).toFixed(1)}${t.kind === 'Liquidated' ? ' 强平!' : ''}`);
    }
    const cost = Number.isFinite(equityBefore) && rows.length ? equityBefore - this.equity() : -pnlSum;
    const st = this.strategy();
    const fee = DB.feeSettleRound(this.wallet, st?.period_id ?? 'none', cost);
    DB.addRound(this.wallet, { market: sym, ids, cost, paper, fee: fee.delta, detail: detail.join('; ') });
    const after = this.strategy();
    this.log('info', 'round', `第 ${after.rounds} 轮完成(${sym}): 成本 $${n2(cost)} 铸 ${paper.toFixed(0)} PAPER，服务费 ${fee.delta >= 0 ? '+' : ''}$${n2(fee.delta)}（余额 $${n2(fee.balance)}），累计 $${n2(after.spent_usd)} / ${after.paper.toFixed(0)} PAPER`, { cost, paper, detail, fee });
    if (CFG.feeBps > 0 && fee.balance < 0) { this.log('warn', 'fee', `服务费余额 $${n2(fee.balance)} 为负：全平并暂停，预付后可继续`); await this.closeAll('fee-exhausted'); DB.setStrategyStatus(this.wallet, 'halted_fee', '服务费余额不足'); }
  }

  // ---------- 主循环 ----------
  async loop() {
    while (this.running) {
      try { await this.tick(); } catch (e) { this.log('error', 'loop', '循环出错: ' + (e.message ?? e)); await sleep(10000); }
      await sleep(CFG.pollSec * 1000);
    }
  }
  async tick() {
    if (now() - this.lastTick > 120_000) { this.log('warn', 'gap', `检测到停顿 ${Math.round((now() - this.lastTick) / 60000)} 分钟，重新同步`); await this.resync(); }
    this.lastTick = now();
    await refreshProtocol();
    if (!this.W) { await this.resync(); if (!this.W) return; }
    const st = this.strategy();
    if (!st) { this.running = false; return; }
    const pos = this.positions();
    if (this.unsettled && !pos.some((p) => this.unsettled.ids.map(String).includes(String(p.positionId)))) {
      // 之前没平掉的单腿已经不在了（多半是被强平）：把它的亏损和铸出的 PAPER 记进账
      const u = this.unsettled; this.unsettled = null;
      this.log('warn', 'single', `单腿 #${u.ids.join(',')} 已经没了（可能被强平），记一笔`);
      await this.recordRound(u.ids, NaN, u.sym);
    }
    if (st.status === 'stopping') { this.log('info', 'stop', '收到停止指令：全平'); await this.closeAll('stop'); DB.setStrategyStatus(this.wallet, 'stopped', '已手动停止并全平'); this.running = false; return; }

    if (pos.length) {
      const inst = S.instById[pos[0].instrumentId], sym = inst.symbol;
      const price = await getPrice(sym);
      const longs = pos.filter((p) => p.instrumentId === inst.id && p.isLong), shorts = pos.filter((p) => p.instrumentId === inst.id && !p.isLong);
      if (longs.length && shorts.length) {
        const L = longs[0], Sh = shorts[0];
        const eL = priceFromRaw(L.entryPriceRaw, inst.priceScale), eS = priceFromRaw(Sh.entryPriceRaw, inst.priceScale), mid = (eL + eS) / 2;
        const bustL = priceFromRaw(L.bustPriceRaw, inst.priceScale), bustS = priceFromRaw(Sh.bustPriceRaw, inst.priceScale);
        const bustDist = Math.min((eL - bustL) / eL, (bustS - eS) / eS);
        const target = Math.min(this.params().targetPct, Math.floor((CFG.emergencyFrac * bustDist - 0.0005) * 10000) / 10000);
        const up = mid * (1 + target), down = mid * (1 - target), emUp = mid * (1 + bustDist * CFG.emergencyFrac), emDown = mid * (1 - bustDist * CFG.emergencyFrac);
        this.pairIds = [L.positionId, Sh.positionId];
        if (this.roundState !== 'paired') { this.roundState = 'paired'; this.log('info', 'paired', `${sym} 配对: 多@${eL} 空@${eS} 均价 ${n2(mid)} 目标 ±${(target * 100).toFixed(2)}% 平仓 上 ${n2(up)} / 下 ${n2(down)} 紧急 ${n2(emUp)} / ${n2(emDown)}`, { up, down, emUp, emDown, bustL, bustS }); }
        const hit = price >= up || price <= down, emergency = price >= emUp || price <= emDown;
        if (hit || emergency) {
          this.log('info', 'hit', `${emergency ? '紧急线' : '到价'} ${price} → 两边一起平`);
          if (await this.closeIds(this.pairIds, emergency ? 'emergency' : 'target')) {
            await this.recordRound(this.pairIds, this.equityBefore, sym);
            this.roundState = 'idle'; this.pairIds = null; this.equityBefore = null;
            if (st.status === 'stopping_soft') { DB.setStrategyStatus(this.wallet, 'stopped', '本轮平完后停止'); this.running = false; return; }
            await sleep(CFG.cooldownSec * 1000);
          } else { this.log('warn', 'close', '平仓没成功，30 秒后再试'); await sleep(30000); }
        } else if (now() - this.lastLogAt > 300_000) { this.lastLogAt = now(); this.log('debug', 'watch', `${sym} 盯盘 ${price} (上 ${n2(up)} 下 ${n2(down)})`); }
      } else if (this.roundState !== 'opening') {
        this.log('warn', 'single', `${sym} 只剩一条腿 #${pos[0].positionId}，马上平掉`);
        const roundIds = [...new Set([...(this.pairIds ?? []), ...(this.unsettled?.ids ?? []), pos[0].positionId].map(String))];
        if (await this.closeIds([pos[0].positionId], 'single-leg')) { await this.recordRound(roundIds, NaN, sym); this.unsettled = null; }
        else this.unsettled = { ids: roundIds, sym };
        this.roundState = 'idle'; this.pairIds = null; this.equityBefore = null;
      }
      return;
    }
    if (this.pendingOps().some((o) => o.action === 'openPosition' || o.action === 'closePositions')) return; // 有排队中的意图，等它落地
    if (st.status === 'stopping_soft') { DB.setStrategyStatus(this.wallet, 'stopped', '已停止'); this.running = false; return; }

    this.roundState = 'idle';
    const d = await this.decide();
    if (d.reason) {
      if (d.done) { DB.setStrategyStatus(this.wallet, d.done, d.reason); this.log('info', 'stop', '策略结束: ' + d.reason); this.running = false; return; }
      // 用户要求：钱用完就停，不等充值（params.stopOnEmpty）
      if (this.params().stopOnEmpty && /低于最小保证金/.test(d.reason)) { DB.setStrategyStatus(this.wallet, 'stopped', '资金用完，按要求停止：' + d.reason); this.log('info', 'stop', '资金用完，按要求停止，不再等充值'); this.running = false; return; }
      if (d.reason !== this.lastReason || now() - this.lastLogAt > 600_000) { this.lastLogAt = now(); this.log('info', 'wait', '不开新对子: ' + d.reason); }
      if (d.reason !== this.lastReason) DB.setStrategyStatus(this.wallet, st.status, '等开仓：' + d.reason); // 让页面顶部直接看到原因
      this.lastReason = d.reason; await sleep(16000); return;
    }
    if (this.lastReason !== null || st.note) DB.setStrategyStatus(this.wallet, st.status, null);
    this.lastReason = null;
    const c = d.choice, second = c.first === 'long' ? 'short' : 'long';
    this.roundState = 'opening'; this.equityBefore = this.equity();
    this.log('info', 'new', `开新对子 ${c.sym} @${c.price}: 每边 $${c.plan.m}×${c.plan.L}x 目标 ±${(c.plan.target * 100).toFixed(2)}% 预计成本 $${n2(c.est.cost)}+费 $${n2(c.est.fee)} 铸 ${c.est.paper.toFixed(0)} ($${n2(c.est.costPer1000WithFee)}/1000)${S.dip ? ' [抄底]' : ''}; 先 ${c.first} 后 ${second}`, { plan: c.plan, est: c.est });
    if (!(await this.openLeg(c, c.first, c.price))) { this.log('warn', 'open', '第一条腿没开成，这轮放弃'); this.roundState = 'idle'; await sleep(30000); return; }
    if (!(await this.openLeg(c, second, await getPrice(c.sym)))) {
      this.log('warn', 'open', '第二条腿没开成，马上平第一条');
      const solo = this.positions(), soloIds = solo.map((p) => p.positionId);
      if (solo.length) {
        if (await this.closeIds(soloIds, 'leg2-failed')) await this.recordRound(soloIds, this.equityBefore, c.sym);
        else { this.log('error', 'close', `单腿 #${soloIds.join(',')} 还没平掉，下一轮继续平`); this.unsettled = { ids: soloIds, sym: c.sym }; }
      }
      this.roundState = 'idle'; this.equityBefore = null; await sleep(10000); return;
    }
    this.roundState = 'paired-pending';
  }
}
