import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReservation, validateUpdate } from '../src/domain.js';
import { createSession, validSession } from '../src/security.js';
import worker from '../src/worker.js';
const now = Date.parse('2026-11-07T00:00:00Z');
const valid = { name: '테스트', contact: 'test@example.com', cohort: 'MOT', room: '회의실', purpose: '팀 회의', attendees: 5,
  start_at: '2026-11-08T10:00:00+09:00', end_at: '2026-11-08T12:00:00+09:00', consent: true };
test('한국 시간 입력을 UTC로 저장한다', () => assert.equal(validateReservation(valid, now).start_at, '2026-11-08T01:00:00.000Z'));
test('역전 시간, 과거, 초과 인원, 미동의, 과도한 길이를 거절한다', () => {
  for (const patch of [{ end_at: valid.start_at }, { start_at: '2020-01-01' }, { attendees: 0 }, { consent: false }, { purpose: 'x'.repeat(501) }, { website: 'spam' }]) {
    assert.throws(() => validateReservation({ ...valid, ...patch }, now));
  }
});
test('처리 상태와 동시 수정 버전을 검증한다', () => {
  assert.equal(validateUpdate({ status: 'processing', version: 0, assignee: '담당자', admin_note: '' }).version, 0);
  assert.throws(() => validateUpdate({ status: 'unknown', version: 0 }));
  assert.throws(() => validateUpdate({ status: 'received', version: -1 }));
});
test('서명 위조, 만료, 다른 비밀키의 관리자 세션을 거절한다', async () => {
  const token = await createSession('test-secret', now);
  assert.equal(await validSession(token, 'test-secret', now), true);
  assert.equal(await validSession(token+'x', 'test-secret', now), false);
  assert.equal(await validSession(token, 'other-secret', now), false);
  assert.equal(await validSession(token, 'test-secret', now+8*3600000), false);
});
const env = { DB: {}, ADMIN_PASSWORD: 'x'.repeat(20), SESSION_SECRET: 's'.repeat(32), REQUEST_CODE: 'invite-code' };
test('외부 사이트의 상태 변경 요청을 차단한다', async () => {
  const result = await worker.fetch(new Request('https://example.com/api/login', { method: 'POST', headers: { Origin: 'https://evil.example' } }), env, {});
  assert.equal(result.status, 403);
});
test('비로그인 사용자는 신청 내역을 볼 수 없다', async () => {
  const result = await worker.fetch(new Request('https://example.com/api/admin/reservations'), env, {});
  assert.equal(result.status, 401);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
});
test('운영 비밀값이 없으면 접수를 열지 않는다', async () => {
  const result = await worker.fetch(new Request('https://example.com/api/reservations', { method: 'POST' }), {}, {});
  assert.equal(result.status, 503);
});
