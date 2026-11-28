import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/try\{const session=await api\('\/session'\);[\s\S]*$/, '');
const workerSource = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const snapshot = (role = 'Administrator', settings = {}) => ({user: {id: 'u1', role}, items: [], requests: [], matches: [], notifications: [], settings, users: [{id: 'private-admin-data'}], audit: [], issues: []});

function form(name, values) {
  const elements = Object.entries(values).map(([name, value]) => ({name, value, defaultValue: value, type: 'text', tagName: 'INPUT'}));
  elements.namedItem = name => elements.find(field => field.name === name);
  return {dataset: {form: name}, elements};
}
function client(fetch) {
  let forms = [], renders = 0;
  const listeners = {};
  const notice = {classList: {toggle() {}, add() {}, remove() {}}, addEventListener() {}};
  const dialog = {open: false, addEventListener() {}, close() { this.open = false; }, showModal() { this.open = true; }, querySelector() { return null; }};
  const document = {
    activeElement: {tagName: 'BODY'}, hidden: false,
    querySelector(selector) { return selector === '#modal' ? dialog : notice; },
    querySelectorAll() { return forms; }, addEventListener(name, fn) { listeners[name] = fn; }
  };
  const sandbox = {document, navigator: {onLine: true}, window: {addEventListener() {}}, fetch, setInterval() {}, clearTimeout() {}, setTimeout() {}};
  vm.runInNewContext(`${appSource}\nglobalThis.client = {
    configure(state, callback, currentView='settings') { S=state; view=currentView; render=()=>callback(S); },
    refresh, pickup, detail, requestCard, newRequest, card, state:()=>S, view:()=>view,
    submitting(value) { submitting=value; }
  };`, sandbox);
  return {ui: sandbox.client, dialog, document, notice, click(action, id) { const button = {dataset: {action, id}, isConnected: true}; return listeners.click({target: {closest() { return button; }}}); }, get forms() { return forms; }, set forms(value) { forms = value; }, get renders() { return renders; }, render(state) { renders++; forms = [form('settings', state.settings)]; }};
}
const response = data => ({ok: true, json: async () => data});

test('background refresh preserves an unfinished draft while accepting untouched server settings', async () => {
  const latest = snapshot('Administrator', {storedDays: '45', lostDays: '100'});
  const c = client(async () => response(latest));
  c.ui.configure(snapshot('Administrator', {storedDays: '30', lostDays: '90'}), state => c.render(state));
  c.forms = [form('settings', {storedDays: '30', lostDays: '90'})];
  c.forms[0].elements.namedItem('storedDays').value = '60';
  await c.ui.refresh({background: true});
  assert.equal(c.forms[0].elements.namedItem('storedDays').value, '60');
  assert.equal(c.forms[0].elements.namedItem('lostDays').value, '100');
  assert.equal(c.ui.state().settings.storedDays, '45');
});

test('#19 / REQ-6.1, §5.3.3: identity prefill escapes account text and never fills ownership evidence', () => {
  const c = client(async () => response({}));
  const state = snapshot('User');
  state.user.name = 'Kim"><img src=x onerror=alert(1)>';
  state.user.email = 'kim&team@example.org';
  c.ui.configure(state, current => c.render(current));
  c.ui.newRequest('found1');
  assert.ok(c.dialog.innerHTML.includes('value="Kim&quot;&gt;&lt;img src=x onerror=alert(1)&gt; · kim&amp;team@example.org"'));
  assert.ok(!c.dialog.innerHTML.includes('<img src=x'));
  assert.match(c.dialog.innerHTML, /<textarea name="evidence"[^>]*><\/textarea>/);
  assert.match(c.dialog.innerHTML, /<input name="identity"[^>]*required/);
  assert.ok(!c.dialog.innerHTML.match(/name="identity"[^>]*(readonly|disabled)/));
});

test('an older response cannot replace newer data, and background polling waits for submission', async () => {
  const pending = [];
  const c = client(() => new Promise(resolve => pending.push(resolve)));
  c.ui.configure(snapshot(), state => c.render(state));
  const older = c.ui.refresh(), newer = c.ui.refresh();
  pending[1](response(snapshot('Administrator', {storedDays: '45'})));
  await newer;
  pending[0](response(snapshot('Administrator', {storedDays: '30'})));
  await older;
  assert.equal(c.ui.state().settings.storedDays, '45');
  c.ui.submitting(1);
  await c.ui.refresh({background: true});
  assert.equal(pending.length, 2);
});

test('role downgrade closes a privileged dialog and removes administrator state even during typing', async () => {
  const latest = snapshot('User');
  delete latest.users;
  const c = client(async () => response(latest));
  c.ui.configure(snapshot(), state => c.render(state));
  c.dialog.open = true;
  c.document.activeElement.tagName = 'INPUT';
  await c.ui.refresh({background: true});
  assert.equal(c.dialog.open, false);
  assert.equal(c.ui.view(), 'browse');
  assert.equal(c.ui.state().users.length, 0);
});

function worker(caches, fetch = async () => new Response('shell')) {
  const handlers = {};
  const sandbox = {URL, Response, caches, fetch, self: {location: {origin: 'https://campus.example'}, addEventListener(name, fn) { handlers[name] = fn; }, clients: {claim: async () => {}}, skipWaiting: async () => {}}};
  vm.runInNewContext(workerSource, sandbox);
  return handlers;
}

test('worker activation removes only outdated Campus Found caches', async () => {
  const deleted = [];
  const handlers = worker({keys: async () => ['other-app-cache', 'campus-shell-v2', 'campus-shell-v3'], delete: async key => deleted.push(key)});
  let completion;
  handlers.activate({waitUntil(value) { completion = value; }});
  await completion;
  assert.deepEqual(deleted, ['campus-shell-v2']);
});

test('worker never handles private API responses and keeps shell cache writes alive', async () => {
  let finishWrite, startWrite, fetches = 0, cached;
  const writeStarted = new Promise(resolve => { startWrite = resolve; });
  const handlers = worker({open: async () => ({put: async (_request, value) => { cached = await value.text(); await new Promise(resolve => { finishWrite = resolve; startWrite(); }); }}), match: async () => null}, async () => { fetches++; return new Response('new shell'); });
  let result, completion;
  const event = path => ({request: {url: `https://campus.example${path}`, method: 'GET'}, respondWith(value) { result = value; }, waitUntil(value) { completion = value; }});
  handlers.fetch(event('/api/data'));
  assert.equal(fetches, 0);
  assert.equal(result, undefined);
  handlers.fetch(event('/app.js'));
  assert.equal(await (await result).text(), 'new shell');
  await writeStarted;
  assert.equal(cached, 'new shell');
  let completed = false;
  completion.then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  finishWrite();
  await completion;
  assert.equal(completed, true);
});


test('requester sees pickup details only after an authorized audited request', async () => {
  const calls = [];
  const c = client(async (path, options) => {
    calls.push({path, method: options.method});
    return response({pickupLocation: '승인자 전용 장소', department: '담당 부서'});
  });
  const state = snapshot('User');
  state.items = [{id: 'found1', name: 'test item'}];
  c.ui.configure(state, current => c.render(current), 'requests');
  const request = {id: 'request1', itemId: 'found1', status: 'Approved', pickupLocation: '승인자 전용 장소'};
  const card = c.ui.requestCard(request, false);
  assert.ok(card.includes('수령 장소 확인'));
  assert.ok(!card.includes('승인자 전용 장소'));
  await c.ui.pickup('request1');
  assert.deepEqual(calls, [{path: '/api/requests/request1/pickup', method: 'POST'}]);
  assert.equal(c.dialog.open, true);
  assert.ok(c.dialog.innerHTML.includes('승인자 전용 장소'));
});

test('revoked pickup access closes the old dialog and refreshes current authorization', async () => {
  const c = client(async path => path.endsWith('/pickup')
    ? {ok: false, status: 409, json: async () => ({error: '물품이 잠금 처리되었습니다.'})}
    : response(snapshot('User')));
  c.ui.configure(snapshot('User'), current => c.render(current), 'requests');
  c.dialog.open = true;
  await assert.rejects(c.ui.pickup('revoked'), /잠금/);
  assert.equal(c.dialog.open, false);
  assert.equal(c.ui.state().requests.length, 0);
});


test('item detail offers audited pickup access when list responses contain no location fields', () => {
  const c = client(async () => response({}));
  const state = snapshot('User');
  state.items = [{id: 'found1', kind: 'found', name: 'test item', category: '기타', state: 'Ownership verified', location: '발견 장소', date: '2026-11-01', description: 'test'}];
  state.requests = [{id: 'request1', itemId: 'found1', userId: 'u1', status: 'Approved'}];
  c.ui.configure(state, current => c.render(current), 'requests');
  c.ui.detail('found1');
  assert.ok(c.dialog.innerHTML.includes('수령 장소 확인'));
  assert.ok(c.dialog.innerHTML.includes('data-id="request1"'));
});

test('unresolved incident permits administrator correction but exposes no user actions', () => {
  for (const role of ['Administrator', 'User']) {
    const c = client(async () => response({}));
    const state = snapshot(role);
    state.items = [{id: 'incident', kind: 'found', ownerId: 'u1', name: '우산', category: '기타', state: 'Recovered', blocked: true, location: '도서관', date: '2026-11-01', description: '오인도 조사 중'}];
    state.requests = [{id: 'completed', itemId: 'incident', userId: 'u1', status: 'Completed'}];
    c.ui.configure(state, current => c.render(current));
    c.ui.detail('incident');
    assert.equal(c.dialog.innerHTML.includes('data-action="edit"'), role === 'Administrator');
    assert.equal(c.dialog.innerHTML.includes('data-action="resolve"'), role === 'Administrator');
    for (const action of ['pickup', 'new-request', 'handover', 'withdraw', 'toggle-special']) {
      assert.ok(!c.dialog.innerHTML.includes(`data-action="${action}"`));
    }
  }
});

test('#28 / §3.4.1, §5.4.2: failed reads remain unread with feedback and can be retried without reading other notices', async () => {
  let fail = true;
  const c = client(async () => fail
    ? {ok: false, status: 503, json: async () => ({error: '알림을 저장하지 못했습니다.'})}
    : response({}));
  const state = snapshot('User');
  state.notifications = [{id: 'notice1', read: false}, {id: 'notice2', read: false}];
  c.ui.configure(state, current => c.render(current), 'notifications');
  await c.click('notification', 'notice1');
  assert.equal(c.ui.state().notifications[0].read, false);
  assert.equal(c.ui.state().notifications[1].read, false);
  assert.equal(c.notice.textContent, '알림을 저장하지 못했습니다.');
  assert.equal(c.dialog.open, false);
  fail = false;
  await c.click('notification', 'notice1');
  assert.equal(c.ui.state().notifications[0].read, true);
  assert.equal(c.ui.state().notifications[1].read, false);
  assert.equal(c.dialog.open, false);
});

test('REQ-4.3: cards and details distinguish missing photos from an actual uploaded image', async () => {
  const c = client(async () => response({}));
  const state = snapshot('User');
  const item = {id: 'found1', kind: 'found', name: '우산', category: '의류·잡화', state: 'Stored', location: '도서관', date: '2026-11-01', description: '손잡이 특징'};
  state.items = [item];
  c.ui.configure(state, current => c.render(current));
  assert.ok(c.ui.card(item).includes('사진 없음'));
  assert.ok(!c.ui.card(item).includes('<img '));
  c.ui.detail(item.id);
  assert.ok(c.dialog.innerHTML.includes('사진 없음'));
  const image = `data:image/png;base64,${(await readFile(new URL('../public/icon-192.png', import.meta.url))).toString('base64')}`;
  item.image = image;
  assert.ok(c.ui.card(item).includes(`src="${image}"`));
  assert.ok(!c.ui.card(item).includes('사진 없음'));
  c.ui.detail(item.id);
  assert.ok(c.dialog.innerHTML.includes(`src="${image}"`));
  assert.ok(!c.dialog.innerHTML.includes('사진 없음'));
});
