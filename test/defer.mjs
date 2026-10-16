// 离线验证"浏览器签名"机制：服务端先算好 EIP-712 内容，等签名回来再组装 intent（不联网、不提交）
// 跑法：cd paper-farm && node --no-warnings test/defer.mjs
process.env.KEY_SECRET = 'ab'.repeat(32); process.env.JWT_SECRET = 'test-secret-1234567890'; process.env.TREASURY = '0x' + '1'.repeat(40); process.env.DB_PATH = './data/test2.db';
const sdk = await import('papertrade-sdk');
const DB = await import('../server/db.mjs');
const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
class DeferredSigner { constructor(address) { this.address = address; this.pending = null; this.ready = new Promise((r) => { this._ready = r; }); } signTypedData(args) { return new Promise((resolve, reject) => { this.pending = { args, resolve, reject }; this._ready(); }); } }
const acct = privateKeyToAccount(generatePrivateKey());   // 一次性测试钱包
const signer = new DeferredSigner(acct.address);
const trader = new sdk.PapertradeTrader({ user: acct.address, wallet: signer, nonceStorage: DB.nonceStorage });
const session = sdk.createSessionKey(86400);
const p = trader.prepareRegisterSession(session); p.catch(() => {});
await Promise.race([signer.ready, p]);
const { domain, types, primaryType, message } = signer.pending.args;
console.log('domain', domain, '\nprimaryType', primaryType, '\ntypes', Object.keys(types), '\nmessage keys', Object.keys(message));
const sig = await acct.signTypedData({ domain, types, primaryType, message });   // 模拟浏览器钱包签名
signer.pending.resolve(sig);
const { prepared } = await p;
console.log('intentId', prepared.intentId, '\nsigner', prepared.signer, '\nsummary', prepared.summary);
if (prepared.signer.toLowerCase() !== acct.address.toLowerCase()) throw new Error('signer mismatch');
console.log('deferred signing OK');
