// 管理员命令行（在服务器上用）：
//   node server/admin.mjs status [wallet]                     看全站 / 某用户
//   node server/admin.mjs session <wallet> <sessPriv> <expiry> 手动导入一个已经注册好的 session key（测试用；网站上线后用户在页面授权）
//   node server/admin.mjs prepay <wallet> <usdc> [txHash]     手动给用户记一笔预付
//   node server/admin.mjs start <wallet> <budgetUsd> [paramsJson]   启动策略
//   node server/admin.mjs stop <wallet> [soft]                停止（soft = 这轮平完再停；默认马上全平）
//   node server/admin.mjs stop-all on|off                     全站停开新仓
//   node server/admin.mjs baseline-reset                      确认协议参数改动无害后重记基线
//   node server/admin.mjs events <wallet> [n]                 看日志
import { requireSecrets, CFG } from './config.mjs';
import * as DB from './db.mjs';
import { encrypt } from './crypto.mjs';
import { randomId } from './crypto.mjs';
import { normalizeParams } from './strategy.mjs';
import { refreshProtocol, resetBaseline, S, mintRate } from './shared.mjs';

requireSecrets();
const [cmd, ...args] = process.argv.slice(2);
const w = (args[0] || '').toLowerCase();
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

switch (cmd) {
  case 'status': {
    await refreshProtocol(true);
    out(`铸币率 ${mintRate().toFixed(2)}/$  halt=${S.halt ?? '无'}  dip=${S.dip}`);
    const list = w ? [DB.getStrategy(w)].filter(Boolean) : DB.allStrategies();
    for (const s of list) out({ wallet: s.wallet, status: s.status, note: s.note, budget: s.budget_usd, spent: s.spent_usd, paper: s.paper, rounds: s.rounds, params: s.params, fee: DB.feeAccount(s.wallet), session: DB.getSession(s.wallet)?.state });
    if (!list.length) out('没有策略');
    break;
  }
  case 'session': {
    const [, priv, expiry] = args;
    if (!/^0x[0-9a-fA-F]{64}$/.test(priv || '')) throw new Error('sessPriv 要 0x 开头 64 位十六进制');
    const { privateKeyToAccount } = await import('viem/accounts');
    const address = privateKeyToAccount(priv).address;
    DB.touchUser(w);
    DB.putSession(w, { address, encPriv: encrypt(priv), expiry: Number(expiry), state: 'active' });
    out(`已导入 session ${address}，到期 ${new Date(Number(expiry) * 1000).toISOString()}`);
    break;
  }
  case 'prepay': {
    const r = DB.feePrepay(w, Number(args[1]), args[2] ?? `manual-${randomId(6)}`, 'admin');
    out(r);
    break;
  }
  case 'start': {
    const budget = Number(args[1]);
    if (!(budget > 0) || budget > CFG.maxBudgetUsd) throw new Error(`预算要在 0–${CFG.maxBudgetUsd}`);
    const params = normalizeParams(args[2] ? JSON.parse(args[2]) : {});
    const need = DB.feeRequired(budget), fee = DB.feeAccount(w);
    if (fee.balance < need) throw new Error(`服务费余额 $${fee.balance.toFixed(2)} < 需要 $${need.toFixed(2)}（预算 $${budget} × ${CFG.feeBps / 100}%，最低 $${CFG.feeMinUsdc}）`);
    const periodId = randomId(8);
    DB.touchUser(w); DB.startStrategy(w, params, budget, periodId); DB.feeStartPeriod(w, periodId);
    DB.addEvent(w, 'info', 'admin', `管理员启动策略 预算 $${budget}`, params);
    out({ started: true, params, budget, periodId });
    break;
  }
  case 'stop': { DB.setStrategyStatus(w, args[1] === 'soft' ? 'stopping_soft' : 'stopping', '管理员停止'); out('已下达停止'); break; }
  case 'stop-all': { DB.kvSet('stopAll', args[0] === 'on'); out(`全站停开新仓 = ${args[0] === 'on'}`); break; }
  case 'baseline-reset': { await refreshProtocol(true); resetBaseline(); out('基线已重记'); break; }
  case 'events': { for (const e of DB.listEvents(w, 0, Number(args[1] ?? 50)).reverse()) out(`${new Date(e.created_at).toISOString()} [${e.level}] ${e.msg}`); break; }
  default: out('用法见文件头注释');
}
