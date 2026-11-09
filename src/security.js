const encoder = new TextEncoder();
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export async function digest(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
export async function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
async function sign(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}
export async function createSession(secret, now = Date.now()) {
  const payload = `${now + 8 * 3600000}.${crypto.randomUUID()}`;
  return `${payload}.${await sign(payload, secret)}`;
}
export async function validSession(token, secret, now = Date.now()) {
  if (!secret || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || !Number.isFinite(Number(parts[0])) || Number(parts[0]) <= now || Number(parts[0]) > now + 8 * 3600000) return false;
  return safeEqual(parts[2], await sign(parts.slice(0, 2).join('.'), secret));
}
export function getCookie(request) {
  return request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('cr_session='))?.slice(11);
}
