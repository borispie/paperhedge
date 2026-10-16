# PaperHedge — 对冲挖 PAPER，服务器托管，开源

线上：https://paperhedge.xyz · 白皮书（中/EN）：https://paperhedge.xyz/whitepaper.html · 安全说明：https://paperhedge.xyz/security.html · MIT 协议

**权限边界**：用户只签 Papertrade 的 `RegisterSessionKey`，授权一把服务器生成的交易密钥；密钥只能开仓/平仓，不能提现、转账、质押。钱包私钥从不经过本站。交易逻辑在 `server/farmer.mjs`，签名流程在 `server/api.mjs`，自己看。

一个网页 + 两个 Node 进程：
- `server/worker.mjs`：常驻，替每个授权用户跑多空对冲（逻辑来自跑通的 pt-bot v2）。
- `server/api.mjs`：网页 + 接口（登录、授权、预付服务费、开/停、账单、一键质押/领分红）。
- `web/index.html`：页面（纯静态，api 直接托管，也可以丢到 Cloudflare Pages）。
- 数据：SQLite 文件 `data/farm.db`（Node 22.5+ 自带，不用装东西）。

服务费：**策略净已实现亏损的 3%**（`.env` 里 `FEE_BPS=300`），预付、每次最低 1 USDC。机制和 Barker 一样：开跑前预付 预算 × 3%，每轮平仓按本期净亏损结算，赢的退、亏的补，余额 ≤ 0 全平停止。用户把 USDC 转到 `TREASURY` 地址，网页自动登记交易哈希。

## 一、本地先跑通（Mac，用你自己的账户）
```bash
cd paper-farm
npm install                         # 装 papertrade-sdk + viem（第一次会问是否允许 build 脚本：npm install-scripts approve papertrade-sdk && npm install）
cp .env.example .env
openssl rand -hex 32                # 填进 .env 的 KEY_SECRET
openssl rand -hex 24                # 填进 JWT_SECRET
#   TREASURY= 你收服务费的地址（可以先填自己钱包）

# 离线自测（不联网、不下单）
node --no-warnings test/offline.mjs
node --no-warnings test/defer.mjs

# 用 pt-bot 的 session key 导入（先不用网页授权流程也能测 worker）
#   .session.json 里有 privateKey 和 expiry
node --no-warnings server/admin.mjs session 0x你的钱包 0xsession私钥 到期秒数
node --no-warnings server/admin.mjs prepay 0x你的钱包 3            # 手动记 $3 预付（测试）
node --no-warnings server/admin.mjs start 0x你的钱包 20 '{"targetPct":0.003,"leverage":100}'
node --no-warnings server/worker.mjs                              # 另一个窗口：看它接管 / 开仓 / 平仓 / 记账 / 收费
node --no-warnings server/admin.mjs status
node --no-warnings server/admin.mjs stop 0x你的钱包               # 全平停止

# 网页
node --no-warnings server/api.mjs      # 打开 http://localhost:8787
```
注意：worker 和 pt-bot 别同时跑同一个账户（两个程序会抢着开平仓）。

## 二、上服务器（任意 $6 的 VPS，Ubuntu）
```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs
sudo npm i -g pm2
git clone <你的仓库> paper-farm && cd paper-farm && npm install
cp .env.example .env && nano .env     # 填 KEY_SECRET / JWT_SECRET / TREASURY / CORS_ORIGIN
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```
- 域名：Cloudflare 加 A 记录指到 VPS，开"代理"（橙云）就有 https；Caddy 一行反代 `:8787` 也行。
- 页面想放 Cloudflare Pages：上传 `web/`，在 `index.html` 最前面加 `<script>window.PF_API='https://api.你的域名'</script>`，`.env` 里 `CORS_ORIGIN=https://你的域名`。
- Telegram 告警：`.env` 填 `TG_TOKEN` / `TG_CHAT`，出错 / 全站暂停 / 每轮结果 / 每日汇总会推到手机。

## 三、接口
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/market | 铸币率、池子、各币价格和 OI 余量、服务费配置、限制、预设 |
| POST | /api/estimate | {avail, budgetUsd, params} → 方案、每轮成本、每枚成本（含费）、预算能换多少 |
| GET | /api/auth/nonce?wallet= | 登录消息 |
| POST | /api/auth/verify | {wallet, signature} → JWT |
| GET | /api/me | 余额、PAPER、待领分红、持仓、授权状态、策略、服务费账户、统计 |
| POST | /api/session/prepare | {ttlDays} → 待签的 RegisterSessionKey（EIP-712） |
| POST | /api/session/submit | {requestId, signature} → 提交到 relayer |
| POST | /api/wallet/prepare | {action: stake/unstake/claim, amount} → 待签 |
| POST | /api/wallet/submit | {requestId, signature} |
| GET | /api/fee | 服务费账户 + 流水 |
| POST | /api/fee/register | {txHash} 查链确认 USDC 转账后记账 |
| POST | /api/strategy/start | {budgetUsd, params} |
| POST | /api/strategy/stop | {mode: now/soft} |
| POST | /api/strategy/params | 改参数（跑着也能改） |
| POST | /api/strategy/resume | 预付后恢复 |
| GET | /api/events?after=&limit= | 日志 |
| GET | /api/rounds | 每轮记录 |

用户参数 `params`：`market` auto/BTC/ETH，`leverage` "max" 或数字，`targetPct` 0.001–0.05，`marginPerLeg` 0 = 可用的一半，`dipBoost` 抄底时预算 ×3。

## 四、管理员命令
见 `server/admin.mjs` 文件头：status / session / prepay / start / stop / stop-all / baseline-reset / events。
协议参数一变 worker 会全站停开新仓（日志里 `协议参数变了`），确认无害后 `admin.mjs baseline-reset`。
