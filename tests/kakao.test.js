import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { accessToken, seal, unseal, selfMessage, sendToSelf } from '../src/kakao.js';
test('카카오 토큰은 암호화하며 다른 키로 읽을 수 없다', async () => {
  const value = await seal({ refresh_token: 'secret-token' }, 'a'.repeat(32));
  assert.equal(value.includes('secret-token'), false);
  assert.equal((await unseal(value, 'a'.repeat(32))).refresh_token, 'secret-token');
  await assert.rejects(unseal(value, 'b'.repeat(32)));
});
test('나에게 보내는 메시지는 관리자 링크와 접수 요약만 포함한다', () => {
  const message = selfMessage({ id: 'test-id', room: '회의실', attendees: 5, start_at: '2026-11-08T01:00:00Z', end_at: '2026-11-08T02:00:00Z', name: '비공개이름', contact: '비공개전화' }, 'https://example.com');
  assert.equal(message.text.includes('비공개'), false);
  assert.equal(message.link.web_url, 'https://example.com');
  assert.throws(() => selfMessage({}, 'http://example.com'));
});
test('토큰 갱신·캐시·refresh token 회전·401 뒤 재갱신을 검증한다', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0002_kakao_tokens.sql', import.meta.url), 'utf8'));
  const prepare = (sql, values = []) => ({ bind: (...args) => prepare(sql, args),
    first: async () => db.prepare(sql).get(...values) ?? null, run: async () => db.prepare(sql).run(...values) });
  const env = { DB: { prepare }, KAKAO_REST_API_KEY: 'test-key', KAKAO_REFRESH_TOKEN: 'bootstrap', TOKEN_ENCRYPTION_KEY: 'k'.repeat(32), PUBLIC_APP_URL: 'https://example.com' };
  const original = globalThis.fetch;
  const refreshValues = [];
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://kauth.kakao.com/oauth/token');
      refreshValues.push(options.body.get('refresh_token'));
      return Response.json({ access_token: 'access', expires_in: 3600, ...(refreshValues.length === 1 ? { refresh_token: 'rotated' } : {}) });
    };
    assert.equal(await accessToken(env), 'access');
    assert.equal(await accessToken(env), 'access');
    assert.deepEqual(refreshValues, ['bootstrap']);
    const stored = db.prepare('SELECT encrypted_value FROM integration_tokens').get();
    assert.equal(stored.encrypted_value.includes('rotated'), false);
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    await assert.rejects(sendToSelf(env, { id: 'x', room: '가상', attendees: 1, start_at: '2026-11-08T01:00:00Z', end_at: '2026-11-08T02:00:00Z' }, 'access'));
    globalThis.fetch = async (_url, options) => {
      refreshValues.push(options.body.get('refresh_token'));
      return Response.json({ access_token: 'new-access', expires_in: 3600 });
    };
    assert.equal(await accessToken(env), 'new-access');
    assert.deepEqual(refreshValues, ['bootstrap', 'rotated']);
    const final = await unseal(db.prepare('SELECT encrypted_value FROM integration_tokens').get().encrypted_value, env.TOKEN_ENCRYPTION_KEY);
    assert.equal(final.refresh_token, 'rotated');
    assert.equal(db.prepare('SELECT count(*) AS n FROM integration_locks').get().n, 0);
  } finally { globalThis.fetch = original; db.close(); }
});
