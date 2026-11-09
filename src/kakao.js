const encoder = new TextEncoder();
function tokenKey(env) {
  if (env.TOKEN_ENCRYPTION_KEY?.length >= 32) return env.TOKEN_ENCRYPTION_KEY;
  return env.KAKAO_CLIENT_SECRET ? 'kakao-token-v1:' + env.KAKAO_CLIENT_SECRET : null;
}
export async function kakaoConfigured(env) {
  if (!env.KAKAO_REST_API_KEY || !tokenKey(env) || !env.PUBLIC_APP_URL) return false;
  if (env.KAKAO_REFRESH_TOKEN) return true;
  return !!await env.DB.prepare("SELECT 1 FROM integration_tokens WHERE provider='kakao'").first();
}
async function encryptionKey(secret) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function encode(bytes) { return btoa(String.fromCharCode(...bytes)); }
function decode(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function seal(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), encoder.encode(JSON.stringify(value)));
  return `${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
}
export async function unseal(value, secret) {
  const [iv, ciphertext] = value.split('.');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv) }, await encryptionKey(secret), decode(ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}
async function saveToken(env, token) {
  await env.DB.prepare(`INSERT INTO integration_tokens(provider,encrypted_value,updated_at) VALUES('kakao',?,?)
    ON CONFLICT(provider) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_at=excluded.updated_at`)
    .bind(await seal(token, tokenKey(env)), new Date().toISOString()).run();
}
async function refreshOrCachedToken(env) {
  const row = await env.DB.prepare("SELECT encrypted_value FROM integration_tokens WHERE provider='kakao'").first();
  let saved = row ? await unseal(row.encrypted_value, tokenKey(env)) : null;
  // Changing the bootstrap refresh secret deliberately resets the connection.
  const bootstrap = env.KAKAO_REFRESH_TOKEN ? encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(env.KAKAO_REFRESH_TOKEN)))) : null;
  if (saved && !saved.connected && saved.bootstrap !== bootstrap) saved = null;
  if (saved?.expires_at > Date.now() + 60000) return saved.access_token;
  const refresh = saved?.refresh_token || env.KAKAO_REFRESH_TOKEN;
  if (!refresh) throw new Error('카카오 계정을 연결해주세요.');
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: env.KAKAO_REST_API_KEY, refresh_token: refresh });
  if (env.KAKAO_CLIENT_SECRET) body.set('client_secret', env.KAKAO_CLIENT_SECRET);
  const response = await fetch('https://kauth.kakao.com/oauth/token', { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('카카오 인증을 다시 연결해야 합니다.');
  const token = await response.json();
  if (!token.access_token || !Number.isFinite(token.expires_in)) throw new Error('카카오 인증 응답 오류');
  await saveToken(env, { access_token: token.access_token, refresh_token: token.refresh_token || refresh,
    expires_at: Date.now() + token.expires_in * 1000, bootstrap, connected: saved?.connected === true });
  return token.access_token;
}
async function withTokenLock(env, action) {
  const owner = crypto.randomUUID(), now = Date.now();
  const lock = await env.DB.prepare(`INSERT INTO integration_locks(provider,owner,expires_at) VALUES('kakao',?,?)
    ON CONFLICT(provider) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
    WHERE integration_locks.expires_at<? RETURNING owner`).bind(owner,now+30000,now).first();
  if (!lock) throw new Error('카카오 연결 갱신 중입니다.');
  try { return await action(); }
  finally { await env.DB.prepare("DELETE FROM integration_locks WHERE provider='kakao' AND owner=?").bind(owner).run(); }
}
export function accessToken(env) {
  return withTokenLock(env, () => refreshOrCachedToken(env));
}
export async function connectKakao(env, code, redirectUri) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: env.KAKAO_REST_API_KEY,
    redirect_uri: redirectUri, code });
  if (env.KAKAO_CLIENT_SECRET) body.set('client_secret', env.KAKAO_CLIENT_SECRET);
  let stage = 'storage';
  try { await withTokenLock(env, async () => {
    stage = 'token';
    const response = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(10000)
    });
    const token = await response.json();
    if (!response.ok) {
      const error = new Error('카카오 토큰 발급 실패');
      error.kakaoCode = token.error_code;
      throw error;
    }
    if (!token.access_token || !token.refresh_token || !Number.isFinite(token.expires_in) ||
        (token.scope && !token.scope.split(/\s+/).includes('talk_message'))) throw new Error('카카오 메시지 권한이 필요합니다.');
    stage = 'storage';
    await saveToken(env, { access_token: token.access_token, refresh_token: token.refresh_token,
      expires_at: Date.now() + token.expires_in * 1000, connected: true });
  }); } catch (error) {
    error.kakaoStage = stage;
    throw error;
  }
}
export function selfMessage(reservation, appUrl) {
  const url = new URL(appUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('운영 HTTPS 주소를 설정해주세요.');
  const time = value => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  const shorten = (value, max) => {
    const line = String(value ?? '').replace(/\s+/g, ' ').trim();
    return line.length > max ? line.slice(0, max - 1) + '…' : line;
  };
  const details = [
    '[강의실 예약 요청]',
    `이름: ${shorten(reservation.name, 40)} · 학번: ${shorten(reservation.student_id || '-', 20)}`,
    `${time(reservation.start_at)} ~ ${time(reservation.end_at)}`,
    `${shorten(reservation.room, 24)} · ${reservation.attendees}명`
  ].join('\n');
  const text = reservation.purpose ? details + '\n목적: ' + shorten(reservation.purpose, 195 - details.length) : details;
  return { object_type: 'text', text,
    link: { web_url: url.origin, mobile_web_url: url.origin }, button_title: '접수 내역 확인' };
}
export async function sendToSelf(env, reservation, token) {
  const response = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${token}` },
    body: new URLSearchParams({ template_object: JSON.stringify(selfMessage(reservation, env.PUBLIC_APP_URL)) })
  });
  if (response.status === 401) {
    // Expired/revoked access token: refresh on next queued attempt.
    const row = await env.DB.prepare("SELECT encrypted_value FROM integration_tokens WHERE provider='kakao'").first();
    if (row) {
      const saved = await unseal(row.encrypted_value, tokenKey(env));
      saved.expires_at = 0;
      await saveToken(env, saved);
    }
  }
  if (!response.ok || (await response.json()).result_code !== 0) throw new Error('카카오 메시지 전송 실패');
}
