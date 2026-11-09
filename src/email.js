export function emailConfigured(env) {
  return !!(env.RESEND_API_KEY && env.NOTIFICATION_EMAIL_TO);
}

export async function sendReservationEmail(env, reservation, jobId) {
  const time = value => new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short'
  }).format(new Date(value));
  const text = [
    '강의실 예약 요청이 접수되었습니다.',
    `희망 공간: ${reservation.room}`,
    `일시: ${time(reservation.start_at)} ~ ${time(reservation.end_at)}`,
    `인원: ${reservation.attendees}명`,
    `접수번호: ${reservation.id}`,
    '이름과 학번은 카카오톡 나와의 채팅에서 확인해주세요.'
  ].join('\n');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': jobId
    },
    body: JSON.stringify({
      from: env.NOTIFICATION_EMAIL_FROM || '강의실 예약 <onboarding@resend.dev>',
      to: [env.NOTIFICATION_EMAIL_TO],
      subject: '[강의실 예약] 새 신청이 접수되었습니다',
      text
    })
  });
  if (!response.ok) throw new Error(`Email delivery rejected: HTTP ${response.status}`);
}
