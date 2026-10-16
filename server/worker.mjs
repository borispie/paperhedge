// 跑所有用户策略的常驻进程：从数据库读状态，起/停 Farmer。API 只改数据库，不直接碰交易。
import { CFG, requireSecrets } from './config.mjs';
import * as DB from './db.mjs';
import { S, refreshProtocol, mintRate } from './shared.mjs';
import { Farmer } from './farmer.mjs';
import { tg, tgEnabled } from './notify.mjs';

requireSecrets();
const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z', '[worker]', ...a);
const farmers = new Map(); // wallet -> Farmer
const ACTIVE = new Set(['running', 'stopping', 'stopping_soft']);

async function reconcile() {
  const strategies = DB.allStrategies();
  const want = new Set(strategies.filter((s) => ACTIVE.has(s.status)).map((s) => s.wallet));
  // 该停的停
  for (const [wallet, f] of farmers) {
    if (!want.has(wallet) || !f.running) {
      if (f.running) { log('停止', wallet.slice(0, 8)); await f.stop(); }
      farmers.delete(wallet);
    }
  }
  // 该起的起
  for (const wallet of want) {
    if (farmers.has(wallet)) continue;
    const f = new Farmer(wallet);
    farmers.set(wallet, f);
    try { await f.start(); log('启动', wallet.slice(0, 8)); }
    catch (e) {
      farmers.delete(wallet);
      const st = DB.getStrategy(wallet);
      if (st && ACTIVE.has(st.status)) { DB.setStrategyStatus(wallet, 'halted_session', e.message); DB.addEvent(wallet, 'error', 'start', '启动失败: ' + e.message); log('启动失败', wallet.slice(0, 8), e.message); }
    }
  }
}

async function main() {
  log(`启动 paper-farm worker：币种 ${CFG.markets.join('/')} 服务费 ${CFG.feeBps / 100}% 最低 $${CFG.feeMinUsdc}`);
  await refreshProtocol(true);
  log(`铸币率 ${mintRate().toFixed(2)}/$  halt=${S.halt ?? '无'}  telegram=${tgEnabled() ? '开' : '关'}`);
  tg(`⚙️ worker 启动 铸币率 ${mintRate().toFixed(2)}/$，${farmers.size} 个策略`);
  let lastPrune = 0, lastHalt = S.halt, lastDaily = new Date().getUTCDate(), protoFails = 0;
  for (;;) {
    try { await reconcile(); } catch (e) { log('reconcile 出错:', e.message); }
    try { await refreshProtocol(); protoFails = 0; } catch (e) { log('协议读数失败:', e.message); if (++protoFails === 6) tg('🔴 连续 1 分钟读不到 Papertrade 协议状态: ' + e.message); }
    if (S.halt !== lastHalt) { tg(S.halt ? `🟠 全站停开新仓: ${S.halt}` : '🟢 全站恢复开仓'); lastHalt = S.halt; }
    if (new Date().getUTCDate() !== lastDaily && new Date().getUTCHours() >= 12) { lastDaily = new Date().getUTCDate(); const g = DB.globalStats(86400e3); tg(`📊 过去 24h：${g.users} 个用户 ${g.rounds} 轮，花 $${g.cost.toFixed(2)} 铸 ${g.paper.toFixed(0)} PAPER，服务费 $${g.fee.toFixed(2)}；${farmers.size} 个策略在跑，铸币率 ${mintRate().toFixed(2)}/$`); }
    if (Date.now() - lastPrune > 3600_000) { lastPrune = Date.now(); DB.pruneEvents(7 * 86400e3); }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
process.on('SIGINT', async () => { log('收到 SIGINT，停止所有 farmer（仓位保留，重启后自动接管）'); for (const f of farmers.values()) await f.stop(); process.exit(0); });
process.on('SIGTERM', async () => { for (const f of farmers.values()) await f.stop(); process.exit(0); });
main().catch((e) => { log('致命错误:', e); process.exit(1); });
