import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore } from '../lib/storage.mjs';
import { CampusService } from '../lib/service.mjs';
import { createApp } from '../server.mjs';

const now = () => new Date('2026-11-10T03:00:00Z');
const category = 'Matching regression';
const report = (kind, overrides = {}) => ({
  kind, name: `${kind} matching item`, category, location: 'Library',
  date: '2026-11-04', description: 'Distinctive matching test item', ...overrides,
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'campus-matching-'));
  let store = new EncryptedStore(directory);
  let service = new CampusService(store, { seed: false, now });
  service.tx(() => {
    service.state.users.push(
      { id: 'admin', name: 'Administrator', role: 'Administrator', status: 'active' },
      { id: 'owner', name: 'Lost reporter', role: 'User', status: 'active' },
      { id: 'finder', name: 'Found reporter', role: 'User', status: 'active' },
      { id: 'claimant', name: 'Other claimant', role: 'User', status: 'active' },
    );
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    service,
    reload() {
      store.close();
      store = new EncryptedStore(directory);
      service = new CampusService(store, { seed: false, now });
      return service;
    },
  };
}

// Controlled persisted records exercise otherwise unreachable combinations (for
// example a blocked Open report), without mocking the matching or storage code.
function record(id, kind, overrides = {}) {
  return {
    ...report(kind), id, ownerId: kind === 'lost' ? 'owner' : 'finder',
    state: kind === 'lost' ? 'Open' : 'Stored', image: null, color: '',
    createdAt: now().toISOString(), updatedAt: now().toISOString(),
    intakeAt: now().toISOString(), blocked: false, specialHandling: false,
    unclaimed: false, notes: [], ...overrides,
  };
}

const candidates = (service, lostId, userId = 'owner') =>
  service.data(service.user(userId)).matches.filter(match => match.lostId === lostId);
const notices = (service, userId = 'owner') => service.data(service.user(userId)).notifications;
const ownership = service => structuredClone({
  items: service.state.items.map(({ id, state, ownerId, blocked }) => ({ id, state, ownerId, blocked })),
  requests: service.state.requests,
});

test('SRS REQ-5.1/5.3/5.5, §5.5.4: lost creation matches every eligible category/date pair; #16 extends Open × Stored to Recovery requested', async t => {
  const f = fixture(t);
  const { service } = f;
  const found = [
    record('boundary', 'found'),
    record('later', 'found', { date: '2026-11-05' }),
    // Recovery requested is the #16 extension, not literal REQ-5.1 wording.
    record('waiting', 'found', { state: 'Recovery requested' }),
    record('wrong-category', 'found', { category: 'Different category' }),
    record('too-early', 'found', { date: '2026-11-03' }),
    ...['Registered', 'Ownership verified', 'Recovered', 'Disposed'].map(state => record(state, 'found', { state })),
    record('blocked-stored', 'found', { blocked: true }),
    record('blocked-waiting', 'found', { state: 'Recovery requested', blocked: true }),
    record('same-owner-stored', 'found', { ownerId: 'owner' }),
    record('same-owner-waiting', 'found', { ownerId: 'owner', state: 'Recovery requested' }),
  ];
  service.tx(() => {
    service.state.items.push(...found);
    service.state.requests.push({ id: 'pending', itemId: 'waiting', userId: 'claimant', status: 'Pending', lostReportId: null, createdAt: service.stamp(), updatedAt: service.stamp() });
  });
  const before = ownership(service);
  const { item: lost } = await service.createItem(() => 'owner', report('lost'));
  assert.deepEqual(new Set(candidates(service, lost.id).map(match => match.foundId)), new Set(['boundary', 'later', 'waiting']));
  assert.deepEqual(ownership(service), { ...before, items: [...before.items, { id: lost.id, state: 'Open', ownerId: 'owner', blocked: false }] });
  assert.deepEqual(new Set(notices(service).map(notification => notification.itemId)), new Set(['boundary', 'later', 'waiting']));
  assert.equal(notices(service).length, 3, 'REQ-5.3: exactly one notification per new pair');
  assert.equal(notices(service, 'finder').length, 0);
  assert.equal(notices(service, 'claimant').length, 0);
  const savedMatches = candidates(service, lost.id);
  const savedNotices = notices(service);
  service.tx(() => { service.generateMatches(lost.id); service.generateMatches(); });
  assert.deepEqual(candidates(service, lost.id), savedMatches);
  assert.deepEqual(notices(service), savedNotices);
  const reloaded = f.reload();
  reloaded.tx(() => reloaded.generateMatches());
  assert.deepEqual(candidates(reloaded, lost.id), savedMatches, 'candidate identities survive reopening SQLite');
  assert.deepEqual(notices(reloaded), savedNotices, 'reload and repeated generation must not notify again');
  assert.deepEqual(ownership(reloaded), ownership(service));
});

test('SRS REQ-5.1/5.3/5.5 and REQ-6.3: intake is the second matching trigger and excludes same-owner, blocked and non-Open lost reports', async t => {
  const { service } = fixture(t);
  service.tx(() => service.state.items.push(
    record('equal', 'lost'),
    record('earlier-loss', 'lost', { date: '2026-11-03' }),
    record('later-loss', 'lost', { date: '2026-11-05' }),
    record('other-category', 'lost', { category: 'Different category' }),
    record('closed', 'lost', { state: 'Closed' }),
    record('withdrawn', 'lost', { state: 'Withdrawn' }),
    record('blocked', 'lost', { blocked: true }),
    record('same-owner', 'lost', { ownerId: 'finder' }),
  ));
  const { item: found } = await service.createItem(() => 'finder', report('found'));
  assert.equal(found.state, 'Registered');
  assert.deepEqual(service.data(service.user('admin')).matches, []);
  assert.deepEqual(notices(service), [], 'Registered creation alone cannot notify a lost reporter');
  const lostBefore = ownership(service).items.filter(item => item.id !== found.id);
  service.itemAction(service.user('admin'), found.id, { action: 'intake', storageLocation: 'Cabinet A', confidential: 'Star underneath' });
  const matches = service.data(service.user('admin')).matches;
  assert.deepEqual(new Set(matches.map(match => match.lostId)), new Set(['equal', 'earlier-loss']));
  assert.ok(matches.every(match => match.foundId === found.id));
  assert.equal(notices(service).length, 2, 'each eligible lost report receives its own candidate notification');
  assert.equal(notices(service, 'finder').length, 0);
  assert.deepEqual(ownership(service).items.filter(item => item.id !== found.id), lostBefore);
  assert.equal(service.item(found.id).state, 'Stored');
  assert.deepEqual(service.data(service.user('admin')).requests, []);
  assert.throws(() => service.createRequest(service.user('finder'), { itemId: found.id, identity: 'Finder', evidence: 'Star underneath' }), { status: 403 });
  const before = notices(service);
  service.tx(() => { service.generateMatches(found.id); service.generateMatches(); });
  assert.deepEqual(notices(service), before);
});

test('SRS REQ-5.2: candidates sort same-place first, then newest found date within both location groups', async t => {
  const f = fixture(t);
  const { service } = f;
  service.tx(() => service.state.items.push(
    record('other-old', 'found', { location: 'Hall', date: '2026-11-05' }),
    record('same-old', 'found', { date: '2026-11-04' }),
    record('other-new', 'found', { location: 'Cafeteria', date: '2026-11-10' }),
    record('same-new', 'found', { date: '2026-11-06', state: 'Recovery requested' }),
    record('same-middle', 'found', { date: '2026-11-05' }),
    record('other-middle', 'found', { location: 'Hall', date: '2026-11-08' }),
  ));
  const { item: lost } = await service.createItem(() => 'owner', report('lost'));
  const expected = ['same-new', 'same-middle', 'same-old', 'other-new', 'other-middle', 'other-old'];
  assert.deepEqual(candidates(service, lost.id).map(match => match.foundId), expected);
  assert.deepEqual(candidates(service, lost.id, 'admin').map(match => match.foundId), expected);
  assert.deepEqual(candidates(f.reload(), lost.id).map(match => match.foundId), expected);
});

test('SRS REQ-5.4/5.5, REQ-6.3/6.5 and §5.5.4: administrator manual matching accepts Stored and #16 Recovery requested without deciding ownership', t => {
  const { service } = fixture(t);
  service.tx(() => {
    service.state.items.push(record('lost', 'lost'), record('stored', 'found'), record('waiting', 'found', { state: 'Recovery requested' }));
    service.state.requests.push(
      { id: 'claim-one', itemId: 'waiting', userId: 'owner', lostReportId: 'lost', status: 'Pending', createdAt: service.stamp(), updatedAt: service.stamp() },
      { id: 'claim-two', itemId: 'waiting', userId: 'claimant', lostReportId: null, status: 'More proof', createdAt: service.stamp(), updatedAt: service.stamp() },
    );
  });
  const before = ownership(service);
  const admin = service.user('admin');
  for (const foundId of ['stored', 'waiting']) {
    const { match } = service.match(admin, { lostId: 'lost', foundId });
    assert.equal(match.foundId, foundId);
    assert.equal(service.match(admin, { lostId: 'lost', foundId }).match.id, match.id);
  }
  assert.equal(candidates(service, 'lost').length, 2);
  assert.equal(notices(service).length, 2, 'repeated manual additions are idempotent');
  assert.deepEqual(ownership(service), before, 'manual candidates cannot approve either competing claim or transfer ownership');
  const removed = candidates(service, 'lost').find(match => match.foundId === 'waiting');
  service.match(admin, {}, removed.id);
  assert.deepEqual(candidates(service, 'lost').map(match => match.foundId), ['stored']);
  assert.equal(notices(service).length, 2, 'removing a suggestion does not emit a new-candidate notification');
  assert.deepEqual(ownership(service), before);
});

test('SRS REQ-5.4 and REQ-6.3: manual matching rejects same-owner, blocked, wrong-kind and inactive records without side effects', t => {
  const { service } = fixture(t);
  service.tx(() => service.state.items.push(
    record('lost', 'lost'), record('found', 'found'),
    record('closed', 'lost', { state: 'Closed' }),
    record('withdrawn', 'lost', { state: 'Withdrawn' }),
    record('blocked-lost', 'lost', { blocked: true }),
    ...['Stored', 'Recovery requested'].flatMap(state => [
      record(`self-${state}`, 'found', { state, ownerId: 'owner' }),
      record(`blocked-${state}`, 'found', { state, blocked: true }),
    ]),
    ...['Registered', 'Ownership verified', 'Recovered', 'Disposed'].map(state => record(state, 'found', { state })),
  ));
  const before = structuredClone(service.state);
  const admin = service.user('admin');
  for (const foundId of ['self-Stored', 'self-Recovery requested', 'blocked-Stored', 'blocked-Recovery requested', 'Registered', 'Ownership verified', 'Recovered', 'Disposed', 'lost']) {
    assert.throws(() => service.match(admin, { lostId: 'lost', foundId }), { status: 409 }, foundId);
  }
  for (const lostId of ['closed', 'withdrawn', 'blocked-lost', 'found']) {
    assert.throws(() => service.match(admin, { lostId, foundId: 'found' }), { status: 409 }, lostId);
  }
  assert.deepEqual(service.state, before, 'rejected additions must not notify, audit, or alter ownership');
});

async function httpFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'campus-matching-http-'));
  let app;
  let origin;
  const start = async () => {
    app = createApp({ dataDir: directory, now });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${app.server.address().port}`;
  };
  await start();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const client = () => {
    let cookie = '';
    return async (path, method = 'GET', body) => {
      const response = await fetch(origin + path, {
        method,
        headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'Content-Type': 'application/json', Origin: origin } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, body: await response.json() };
    };
  };
  const admin = client(), owner = client(), finder = client(), anonymous = client();
  const login = async () => {
    for (const [request, email] of [[admin, 'admin@kaist.ac.kr'], [owner, 'minji@kaist.ac.kr'], [finder, 'finder@kaist.ac.kr']]) {
      assert.equal((await request('/api/auth/login', 'POST', { email, password: 'CampusDemo!24' })).status, 200);
    }
  };
  await login();
  return {
    admin, owner, finder, anonymous,
    async reload() { await app.close(); await start(); await login(); },
  };
}

async function ok(request, path, method = 'GET', body, status = 200) {
  const response = await request(path, method, body);
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
  return response.body;
}
const httpCreate = async (request, kind, overrides) => (await ok(request, '/api/items', 'POST', report(kind, overrides), 201)).item;
const intake = (admin, item) => ok(admin, `/api/items/${item.id}/action`, 'POST', { action: 'intake', storageLocation: 'Matching cabinet', confidential: 'Star underneath' });

test('HTTP SRS REQ-5.1/5.3/5.4/5.5, REQ-6.3/6.5, §5.5.4: #16 Recovery requested automatic/manual candidates, competing claims, authorization and restart persistence', async t => {
  const { admin, owner, finder, anonymous, reload } = await httpFixture(t);
  const found = await httpCreate(finder, 'found');
  await intake(admin, found);
  const first = (await ok(owner, '/api/requests', 'POST', { itemId: found.id, identity: 'First claimant', evidence: 'Star underneath' }, 201)).request;
  const lost = await httpCreate(admin, 'lost');
  let data = await ok(admin, '/api/data');
  let candidate = data.matches.find(match => match.lostId === lost.id && match.foundId === found.id);
  assert.ok(candidate, '#16: lost creation must match an item with an existing pending claim');
  assert.equal(data.items.find(item => item.id === found.id).state, 'Recovery requested');
  const selfLost = await httpCreate(finder, 'lost', { name: 'Finder self-report' });
  assert.ok(!(await ok(admin, '/api/data')).matches.some(match => match.lostId === selfLost.id && match.foundId === found.id));
  assert.equal((await admin('/api/matches', 'POST', { lostId: selfLost.id, foundId: found.id })).status, 409);
  assert.equal((await finder('/api/requests', 'POST', { itemId: found.id, identity: 'Finder', evidence: 'Star underneath' })).status, 403);
  const second = (await ok(admin, '/api/requests', 'POST', { itemId: found.id, lostReportId: lost.id, identity: 'Second claimant', evidence: 'Alternative evidence' }, 201)).request;
  data = await ok(admin, '/api/data');
  const requestsBefore = data.requests.filter(request => request.itemId === found.id);
  assert.deepEqual(new Set(requestsBefore.map(request => request.id)), new Set([first.id, second.id]));
  assert.ok(requestsBefore.every(request => request.status === 'Pending'));
  const matchesBefore = data.matches;
  const noticesBefore = data.notifications;
  for (const [request, status] of [[anonymous, 401], [owner, 403], [finder, 403]]) {
    assert.equal((await request('/api/matches', 'POST', { lostId: lost.id, foundId: found.id })).status, status);
    assert.equal((await request(`/api/matches/${candidate.id}`, 'DELETE')).status, status);
  }
  data = await ok(admin, '/api/data');
  assert.deepEqual(data.matches, matchesBefore, 'unauthorized add/remove attempts cannot alter candidates');
  assert.deepEqual(data.notifications, noticesBefore);
  await ok(admin, `/api/matches/${candidate.id}`, 'DELETE');
  assert.ok(!(await ok(admin, '/api/data')).matches.some(match => match.id === candidate.id));
  candidate = (await ok(admin, '/api/matches', 'POST', { lostId: lost.id, foundId: found.id }, 201)).match;
  assert.equal((await ok(admin, '/api/matches', 'POST', { lostId: lost.id, foundId: found.id }, 201)).match.id, candidate.id);
  data = await ok(admin, '/api/data');
  assert.equal(data.matches.filter(match => match.lostId === lost.id && match.foundId === found.id).length, 1);
  assert.equal(data.notifications.filter(notification => notification.itemId === found.id).length, noticesBefore.filter(notification => notification.itemId === found.id).length + 1, 'only recreation, not repeated manual addition, creates a new-candidate notification');
  assert.deepEqual(data.requests.filter(request => request.itemId === found.id), requestsBefore);
  assert.equal(data.items.find(item => item.id === found.id).state, 'Recovery requested');
  assert.equal(data.items.find(item => item.id === found.id).ownerId, found.ownerId);
  assert.equal(data.items.find(item => item.id === lost.id).state, 'Open');
  assert.equal(data.items.find(item => item.id === lost.id).ownerId, lost.ownerId);
  const savedMatches = data.matches;
  const savedNotices = data.notifications;
  await reload();
  data = await ok(admin, '/api/data');
  assert.deepEqual(data.matches, savedMatches);
  assert.deepEqual(data.notifications, savedNotices);
  assert.deepEqual(data.requests.filter(request => request.itemId === found.id), requestsBefore);
  assert.equal(data.items.find(item => item.id === found.id).state, 'Recovery requested');
  assert.ok((await ok(owner, '/api/data')).requests.some(request => request.id === first.id && request.status === 'Pending'));
  assert.ok(!(await ok(finder, '/api/data')).matches.some(match => match.lostId === selfLost.id && match.foundId === found.id));
});

test('HTTP SRS REQ-5.1/5.4/5.5 and REQ-6.3: intake excludes a pre-existing finder loss; Registered, approved, recovered, disposed and blocked items cannot be manually matched', async t => {
  const { admin, owner, finder } = await httpFixture(t);
  const ownLost = await httpCreate(finder, 'lost');
  const lost = await httpCreate(owner, 'lost');
  const found = await httpCreate(finder, 'found');
  const pair = { lostId: lost.id, foundId: found.id };
  assert.equal((await admin('/api/matches', 'POST', pair)).status, 409, 'Registered is not eligible');
  let data = await ok(owner, '/api/data');
  assert.ok(!data.matches.some(match => match.foundId === found.id));
  assert.ok(!data.notifications.some(notification => notification.itemId === found.id));
  await intake(admin, found);
  data = await ok(admin, '/api/data');
  assert.ok(data.matches.some(match => match.lostId === lost.id && match.foundId === found.id));
  assert.ok(!data.matches.some(match => match.lostId === ownLost.id && match.foundId === found.id), 'intake must also exclude same-owner pairs');
  assert.equal((await admin('/api/matches', 'POST', { lostId: ownLost.id, foundId: found.id })).status, 409);
  const automatic = data.matches.find(match => match.lostId === lost.id && match.foundId === found.id);
  await ok(admin, `/api/matches/${automatic.id}`, 'DELETE');
  await ok(admin, '/api/matches', 'POST', pair, 201);
  const claim = (await ok(owner, '/api/requests', 'POST', { itemId: found.id, identity: 'Owner', evidence: 'Star underneath' }, 201)).request;
  await ok(admin, `/api/requests/${claim.id}/action`, 'POST', { action: 'approve', pickupLocation: 'Official counter', department: 'Student services' });
  assert.equal((await admin('/api/matches', 'POST', pair)).status, 409, 'approved means Ownership verified, not a matchable item');
  data = await ok(admin, '/api/data');
  assert.ok(!data.matches.some(match => match.foundId === found.id));
  assert.equal(data.requests.find(request => request.id === claim.id).status, 'Approved');
  await ok(admin, `/api/items/${found.id}/action`, 'POST', { action: 'handover' });
  assert.equal((await admin('/api/matches', 'POST', pair)).status, 409, 'Recovered is not eligible');
  await ok(admin, `/api/items/${found.id}/action`, 'POST', { action: 'report-error', reason: 'Wrong recipient' });
  assert.equal((await admin('/api/matches', 'POST', pair)).status, 409, 'incident-blocked records cannot be matched');
  const disposed = await httpCreate(finder, 'found', { name: 'Hazardous matching fixture', location: 'Workshop' });
  await intake(admin, disposed);
  await ok(admin, `/api/items/${disposed.id}/action`, 'POST', { action: 'special', value: true });
  await ok(admin, `/api/items/${disposed.id}/action`, 'POST', { action: 'dispose', method: 'authorities', reason: 'Unsafe item' });
  assert.equal((await admin('/api/matches', 'POST', { lostId: lost.id, foundId: disposed.id })).status, 409);
  data = await ok(admin, '/api/data');
  assert.ok(!data.matches.some(match => [found.id, disposed.id].includes(match.foundId)));
  assert.equal(data.items.find(item => item.id === found.id).state, 'Recovered');
  assert.equal(data.items.find(item => item.id === found.id).blocked, true);
  assert.equal(data.items.find(item => item.id === disposed.id).state, 'Disposed');
  assert.equal(data.requests.find(request => request.id === claim.id).status, 'Completed');
  assert.equal(data.items.find(item => item.id === lost.id).state, 'Open', 'an unlinked lost report is not closed by a candidate or someone else’s handover');
});
