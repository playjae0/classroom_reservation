const $ = id => document.getElementById(id);
const labels = { received: '접수', processing: '처리 중', completed: '예약 완료', unavailable: '예약 불가' };
const notificationLabels = { pending: '발송 대기', sending: '전송 중', sent: '발송 경로 접수됨', failed: '발송 실패' };
let page = 0, hasMore = false, idempotencyKey = crypto.randomUUID(), submitting = false;
function message(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json();
  if (!response.ok) { const error = new Error(body.error || '요청에 실패했습니다.'); error.status = response.status; throw error; }
  return body;
}
function formatDate(value) { return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
const requestForm = $('request-form');
const buildingSelect = requestForm.elements.building;
const customBuilding = requestForm.elements.custom_building;
const roomSelect = requestForm.elements.room_choice;
const customRoom = requestForm.elements.room_number;
const roomsByBuilding = new Map([
  ['창의관', ['106호', '127호']],
  ['신공학관', ['B101호', 'B103호', 'B105호', 'B106호', 'B107B호', 'B108호', 'B114호', 'B115호']]
]);

function updateRoomInput() {
  const enabled = buildingSelect.value === 'custom' || roomSelect.value === 'custom';
  $('custom-room-label').classList.toggle('hidden', !enabled);
  customRoom.disabled = !enabled;
  customRoom.required = enabled;
}

function updateBuildingInput() {
  const building = buildingSelect.value;
  const direct = building === 'custom';
  $('custom-building-label').classList.toggle('hidden', !direct);
  customBuilding.disabled = !direct;
  customBuilding.required = direct;
  $('room-select-label').classList.toggle('hidden', direct);
  roomSelect.disabled = !building || direct;

  const rooms = roomsByBuilding.get(building) || [];
  roomSelect.replaceChildren(new Option(building ? '호실 선택' : '건물을 먼저 선택하세요', ''));
  if (rooms.length) {
    roomSelect.append(...rooms.map(room => new Option(room, room)), new Option('직접 입력', 'custom'));
  }
  customRoom.value = '';
  updateRoomInput();
}

buildingSelect.addEventListener('change', updateBuildingInput);
roomSelect.addEventListener('change', updateRoomInput);
updateBuildingInput();
$('request-form').addEventListener('input', () => { if (!submitting) idempotencyKey = crypto.randomUUID(); });
$('request-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('button[type=submit]');
  const fields = Object.fromEntries(new FormData(form));
  const { custom_building, room_choice, ...requestFields } = fields;
  const body = { ...requestFields, building: fields.building === 'custom' ? custom_building : fields.building,
    room_number: fields.building === 'custom' || room_choice === 'custom' ? fields.room_number : room_choice,
    consent: form.elements.consent.checked,
    start_at: `${fields.date}T${fields.start_time}:00+09:00`, end_at: `${fields.date}T${fields.end_time}:00+09:00` };
  submitting = true; button.disabled = true;
  message('request-message', '접수하고 있습니다…');
  try {
    const result = await api('/api/reservations', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) });
    $('receipt-id').textContent = result.id; form.classList.add('hidden'); $('receipt').classList.remove('hidden'); $('receipt').focus();
    form.reset(); updateBuildingInput(); idempotencyKey = crypto.randomUUID(); message('request-message', '');
  } catch (error) { message('request-message', error.message, true); }
  finally { submitting = false; button.disabled = false; }
});
$('new-request').onclick = () => { $('receipt').classList.add('hidden'); $('request-form').classList.remove('hidden'); };
$('admin-toggle').onclick = () => { $('request-view').classList.add('hidden'); $('admin-view').classList.remove('hidden'); load(); };
$('back').onclick = () => { $('admin-view').classList.add('hidden'); $('request-view').classList.remove('hidden'); };
$('login-form').onsubmit = async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: event.currentTarget.elements.password.value }) }); $('login-form').reset(); page = 0; await load(); }
  catch (error) { message('admin-message', error.message, true); } finally { button.disabled = false; }
};
$('logout').onclick = async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); $('dashboard').classList.add('hidden'); $('login-form').classList.remove('hidden'); $('reservation-list').replaceChildren(); }
  catch (error) { message('admin-message', error.message, true); }
};
$('refresh').onclick = () => load();
$('previous').onclick = () => { if (page) { page--; load(); } };
$('next').onclick = () => { if (hasMore) { page++; load(); } };
$('retry').onclick = async () => {
  try { await api('/api/admin/retry', { method: 'POST', body: '{}' }); message('admin-message', '알림 재시도를 요청했습니다. 잠시 후 새로고침해주세요.'); }
  catch (error) { message('admin-message', error.message, true); }
};
function element(tag, text, className) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; }
function field(label, input) { const node = element('label', label); node.append(input); return node; }
function renderCard(row) {
  const card = element('article', null, 'panel request-card'), title = element('div', null, 'card-title');
  title.append(element('h2', row.name), element('span', labels[row.status], 'badge')); card.append(title);
  const details = element('dl', null, 'details');
  for (const [label, value] of [...(row.student_id ? [['학번', row.student_id]] : [['기수 · 학과', row.cohort], ['연락처', row.contact]]), ['희망 공간', row.room], ['사용 시간', `${formatDate(row.start_at)} ~ ${formatDate(row.end_at)}`],
    ['신청 사유', row.purpose], ['접수 일시', formatDate(row.created_at)], ['알림 상태', `${notificationLabels[row.notification_state] || '미확인'} (${row.notification_attempts || 0}회 시도)`], ['접수번호', row.id]]) {
    details.append(element('dt', label), element('dd', value));
  }
  card.append(details);
  const form = element('form'), grid = element('div', null, 'edit-grid'), status = element('select');
  for (const [key, label] of Object.entries(labels)) { const option = element('option', label); option.value = key; status.append(option); }
  status.value = row.status; status.required = true;
  const assignee = element('input'); assignee.value = row.assignee; assignee.maxLength = 40; assignee.placeholder = '담당자 이름';
  grid.append(field('처리 상태', status), field('담당자', assignee));
  const note = element('textarea'); note.value = row.admin_note; note.maxLength = 1000; note.rows = 2;
  const save = element('button', '변경사항 저장', 'primary'); save.type = 'submit';
  const feedback = element('p'); feedback.setAttribute('role', 'status');
  form.append(grid, field('처리 메모', note), save, feedback);
  form.onsubmit = async event => {
    event.preventDefault(); save.disabled = true;
    try {
      await api(`/api/admin/reservations/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status: status.value, assignee: assignee.value, admin_note: note.value, version: row.version }) });
      row.version++; row.status = status.value; title.lastChild.textContent = labels[row.status]; feedback.textContent = '저장했습니다.'; feedback.className = '';
    } catch (error) { feedback.textContent = error.message; feedback.className = 'error'; }
    finally { save.disabled = false; }
  };
  card.append(form); return card;
}
async function load() {
  try {
    const data = await api(`/api/admin/reservations?page=${page}`);
    $('login-form').classList.add('hidden'); $('dashboard').classList.remove('hidden');
    $('reservation-list').replaceChildren(...data.reservations.map(renderCard));
    if (!data.reservations.length) $('reservation-list').append(element('p', '접수된 요청이 없습니다.'));
    $('notification-warning').textContent = !data.notification_configured ? '카카오 연동이 아직 연결되지 않았습니다. 접수는 저장되지만 카카오톡은 발송되지 않습니다.' : data.notification_provider === 'kakao_self' ? '본인 나와의 채팅에 접수 내역을 전송합니다. 필요하면 직접 단톡방에 전달해주세요.' : '알림의 발송 상태와 접수 목록을 함께 확인해주세요.';
    hasMore = data.has_more; $('previous').disabled = page === 0; $('next').disabled = !hasMore; $('page-label').textContent = `${page+1} 페이지`;
    message('admin-message', '');
  } catch (error) {
    if (error.status === 401) { $('dashboard').classList.add('hidden'); $('login-form').classList.remove('hidden'); $('reservation-list').replaceChildren(); message('admin-message', '원우회 관리자만 확인할 수 있습니다.'); }
    else message('admin-message', error.message, true);
  }
}
