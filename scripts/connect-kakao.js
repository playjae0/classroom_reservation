// Owner-run OAuth bootstrap. Secrets stay in the ignored .dev.vars file.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const file = new URL('../.dev.vars', import.meta.url);
const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
function setting(name) {
  const line = source.split(/\r?\n/).find(x => x.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, '') : '';
}
const clientId = setting('KAKAO_REST_API_KEY'), clientSecret = setting('KAKAO_CLIENT_SECRET');
if (!clientId) { console.error('.dev.vars에 KAKAO_REST_API_KEY를 먼저 입력해주세요.'); process.exit(1); }
const state = randomUUID(), redirect = 'http://localhost:8788/callback';
let handling = false;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, redirect);
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
  if (request.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
    response.writeHead(400); response.end('인증 요청이 일치하지 않습니다.'); return;
  }
  if (handling) { response.writeHead(409); response.end('이미 연결 중입니다.'); return; }
  handling = true;
  try {
    const code = url.searchParams.get('code'); if (!code) throw new Error('denied');
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirect, code });
    if (clientSecret) body.set('client_secret', clientSecret);
    const result = await fetch('https://kauth.kakao.com/oauth/token', { method: 'POST', body, signal: AbortSignal.timeout(15000) });
    if (!result.ok) throw new Error('exchange');
    const token = await result.json(); if (!token.refresh_token) throw new Error('missing');
    const latest = readFileSync(file, 'utf8');
    const line = `KAKAO_REFRESH_TOKEN=${token.refresh_token}`;
    writeFileSync(file, /^KAKAO_REFRESH_TOKEN=.*$/m.test(latest) ? latest.replace(/^KAKAO_REFRESH_TOKEN=.*$/m, line) : `${latest.trimEnd()}\n${line}\n`);
    response.end('카카오 계정 연결을 완료했습니다. 이 창을 닫으셔도 됩니다.');
    console.log('연결 완료. refresh token을 로컬 .dev.vars에 저장했습니다. 토큰은 출력하지 않습니다.');
  } catch {
    response.writeHead(400); response.end('연결하지 못했습니다. 앱 키, Redirect URI, 동의항목을 확인하고 다시 실행해주세요.');
    console.error('카카오 연결 실패. 설정을 확인하고 다시 실행해주세요.');
    process.exitCode = 1;
  } finally { clearTimeout(timer); server.close(); }
});
server.on('error', () => { console.error('localhost:8788을 열 수 없습니다. 포트 사용 여부를 확인해주세요.'); clearTimeout(timer); process.exitCode = 1; });
const timer = setTimeout(() => { console.error('연결 시간이 만료되었습니다. 다시 실행해주세요.'); server.close(); }, 10 * 60000);
server.listen(8788, '127.0.0.1', () => {
  const authorize = new URL('https://kauth.kakao.com/oauth/authorize');
  authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'talk_message', state }).toString();
  console.log('본인 브라우저에서 다음 주소를 열고 카카오 로그인·메시지 전송 동의를 진행해주세요.');
  console.log(authorize.href);
});
