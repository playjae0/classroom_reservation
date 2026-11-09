# 원우 강의실 예약 지원

원우의 강의실 예약 요청을 접수하고 학생회가 학교 시스템에서 예약한 뒤 상태를 관리하는 MVP입니다. 학교 시스템 자동 예약 기능은 없습니다.

## 구현 범위

- 모바일 대응 신청 폼, 한국 시간 입력, 이름·학번 입력 및 수집 동의
- 관리자 로그인(8시간 서명 쿠키), 목록 페이지, 담당자·상태·메모 수정
- 중복 접수 방지, 동시 수정 충돌 감지, 접수와 알림 작업의 트랜잭션 저장
- 알림 발송 경로 미설정 표시, 재시도 및 발송 임대, 90일 보관 후 삭제
- Cloudflare Workers + D1 + Static Assets. 별도 도메인 불필요

**카카오 ‘나에게 보내기’로 본인 나와의 채팅에 접수 요약을 기록합니다.** 접수 요약에는 이름과 학번이 포함됩니다. 담당자는 신청 내역을 카카오톡에서 확인할 수 있습니다. 푸시·소리 알림은 제공하지 않습니다. 실제 계정 연결과 수신 검증은 아직 필요합니다. 설정 전에는 알림 작업이 DB에 대기합니다. `sent`는 카카오 API의 성공 응답을 뜻하며 읽음 확인은 아닙니다.

## Cloudflare 준비

1. https://dash.cloudflare.com/sign-up 에서 무료 계정 가입 및 이메일 인증.
2. Workers & Pages 메뉴 확인. 도메인 구매, 유료 플랜, 별도 Git 자동 연결은 필요 없습니다.
3. 아래 CLI 로그인은 본인이 브라우저에서 승인합니다. 비밀번호·API 토큰을 채팅에 보내지 않습니다.

## 로컬 실행 / 배포 (PowerShell)

Node.js 22 이상 권장. 저장소 디렉터리에서 실행합니다.

```powershell
npm install
npx wrangler login
npx wrangler d1 create classroom-reservation
```

출력된 `database_id`를 `wrangler.jsonc`에 입력합니다. 이 ID는 비밀키가 아닙니다. `binding` 이름 `DB`는 유지합니다.

```powershell
Copy-Item .dev.vars.example .dev.vars
```

관리자 화면을 사용할 경우 `.dev.vars`에 관리자 비밀번호(16자 이상)와 세션 비밀키(32자 이상)를 설정합니다. 신청 접수에는 두 값이 필요하지 않습니다. 실제 값을 커밋하지 않습니다.

```powershell
npm run db:local
npm run dev
```

http://localhost:8787 에서 테스트합니다. 가짜 이름·학번만 사용합니다.

```powershell
npm test
npm run check
npm run db:remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npm run deploy
```

각 `secret put` 입력창에 비밀값을 직접 입력합니다. 운영에서는 로컬과 다른 값을 사용합니다. 배포 출력의 `https://classroom-reservation.<account>.workers.dev` 주소가 접수 주소입니다. 관리자는 상단 학생회 관리 버튼으로 로그인합니다.

## 알림 경로

### 카카오 나에게 보내기 (기본)

1. 카카오디벨로퍼스에서 본인 앱 생성.
2. 카카오 로그인 활성화, Redirect URI에 `http://localhost:8788/callback` 등록.
3. 카카오톡 메시지 전송 `talk_message` 동의항목 설정.
4. 앱의 웹 도메인에 실제 배포 주소(`https://...workers.dev`) 등록. 콘솔에서 REST API 키의 허용 웹 도메인 등 추가 설정을 요구하면 동일 주소를 등록.
5. `.dev.vars`에 `KAKAO_REST_API_KEY`, 필요 시 `KAKAO_CLIENT_SECRET`, 독립적인 32자 이상 `TOKEN_ENCRYPTION_KEY`, `PUBLIC_APP_URL` 입력.
6. `npm run kakao:connect` 실행 후 출력된 로그인 주소를 본인 브라우저에서 열고 동의. 초기 refresh token은 무시된 `.dev.vars`에만 저장되고 출력되지 않음.
7. 운영 환경은 `wrangler secret put`으로 같은 설정과 `KAKAO_REFRESH_TOKEN`을 직접 입력. 토큰을 채팅이나 GitHub에 붙여넣지 않음.

```powershell
npx wrangler secret put KAKAO_REST_API_KEY
npx wrangler secret put KAKAO_CLIENT_SECRET
npx wrangler secret put KAKAO_REFRESH_TOKEN
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put PUBLIC_APP_URL
npm run db:remote
npm run deploy
```

Client Secret을 사용하지 않는 앱은 해당 명령을 생략합니다. 인증 정보는 로그인한 본인의 나와의 채팅에만 사용합니다. 액세스 토큰은 자동 갱신하며, 새 refresh token이 응답에 있으면 교체하고 없으면 기존 값을 유지합니다. 갱신 토큰은 별도 키로 AES-GCM 암호화하여 D1에 보관합니다. `TOKEN_ENCRYPTION_KEY`를 바꿀 때는 반드시 새 인증 토큰으로 재연결하고 저장 토큰을 초기화해야 합니다.

연결 철회·장기 미사용·refresh token 만료 등으로 재로그인이 필요할 수 있습니다. 카카오 API는 이 메시지에 대한 중복 방지 키를 지원하지 않으므로, 성공 직후 네트워크가 끊기거나 작업이 중단되면 재시도로 같은 접수번호가 두 번 도착할 수 있습니다. 관리자 목록이 원본이며 접수번호로 구분합니다. 기존 단톡방으로의 자동 전송은 구현하지 않습니다.

### 선택 사항: 외부 발송 경로

승인된 발송 서비스를 확정하면 서버 측 어댑터를 연결합니다. 현재 연동 계약은 HTTPS POST JSON + Bearer 인증 + `Idempotency-Key`입니다. 메시지에는 학번과 이름을 제외한 접수번호·희망 강의실·일시·인원만 전달합니다. 발송 경로는 같은 키의 중복 발송을 차단해야 합니다.

```powershell
npx wrangler secret put NOTIFICATION_WEBHOOK_URL
npx wrangler secret put NOTIFICATION_WEBHOOK_TOKEN
```

5분 간격으로 최대 10개 작업을 처리하고 실패 시 간격을 늘려 최대 6회 시도합니다. 발송 실패 후 관리자에서 재시도할 수 있습니다. 외부 서비스 자격 증명, 카카오 앱 심사, 실제 휴대폰 수신 검증은 별도 필요합니다. 임의의 공개 웹훅에 원우 정보를 보내지 않습니다.

## 운영 전 확인

- 가짜 신청 → 접수번호 → 관리자 목록 → 담당자 지정 → 완료 상태 저장 확인
- 비로그인 API 접근 차단과 두 관리자 동시 수정 충돌 확인
- 실제 학생회 운영 주체, 문의 연락처, 보관 기간을 확인하고 동의 문구 확정(현재 90일)
- 담당자 교체 시 관리자 비밀번호 회전
- 관리자 공유 비밀번호는 초기 소규모 운영용. 개인별 로그인·감사 기록은 미구현
- 접수량/알림 실패를 점검. 무료 한도·서비스 장애에 대한 무중단 보장은 없음
- 본인 계정 연결 및 실기기 수신 검증 전에는 카카오 전송 완료를 안내하지 않음

학생회 담당자가 입력된 이름과 학번을 확인합니다. IP별 제한은 같은 학교 네트워크의 여러 사용자가 공유할 수 있습니다. 신청자용 조회·취소 화면은 현재 범위에 포함하지 않습니다.

## 공식 문서

- https://developers.cloudflare.com/d1/get-started/
- https://developers.cloudflare.com/workers/static-assets/
- https://developers.kakao.com/docs/ko/kakaotalk-message/faq
