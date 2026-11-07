# 원우 강의실 예약 지원

원우의 강의실 예약 요청을 접수하고 학생회가 학교 시스템에서 예약한 뒤 상태를 관리하는 MVP입니다. 학교 시스템 자동 예약 기능은 없습니다.

## 구현 범위

- 모바일 대응 신청 폼, 한국 시간 입력, 수집 동의 및 학생회 신청 코드
- 관리자 로그인(8시간 서명 쿠키), 목록 페이지, 담당자·상태·메모 수정
- 중복 접수 방지, 동시 수정 충돌 감지, 접수와 알림 작업의 트랜잭션 저장
- 알림 발송 경로 미설정 표시, 재시도 및 발송 임대, 90일 보관 후 삭제
- Cloudflare Workers + D1 + Static Assets. 별도 도메인 불필요

**카카오톡 발송은 아직 연결되지 않았습니다.** 일반 메시지 API는 사용자 간 소셜 메시지 용도입니다. 본 서비스의 자동 알림에 적합한 알림톡/승인된 경로와 학생회 자격을 먼저 확인해야 합니다. 기존 단톡방 자동 발송은 일반 공식 API에서 지원하지 않습니다. 현재 알림 작업은 DB에 대기하며, `sent`는 연결된 발송 경로가 접수했음을 뜻하고 휴대폰 수신·읽음 보장은 아닙니다.

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

`.dev.vars`에 관리자 비밀번호(16자 이상), 세션 비밀키(32자 이상), 원우 신청 코드(8자 이상)를 직접 설정합니다. 실제 값을 커밋하지 않습니다.

```powershell
npm run db:local
npm run dev
```

http://localhost:8787 에서 테스트합니다. 가짜 이름·연락처만 사용합니다.

```powershell
npm test
npm run check
npm run db:remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put REQUEST_CODE
npm run deploy
```

각 `secret put` 입력창에 비밀값을 직접 입력합니다. 운영에서는 로컬과 다른 값을 사용합니다. 배포 출력의 `https://classroom-reservation.<account>.workers.dev` 주소가 접수 주소입니다. 관리자는 상단 학생회 관리 버튼으로 로그인합니다.

## 알림 경로

승인된 발송 서비스를 확정하면 서버 측 어댑터를 연결합니다. 현재 연동 계약은 HTTPS POST JSON + Bearer 인증 + `Idempotency-Key`입니다. 메시지에는 연락처와 이름을 제외한 접수번호·희망 강의실·일시·인원만 전달합니다. 발송 경로는 같은 키의 중복 발송을 차단해야 합니다.

```powershell
npx wrangler secret put NOTIFICATION_WEBHOOK_URL
npx wrangler secret put NOTIFICATION_WEBHOOK_TOKEN
```

5분 간격으로 최대 10개 작업을 처리하고 실패 시 간격을 늘려 최대 6회 시도합니다. 발송 실패 후 관리자에서 재시도할 수 있습니다. 외부 서비스 자격 증명, 카카오 앱 심사, 실제 휴대폰 수신 검증은 별도 필요합니다. 임의의 공개 웹훅에 원우 정보를 보내지 않습니다.

## 운영 전 확인

- 가짜 신청 → 접수번호 → 관리자 목록 → 담당자 지정 → 완료 상태 저장 확인
- 비로그인 API 접근 차단과 두 관리자 동시 수정 충돌 확인
- 실제 학생회 운영 주체, 문의 연락처, 보관 기간을 확인하고 동의 문구 확정(현재 90일)
- 신청 코드와 관리자 비밀번호는 서로 다르게 설정하고 담당자 교체 시 회전
- 관리자 공유 비밀번호는 초기 소규모 운영용. 개인별 로그인·감사 기록은 미구현
- 접수량/알림 실패를 점검. 무료 한도·서비스 장애에 대한 무중단 보장은 없음
- 카카오 발송 경로 승인 및 실기기 수신 검증 전에는 자동 카카오 알림 제공을 안내하지 않음

신청 코드는 원우 확인을 위한 간단한 접근 제한이며 학생 신원 인증은 아닙니다. IP별 제한은 같은 학교 네트워크의 여러 사용자가 공유할 수 있습니다. 신청자용 조회·취소 화면은 현재 범위에 포함하지 않습니다.

## 공식 문서

- https://developers.cloudflare.com/d1/get-started/
- https://developers.cloudflare.com/workers/static-assets/
- https://developers.kakao.com/docs/ko/kakaotalk-message/faq
