import { InputError, validateReservation, validateUpdate } from './domain.js';
import { createSession, validSession, getCookie, safeEqual, digest } from './security.js';
import { kakaoConfigured, accessToken, sendToSelf } from './kakao.js';

function notificationConfigured(env) { return kakaoConfigured(env) || !!(env.NOTIFICATION_WEBHOOK_URL && env.NOTIFICATION_WEBHOOK_TOKEN); }

const headers = {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
};
function json(data, status = 200, extra = {}) { return new Response(JSON.stringify(data), { status, headers: { ...headers, ...extra } }); }
async function bodyOf(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new InputError('JSON 요청만 허용합니다.');
  if (Number(request.headers.get('Content-Length')) > 8192) throw new InputError('요청이 너무 큽니다.');
  // Bound streamed bodies as well as Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new InputError('요청 내용이 없습니다.');
  let size = 0, chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new InputError('요청이 너무 큽니다.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  try { const b = JSON.parse(new TextDecoder().decode(bytes)); if (!b || typeof b !== 'object' || Array.isArray(b)) throw 0; return b; }
  catch { throw new InputError('요청 형식을 확인해주세요.'); }
}
async function limit(request, env, kind, max) {
  const now = Date.now(), window = Math.floor(now / 900000);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const bucket = await digest(`${env.SESSION_SECRET}:${ip}:${kind}:${window}`);
  const row = await env.DB.prepare('INSERT INTO rate_limits(bucket,count,expires_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count')
    .bind(bucket, (window + 1) * 900000).first();
  return row.count <= max;
}
function configured(env) { return env.DB && env.ADMIN_PASSWORD?.length >= 16 && env.SESSION_SECRET?.length >= 32; }
async function api(request, env, ctx) {
  if (!configured(env)) return json({ error: '운영 설정이 준비되지 않았습니다.' }, 503);
  const url = new URL(request.url), path = url.pathname;
  if (!['GET', 'POST', 'PATCH'].includes(request.method)) return json({ error: '허용하지 않는 요청입니다.' }, 405);
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return json({ error: '접근할 수 없습니다.' }, 403);
  if (path === '/api/login' && request.method === 'POST') {
    if (!await limit(request, env, 'login', 10)) return json({ error: '잠시 후 다시 시도해주세요.' }, 429);
    const body = await bodyOf(request);
    if (!await safeEqual(body.password, env.ADMIN_PASSWORD)) return json({ error: '비밀번호가 올바르지 않습니다.' }, 401);
    const token = await createSession(env.SESSION_SECRET);
    return json({ ok: true }, 200, { 'Set-Cookie': `cr_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` });
  }
  if (path === '/api/logout' && request.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': 'cr_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
  if (path === '/api/reservations' && request.method === 'POST') {
    if (!await limit(request, env, 'submit', 15)) return json({ error: '접수 횟수를 초과했습니다. 잠시 후 시도해주세요.' }, 429);
    const body = await bodyOf(request);
    const data = validateReservation(body);
    const key = request.headers.get('Idempotency-Key');
    if (!key || !/^[a-f0-9-]{36}$/i.test(key)) throw new InputError('접수 식별자가 올바르지 않습니다.');
    const id = crypto.randomUUID(), now = new Date().toISOString();
    // Transactional batch prevents a saved request without its notification job.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO reservations(id,idempotency_key,name,student_id,contact,cohort,room,start_at,end_at,attendees,purpose,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`).bind(id,key,data.name,data.student_id,'','',data.room,data.start_at,data.end_at,data.attendees,data.purpose,now,now),
      env.DB.prepare('INSERT INTO notification_jobs(id,reservation_id) SELECT id,id FROM reservations WHERE idempotency_key=? ON CONFLICT(id) DO NOTHING').bind(key)
    ]);
    const saved = await env.DB.prepare('SELECT id FROM reservations WHERE idempotency_key=?').bind(key).first();
    ctx.waitUntil(deliverNotifications(env));
    return json({ id: saved.id, message: '학생회에 요청이 접수되었습니다. 실제 예약 완료는 담당자가 별도로 안내합니다.' }, 201);
  }
  if (!await validSession(getCookie(request), env.SESSION_SECRET)) return json({ error: '관리자 로그인이 필요합니다.' }, 401);
  if (path === '/api/admin/reservations' && request.method === 'GET') {
    const page = Math.max(0, Math.min(10000, Number.parseInt(url.searchParams.get('page') || '0', 10) || 0));
    const rows = await env.DB.prepare(`SELECT r.*,j.state AS notification_state,j.attempts AS notification_attempts FROM reservations r
      LEFT JOIN notification_jobs j ON j.reservation_id=r.id ORDER BY r.created_at DESC,r.id DESC LIMIT 51 OFFSET ?`).bind(page * 50).all();
    return json({ reservations: rows.results.slice(0,50), has_more: rows.results.length > 50, page, notification_configured: notificationConfigured(env), notification_provider: kakaoConfigured(env) ? 'kakao_self' : 'relay' });
  }
  const match = path.match(/^\/api\/admin\/reservations\/([a-f0-9-]{36})$/i);
  if (match && request.method === 'PATCH') {
    const data = validateUpdate(await bodyOf(request));
    const changed = await env.DB.prepare('UPDATE reservations SET status=?,assignee=?,admin_note=?,updated_at=?,version=version+1 WHERE id=? AND version=? RETURNING id')
      .bind(data.status,data.assignee,data.admin_note,new Date().toISOString(),match[1],data.version).first();
    return changed ? json({ ok: true }) : json({ error: '다른 담당자가 수정했거나 삭제된 요청입니다. 목록을 새로고침해주세요.' }, 409);
  }
  if (path === '/api/admin/retry' && request.method === 'POST') {
    if (!notificationConfigured(env)) return json({ error: '알림 발송 경로가 아직 연결되지 않았습니다.' }, 409);
    await env.DB.prepare("UPDATE notification_jobs SET state='pending', attempts=0, next_at=0 WHERE state='failed'").run();
    ctx.waitUntil(deliverNotifications(env)); return json({ ok: true });
  }
  return json({ error: '찾을 수 없습니다.' }, 404);
}
export async function deliverNotifications(env) {
  if (!notificationConfigured(env)) return;
  const kakao = kakaoConfigured(env);
  const target = kakao ? null : new URL(env.NOTIFICATION_WEBHOOK_URL);
  if (target && target.protocol !== 'https:') return;
  const now = Date.now();
  const rows = await env.DB.prepare(`SELECT id,reservation_id FROM notification_jobs
    WHERE ((state='pending' AND next_at<=?) OR (state='sending' AND lease_until<?)) AND attempts<6 LIMIT 10`).bind(now,now).all();
  for (const job of rows.results) {
    const claimed = await env.DB.prepare(`UPDATE notification_jobs SET state='sending',attempts=attempts+1,lease_until=?
      WHERE id=? AND ((state='pending' AND next_at<=?) OR (state='sending' AND lease_until<?)) RETURNING attempts`).bind(now+60000,job.id,now,now).first();
    if (!claimed) continue;
    try {
      const reservation = await env.DB.prepare('SELECT id,room,start_at,end_at,attendees FROM reservations WHERE id=?').bind(job.reservation_id).first();
      if (kakao) {
        await sendToSelf(env, reservation, await accessToken(env));
      } else {
      const result = await fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.NOTIFICATION_WEBHOOK_TOKEN}`, 'Idempotency-Key': job.id },
        body: JSON.stringify({ event: 'reservation.received', reservation }) });
      if (!result.ok) throw new Error('relay');
      }
      await env.DB.prepare("UPDATE notification_jobs SET state='sent',sent_at=?,last_error='' WHERE id=?").bind(new Date().toISOString(),job.id).run();
    } catch {
      await env.DB.prepare('UPDATE notification_jobs SET state=?,next_at=?,last_error=? WHERE id=?')
        .bind(claimed.attempts >= 6 ? 'failed' : 'pending',Date.now()+Math.min(3600000,60000 * 2 ** claimed.attempts),'발송 경로 응답 실패',job.id).run();
    }
  }
}
export default {
  async fetch(request, env, ctx) {
    try {
      if (new URL(request.url).pathname.startsWith('/api/')) return await api(request, env, ctx);
      return await env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error instanceof InputError ? error.message : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.' }, error instanceof InputError ? 400 : 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      await deliverNotifications(env);
      const days = Math.max(1, Math.min(365, Number(env.RETENTION_DAYS) || 90));
      await env.DB.batch([
        env.DB.prepare('DELETE FROM reservations WHERE created_at<?').bind(new Date(Date.now()-days*86400000).toISOString()),
        env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(Date.now())
      ]);
    })());
  }
};
