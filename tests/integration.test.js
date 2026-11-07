import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { deliverNotifications } from '../src/worker.js';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_kakao_tokens.sql', import.meta.url), 'utf8'));
  function prepare(sql, values = []) {
    return {
      bind(...args) { return prepare(sql, args); },
      async first() { return db.prepare(sql).get(...values) ?? null; },
      async all() { return { results: db.prepare(sql).all(...values) }; },
      async run() { return db.prepare(sql).run(...values); }
    };
  }
  return { prepare, async batch(statements) {
    db.exec('BEGIN');
    try { const results = []; for (const s of statements) results.push(await s.run()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }, close() { db.close(); } };
}

test('실제 SQL: 접수 → 중복 방지 → 관리자 변경 → 충돌 → 알림 실패/재시도 → 보관 만료 삭제', async () => {
  const DB = database(), pending = [];
  const env = { DB, ADMIN_PASSWORD: 'admin-password-for-test', SESSION_SECRET: 's'.repeat(32), REQUEST_CODE: 'test-invitation' };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  async function call(path, method = 'GET', data, extra = {}) {
    return worker.fetch(new Request(`https://example.com/api/${path}`, { method,
      headers: { Origin: 'https://example.com', 'Content-Type': 'application/json', ...extra },
      body: data ? JSON.stringify(data) : undefined }), env, ctx);
  }
  const draft = { name: '가상 원우', contact: 'fake@example.com', cohort: '테스트기수', room: '가상 회의실', attendees: 4, purpose: '테스트',
    consent: true, request_code: env.REQUEST_CODE, start_at: new Date(Date.now()+86400000).toISOString(), end_at: new Date(Date.now()+90000000).toISOString() };
  const key = crypto.randomUUID();
  const submitted = await call('reservations', 'POST', draft, { 'Idempotency-Key': key });
  assert.equal(submitted.status, 201); const saved = await submitted.json();
  assert.equal((await (await call('reservations', 'POST', draft, { 'Idempotency-Key': key })).json()).id, saved.id);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM reservations').first()).n, 1);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM notification_jobs').first()).n, 1);
  assert.equal((await call('admin/reservations')).status, 401);
  const login = await call('login', 'POST', { password: env.ADMIN_PASSWORD });
  assert.equal(login.status, 200); const Cookie = login.headers.get('Set-Cookie').split(';')[0];
  const rows = await (await call('admin/reservations', 'GET', null, { Cookie })).json();
  assert.equal(rows.reservations[0].notification_state, 'pending');
  const update = { status: 'processing', assignee: '테스트 담당자', admin_note: '', version: 0 };
  assert.equal((await call(`admin/reservations/${saved.id}`, 'PATCH', update, { Cookie })).status, 200);
  assert.equal((await call(`admin/reservations/${saved.id}`, 'PATCH', update, { Cookie })).status, 409);
  const originalFetch = globalThis.fetch;
  env.NOTIFICATION_WEBHOOK_URL = 'https://relay.example/notify'; env.NOTIFICATION_WEBHOOK_TOKEN = 'test-only';
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response('failure', { status: 503 }); };
    await deliverNotifications(env);
    let job = await DB.prepare('SELECT * FROM notification_jobs').first();
    assert.equal(job.state, 'pending'); assert.equal(job.attempts, 1); assert.ok(job.next_at > Date.now());
    await DB.prepare('UPDATE notification_jobs SET next_at=0').run();
    globalThis.fetch = async (_url, options) => {
      calls++; assert.equal(options.headers['Idempotency-Key'], saved.id);
      const payload = JSON.parse(options.body); assert.equal(payload.reservation.contact, undefined); assert.equal(payload.reservation.name, undefined);
      return new Response('{}');
    };
    await Promise.all([deliverNotifications(env), deliverNotifications(env)]);
    job = await DB.prepare('SELECT * FROM notification_jobs').first(); assert.equal(job.state, 'sent'); assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
  await DB.prepare('UPDATE reservations SET created_at=?').bind('2000-01-01T00:00:00.000Z').run();
  await worker.scheduled({}, env, ctx); await Promise.all(pending);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM reservations').first()).n, 0);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM notification_jobs').first()).n, 0);
  DB.close();
});
