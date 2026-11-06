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
  const dialog = {open: false, addEventListener() {}, close() { this.open = false; }, showModal() { this.open = true; }, querySelector() { return null; }};
  const document = {
    activeElement: {tagName: 'BODY'}, hidden: false,
    querySelector(selector) { return selector === '#modal' ? dialog : {classList: {toggle() {}}, addEventListener() {}}; },
    querySelectorAll() { return forms; }, addEventListener() {}
  };
  const sandbox = {document, navigator: {onLine: true}, window: {addEventListener() {}}, fetch, setInterval() {}, clearTimeout() {}, setTimeout() {}};
  vm.runInNewContext(`${appSource}\nglobalThis.client = {
    configure(state, callback, currentView='settings') { S=state; view=currentView; render=()=>callback(S); },
    refresh, pickup, detail, requestCard, state:()=>S, view:()=>view,
    submitting(value) { submitting=value; }
  };`, sandbox);
  return {ui: sandbox.client, dialog, document, get forms() { return forms; }, set forms(value) { forms = value; }, get renders() { return renders; }, render(state) { renders++; forms = [form('settings', state.settings)]; }};
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
