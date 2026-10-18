// 全站配置：改 .env 或环境变量，不改代码
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 简单 .env 加载（不依赖 dotenv）
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);

export const CFG = {
  port: num('PORT', 8787),
  dbPath: process.env.DB_PATH || './data/farm.db',
  keySecret: process.env.KEY_SECRET || '',          // 64 位十六进制（32 字节），加密 session key 用。生成：openssl rand -hex 32
  jwtSecret: process.env.JWT_SECRET || '',          // 任意长随机串
  // 服务费：净已实现亏损的 feeBps/10000，预付，每次付款最低 feeMinUsdc
  feeBps: num('FEE_BPS', 300),
  feeMinUsdc: num('FEE_MIN_USDC', 1),
  treasury: (process.env.TREASURY || '').toLowerCase(), // 收 USDC 的 HyperEVM 地址
  rpcUrl: process.env.RPC_URL || 'https://rpc.hyperliquid.xyz/evm',
  markets: (process.env.MARKETS || 'BTC,ETH').split(',').map((s) => s.trim().toUpperCase()),
  // 交易循环
  pollSec: num('POLL_SEC', 4),
  intentTimeoutSec: num('INTENT_TIMEOUT_SEC', 180),
  cooldownSec: num('COOLDOWN_SEC', 20),
  emergencyFrac: num('EMERGENCY_FRAC', 0.6),
  minBustPct: num('MIN_BUST_PCT', 0.006),   // 杠杆安全上限：强平距离至少 0.6%（≈155x）

  minHeadroomUsd: num('MIN_HEADROOM_USD', 5000),
  dipLpThresholdUsd: num('DIP_LP_THRESHOLD_USD', 2_000_000),
  maxBudgetUsd: num('MAX_BUDGET_USD', 20000),
  sessionTtlDays: [1, 3, 7],
  // 用户参数的默认值 / 预设
  presets: {
    lowcost: { label: '低成本', market: 'auto', leverage: 'max', targetPct: 0.005, marginPerLeg: 0 },
    fast: { label: '快速', market: 'auto', leverage: 'max', targetPct: 0.003, marginPerLeg: 0 },
  },
  telegram: { token: process.env.TG_TOKEN || '', chatId: process.env.TG_CHAT || '' },
};

export function requireSecrets() {
  const miss = [];
  if (!/^[0-9a-fA-F]{64}$/.test(CFG.keySecret)) miss.push('KEY_SECRET（64 位十六进制）');
  if (CFG.jwtSecret.length < 16) miss.push('JWT_SECRET（≥16 位）');
  if (!/^0x[0-9a-f]{40}$/.test(CFG.treasury)) miss.push('TREASURY（收款地址）');
  if (miss.length) throw new Error('缺少环境变量: ' + miss.join(', ') + '。复制 .env.example 为 .env 填好再启动');
}
