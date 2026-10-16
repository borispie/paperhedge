// Telegram 通知：.env 里填 TG_TOKEN / TG_CHAT 就生效；没填就只写日志。
import { CFG } from './config.mjs';

const queue = [];
let timer = null;
export function tg(text) {
  if (!CFG.telegram.token || !CFG.telegram.chatId) return;
  queue.push(text);
  if (!timer) timer = setTimeout(flush, 1500);          // 1.5 秒内的消息合并成一条，避免刷屏
}
async function flush() {
  timer = null;
  const text = queue.splice(0, 30).join('\n\n').slice(0, 3900);
  if (!text) return;
  try {
    await fetch(`https://api.telegram.org/bot${CFG.telegram.token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CFG.telegram.chatId, text, disable_web_page_preview: true }),
    });
  } catch (e) { console.log('telegram 发送失败:', e.message); }
  if (queue.length) timer = setTimeout(flush, 1500);
}
export const tgEnabled = () => Boolean(CFG.telegram.token && CFG.telegram.chatId);
