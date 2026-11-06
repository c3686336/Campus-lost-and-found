import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';

let app, dataDir, base, admin, member, finder, outsider, external, externalId;
let clock = Date.parse('2026-11-05T03:00:00Z');
const password = 'CampusDemo!24';
const pdf = { name: 'affiliation.pdf', type: 'application/pdf', data: `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF').toString('base64')}` };

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'campus-found-acceptance-'));
  app = await createApp({ dataDir, seed: true, now: () => new Date(clock) });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${app.server.address().port}`;
  admin = await login('admin@kaist.ac.kr');
  member = await login('minji@kaist.ac.kr');
  finder = await login('finder@kaist.ac.kr');
});

after(async () => {
  if (app?.server.listening) await new Promise(resolve => app.server.close(resolve));
  if (app?.close) await app.close();
  if (dataDir) {
    const cleanupPath = resolve(dataDir);
    assert.equal(dirname(cleanupPath), resolve(tmpdir()));
    assert.ok(basename(cleanupPath).startsWith('campus-found-acceptance-'));
    await rm(cleanupPath, { recursive: true, force: true });
  }
});

async function api(path, cookie, method = 'GET', body, origin = base) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const json = await response.json();
  return { status: response.status, json, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function ok(path, cookie, method = 'GET', body) {
  const result = await api(path, cookie, method, body);
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${path}: ${result.status} ${JSON.stringify(result.json)}`);
  return result.json;
}
async function denied(path, cookie, method = 'GET', body, origin) {
  const result = await api(path, cookie, method, body, origin);
  assert.ok(result.status >= 400 && result.status < 500, `${method} ${path} unexpectedly ${result.status}`);
  return result;
}
async function login(email) {
  const result = await api('/api/auth/login', null, 'POST', { email, password });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.ok(result.cookie);
  return result.cookie;
}
const report = (kind, suffix = '', extra = {}) => ({ kind, name: `검수 물품 ${suffix}`, category: '전자기기', location: `검수 장소 ${suffix}`, date: '2026-11-01', description: '공개 설명입니다.', ...extra });
async function create(cookie, body) { return (await ok('/api/items', cookie, 'POST', body)).item; }
async function act(item, action, body = {}) { return ok(`/api/items/${item.id}/action`, admin, 'POST', { action, ...body }); }

test('세션·동일 출처 검사와 입력 검증이 API에서도 적용된다', async () => {
  await denied('/api/data');
  assert.equal((await ok('/api/session')).user, null);
  await denied('/api/items', member, 'POST', report('lost', 'cross-origin'), 'https://untrusted.example');
  await denied('/api/items', member, 'POST', report('lost', '미래', { date: '2099-01-01' }));
  await denied('/api/items', member, 'POST', report('lost', '누락', { name: '' }));
  await denied('/api/items', finder, 'POST', report('found', '파일', { image: 'data:image/png;base64,aW52YWxpZA==' }));
  await denied('/api/settings', member, 'PATCH', { storedDays: 1 });
  await denied('/api/settings', admin, 'PATCH', { storedDays: -1 });
  const own = await create(member, report('lost', '소유자'));
  await denied(`/api/items/${own.id}`, finder, 'PATCH', { name: '타인 수정' });
  await ok(`/api/items/${own.id}`, member, 'PATCH', { name: '본인 수정' });
  await ok(`/api/items/${own.id}/action`, member, 'POST', { action: 'withdraw' });
  await denied(`/api/items/${own.id}`, member, 'PATCH', { name: '철회 후 수정' });
});

test('KAIST 데모 인증과 외부 문서 승인 전까지 로그인이 차단된다', async () => {
  const schoolEmail = 'acceptance@kaist.ac.kr';
  const registered = await ok('/api/auth/register', null, 'POST', { name: '검수 사용자', email: schoolEmail, password });
  assert.ok(registered.demoCode, '데모 이메일 확인 코드가 필요합니다.');
  await denied('/api/auth/login', null, 'POST', { email: schoolEmail, password });
  await denied('/api/auth/verify', null, 'POST', { email: schoolEmail, code: 'invalid-code' });
  await ok('/api/auth/verify', null, 'POST', { email: schoolEmail, code: registered.demoCode });
  outsider = await login(schoolEmail);

  const email = 'affiliation@example.com';
  await denied('/api/auth/register', null, 'POST', { name: '외부 구성원', email, password });
  await ok('/api/auth/register', null, 'POST', { name: '외부 구성원', email, password, document: pdf });
  await denied('/api/auth/login', null, 'POST', { email, password });
  const data = await ok('/api/data', admin);
  const user = data.users.find(u => u.email === email);
  assert.equal(user?.status, 'pending_admin');
  assert.ok(user.document, '관리자에게 승인용 문서를 제공해야 합니다.');
  externalId = user.id;
  const general = await ok('/api/data', member);
  assert.equal(general.users, undefined);
  assert.ok(!JSON.stringify(general).includes('affiliation.pdf'));
  await denied(`/api/users/${user.id}/action`, member, 'POST', { action: 'approve' });
  await ok(`/api/users/${user.id}/action`, admin, 'POST', { action: 'approve' });
  external = await login(email);
});

test('습득자는 신고만 가능하고 관리자 접수 전 공개되지 않으며 중복을 확인한다', async () => {
  const body = report('found', '접수 검수');
  const found = await create(finder, body);
  assert.equal(found.state, 'Registered');
  await denied(`/api/items/${found.id}`, finder, 'PATCH', { location: '습득자 임의 변경' });
  await denied(`/api/items/${found.id}/action`, finder, 'POST', { action: 'intake', storageLocation: '임의', confidential: '임의' });
  assert.ok(!(await ok('/api/data', member)).items.some(i => i.id === found.id));
  const duplicate = await denied('/api/items', finder, 'POST', body);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.code, 'DUPLICATE');
  assert.ok((await create(finder, { ...body, confirmDuplicate: true })).id);
  await denied(`/api/items/${found.id}/action`, admin, 'POST', { action: 'intake', storageLocation: '사무실', confidential: '' });
  await act(found, 'intake', { storageLocation: '비밀 창고 A', confidential: '안쪽에 특정 일련번호 87531' });
  await ok(`/api/items/${found.id}`, admin, 'PATCH', { location: '정정한 발견 장소' });
  const publicFound = (await ok('/api/data', member)).items.find(i => i.id === found.id);
  assert.equal(publicFound.state, 'Stored');
  assert.equal(publicFound.storageLocation, undefined);
  assert.equal(publicFound.confidential, undefined);
  assert.ok(!JSON.stringify(publicFound).includes('87531'));
});

test('복수 반환 청구·추가 증빙·승인·인도 전 과정에서 소유권과 개인정보를 보호한다', async () => {
  const common = { category: '검수용 분류', location: '검수동', date: '2026-11-02' };
  const lost = await create(member, report('lost', '매칭', { ...common, date: '2026-11-01' }));
  const found = await create(finder, report('found', '매칭', common));
  await act(found, 'intake', { storageLocation: '비공개 서랍 Z', confidential: '개인 식별 특징 12345' });
  const data = await ok('/api/data', member);
  assert.ok(data.matches.some(m => m.lostId === lost.id && m.foundId === found.id));
  assert.equal(data.items.find(i => i.id === found.id).state, 'Stored', '매칭 자체가 소유권을 변경하면 안 됩니다.');
  assert.ok(data.notifications.some(n => n.itemId === found.id || n.message));
  await denied('/api/requests', finder, 'POST', { itemId: found.id, identity: '습득자', evidence: '자신의 신고에 청구' });
  await denied(`/api/items/${found.id}/action`, admin, 'POST', { action: 'handover' });
  const [mineResult, otherResult] = await Promise.all([
    ok('/api/requests', member, 'POST', { itemId: found.id, lostReportId: lost.id, identity: '민지 확인 자료', evidence: '비공개 특징 설명 A' }),
    ok('/api/requests', external, 'POST', { itemId: found.id, identity: '외부 사용자 확인 자료', evidence: '비공개 특징 설명 B' })
  ]);
  const mine = mineResult.request;
  const other = otherResult.request;
  await denied(`/api/requests/${mine.id}/action`, member, 'POST', { action: 'approve', pickupLocation: '임의 장소', department: '임의' });
  await ok(`/api/requests/${mine.id}/action`, admin, 'POST', { action: 'more-proof', reason: '추가 증빙이 필요합니다.' });
  await denied(`/api/requests/${mine.id}/action`, external, 'POST', { action: 'supplement', evidence: '타인 보완' });
  await ok(`/api/requests/${mine.id}/action`, member, 'POST', { action: 'supplement', evidence: '개인 식별 특징 12345' });
  await ok(`/api/requests/${mine.id}/action`, admin, 'POST', { action: 'approve', pickupLocation: '승인자 전용 인도 장소', department: '담당팀' });
  const mineData = await ok('/api/data', member);
  assert.equal(mineData.requests.find(r => r.id === mine.id).status, 'Approved');
  assert.equal(mineData.items.find(i => i.id === found.id).pickupLocation, undefined);
  assert.equal((await ok(`/api/requests/${mine.id}/pickup`, member, 'POST', {})).pickupLocation, '승인자 전용 인도 장소');
  const otherData = await ok('/api/data', external);
  assert.equal(otherData.requests.find(r => r.id === other.id).status, 'Rejected');
  assert.ok(!JSON.stringify(otherData).includes('승인자 전용 인도 장소'));
  assert.ok(!otherData.requests.some(r => r.id === mine.id));
  const finderData = await ok('/api/data', finder);
  assert.ok(!finderData.requests.some(r => r.itemId === found.id));
  assert.ok(!JSON.stringify(finderData).includes('민지 확인 자료'));
  await act(found, 'handover');
  const completed = await ok('/api/data', member);
  assert.equal(completed.items.find(i => i.id === found.id).state, 'Recovered');
  assert.equal(completed.items.find(i => i.id === lost.id).state, 'Closed');
  assert.ok(!(await ok('/api/data', outsider)).items.some(i => i.id === found.id || i.id === lost.id));
  await denied(`/api/items/${found.id}/action`, admin, 'POST', { action: 'handover' });
  await act(found, 'report-error', { reason: '오인도 확인' });
  assert.equal((await ok('/api/data', admin)).items.find(i => i.id === found.id).blocked, true);
  await act(found, 'resolve', { reason: '사실 확인 및 처리 완료' });
  assert.equal((await ok('/api/data', admin)).items.find(i => i.id === found.id).blocked, false);
});

test('특별 취급 이관·기한 경과 미수령 처리와 계정 차단을 강제한다', async () => {
  const hazard = await create(finder, report('found', '위험 물품', { category: '특별 취급 검수' }));
  await act(hazard, 'special', { value: true });
  await act(hazard, 'dispose', { method: 'authorities', reason: '담당 기관 이관' });
  await denied('/api/requests', member, 'POST', { itemId: hazard.id, identity: '신원', evidence: '설명' });
  assert.equal((await ok('/api/data', admin)).items.find(i => i.id === hazard.id).state, 'Disposed');
  const old = await create(finder, report('found', '기한 검수', { category: '기한 검수' }));
  await act(old, 'intake', { storageLocation: '보관실', confidential: '식별 특징' });
  await denied(`/api/items/${old.id}/action`, admin, 'POST', { action: 'dispose', method: 'donate', reason: '기한 전' });
  clock += 31 * 86400000;
  admin = await login('admin@kaist.ac.kr');
  external = await login('affiliation@example.com');
  assert.equal((await ok('/api/data', admin)).items.find(i => i.id === old.id).unclaimed, true);
  await act(old, 'dispose', { method: 'donate', reason: '보관 기간 만료' });
  await ok(`/api/users/${externalId}/action`, admin, 'POST', { action: 'block', reason: '검수 차단' });
  await denied('/api/data', external);
  await denied('/api/auth/login', null, 'POST', { email: 'affiliation@example.com', password });
  const currentAdmin = (await ok('/api/data', admin)).user;
  await denied(`/api/users/${currentAdmin.id}/action`, admin, 'POST', { action: 'role', role: 'User' });
  await denied(`/api/users/${currentAdmin.id}/action`, admin, 'POST', { action: 'block' });
});

test('거절 후 재보관 때 매칭하고 승인 취소 후에는 수령 장소를 숨긴다', async () => {
  const common = { category: '재보관 회귀 검수', location: '검수동 2', date: '2026-11-03' };
  const found = await create(finder, report('found', '재보관', common));
  await act(found, 'intake', { storageLocation: '비공개 보관실', confidential: '검수 비공개 특징' });
  const first = (await ok('/api/requests', member, 'POST', { itemId: found.id, identity: '검수 신원', evidence: '검수 특징' })).request;
  const lost = await create(outsider, report('lost', '신규 대기', { ...common, date: '2026-11-02' }));
  assert.ok(!(await ok('/api/data', outsider)).matches.some(m => m.lostId === lost.id && m.foundId === found.id));
  await ok(`/api/requests/${first.id}/action`, admin, 'POST', { action: 'reject', reason: '특징 불일치' });
  assert.ok((await ok('/api/data', outsider)).matches.some(m => m.lostId === lost.id && m.foundId === found.id), '재보관 상태 전이도 새 매칭을 생성해야 합니다.');

  await act(found, 'special', { value: true });
  const approved = (await ok('/api/requests', member, 'POST', { itemId: found.id, identity: '추가 신원', evidence: '추가 특징' })).request;
  await ok(`/api/requests/${approved.id}/action`, admin, 'POST', { action: 'approve', pickupLocation: '임시 특별 반환 장소', department: '안전팀' });
  await act(found, 'dispose', { method: 'authorities', reason: '반환 대신 담당 기관 이관' });
  const after = await ok('/api/data', member);
  const revoked = after.requests.find(r => r.id === approved.id);
  assert.equal(revoked.status, 'Rejected');
  assert.equal(revoked.pickupLocation, undefined);
  assert.equal(revoked.department, undefined);
  assert.equal(after.items.find(i => i.id === found.id).pickupLocation, undefined);
});
