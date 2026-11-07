export const STATUSES = ['received', 'processing', 'completed', 'unavailable'];
export class InputError extends Error {}
function text(value, label, max, optional = false) {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.trim().length > max) {
    throw new InputError(`${label}을(를) 확인해주세요.`);
  }
  return value.trim();
}
export function validateReservation(body, now = Date.now()) {
  const result = {
    name: text(body.name, '이름', 40),
    contact: text(body.contact, '연락처', 100),
    cohort: text(body.cohort, '기수·학과', 60),
    room: text(body.room, '희망 강의실', 100),
    purpose: text(body.purpose, '사용 목적', 500)
  };
  if (body.consent !== true) throw new InputError('개인정보 수집·이용에 동의해주세요.');
  if (body.website) throw new InputError('요청을 처리할 수 없습니다.');
  if (!Number.isInteger(body.attendees) || body.attendees < 1 || body.attendees > 300) {
    throw new InputError('인원은 1~300명으로 입력해주세요.');
  }
  const start = Date.parse(body.start_at), end = Date.parse(body.end_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= now ||
      start > now + 180 * 86400000 || end <= start || end - start > 12 * 3600000) {
    throw new InputError('일시는 미래 180일 이내, 사용 시간은 최대 12시간으로 입력해주세요.');
  }
  return { ...result, attendees: body.attendees, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() };
}
export function validateUpdate(body) {
  if (!STATUSES.includes(body.status)) throw new InputError('올바른 처리 상태를 선택해주세요.');
  if (!Number.isInteger(body.version) || body.version < 0) throw new InputError('버전 정보가 올바르지 않습니다.');
  return { status: body.status, assignee: text(body.assignee, '담당자', 40, true),
    admin_note: text(body.admin_note, '처리 메모', 1000, true), version: body.version };
}
