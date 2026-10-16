// session key 私钥加密存储（AES-256-GCM）、JWT（HS256）、随机 id
import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { CFG } from './config.mjs';

const key = () => Buffer.from(CFG.keySecret, 'hex');

export function encrypt(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

const b64u = (b) => Buffer.from(b).toString('base64url');
export function signJwt(payload, ttlSec = 7 * 86400) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const s = createHmac('sha256', CFG.jwtSecret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
export function verifyJwt(token) {
  const [h, p, s] = String(token || '').split('.');
  if (!h || !p || !s) return null;
  const expect = createHmac('sha256', CFG.jwtSecret).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return null;
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp < Date.now() / 1000) return null;
  return payload;
}
export const randomId = (n = 16) => randomBytes(n).toString('hex');
