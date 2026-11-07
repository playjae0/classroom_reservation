const encoder = new TextEncoder();
export function kakaoConfigured(env) {
  return !!(env.KAKAO_REST_API_KEY && env.KAKAO_REFRESH_TOKEN && env.TOKEN_ENCRYPTION_KEY?.length >= 32 && env.PUBLIC_APP_URL);
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
    .bind(await seal(token, env.TOKEN_ENCRYPTION_KEY), new Date().toISOString()).run();
}
async function refreshOrCachedToken(env) {
  const row = await env.DB.prepare("SELECT encrypted_value FROM integration_tokens WHERE provider='kakao'").first();
  let saved = row ? await unseal(row.encrypted_value, env.TOKEN_ENCRYPTION_KEY) : null;
  // Changing the bootstrap refresh secret deliberately resets the connection.
  const bootstrap = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(env.KAKAO_REFRESH_TOKEN))));
  if (saved?.bootstrap !== bootstrap) saved = null;
  if (saved?.expires_at > Date.now() + 60000) return saved.access_token;
  const refresh = saved?.refresh_token || env.KAKAO_REFRESH_TOKEN;
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: env.KAKAO_REST_API_KEY, refresh_token: refresh });
  if (env.KAKAO_CLIENT_SECRET) body.set('client_secret', env.KAKAO_CLIENT_SECRET);
  const response = await fetch('https://kauth.kakao.com/oauth/token', { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('카카오 인증을 다시 연결해야 합니다.');
  const token = await response.json();
  if (!token.access_token || !Number.isFinite(token.expires_in)) throw new Error('카카오 인증 응답 오류');
  await saveToken(env, { access_token: token.access_token, refresh_token: token.refresh_token || refresh,
    expires_at: Date.now() + token.expires_in * 1000, bootstrap });
  return token.access_token;
}
export async function accessToken(env) {
  const owner = crypto.randomUUID(), now = Date.now();
  const lock = await env.DB.prepare(`INSERT INTO integration_locks(provider,owner,expires_at) VALUES('kakao',?,?)
    ON CONFLICT(provider) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
    WHERE integration_locks.expires_at<? RETURNING owner`).bind(owner,now+30000,now).first();
  if (!lock) throw new Error('카카오 연결 갱신 중입니다.');
  try { return await refreshOrCachedToken(env); }
  finally { await env.DB.prepare("DELETE FROM integration_locks WHERE provider='kakao' AND owner=?").bind(owner).run(); }
}
export function selfMessage(reservation, appUrl) {
  const url = new URL(appUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('운영 HTTPS 주소를 설정해주세요.');
  const time = value => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  return { object_type: 'text', text: `[학생회 강의실 예약 요청]\n희망 공간: ${reservation.room}\n시간: ${time(reservation.start_at)} ~ ${time(reservation.end_at)}\n인원: ${reservation.attendees}명\n접수번호: ${reservation.id}\n신청자·연락처는 관리자 화면에서 확인해주세요.`,
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
      const saved = await unseal(row.encrypted_value, env.TOKEN_ENCRYPTION_KEY);
      saved.expires_at = 0;
      await saveToken(env, saved);
    }
  }
  if (!response.ok || (await response.json()).result_code !== 0) throw new Error('카카오 메시지 전송 실패');
}
