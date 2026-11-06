import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

// Independent review regressions: verify authorization at the moment an action
// executes, including requests whose JSON body arrives after an account change.
async function fixture(t, options = {}, headers = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'campus-review-'));
  const app = createApp({ dataDir, now: () => new Date('2026-11-06T03:00:00Z'), ...options });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const api = (path, cookie, method = 'GET', body, extraHeaders = {}) => new Promise((resolve, reject) => {
    // Node's HTTP client permits an explicit Host header, as a proxy would
    // preserve it; fetch may replace that header with its connection target.
    const request = httpRequest(origin + path, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
        ...extraHeaders
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          const setCookie = response.headers['set-cookie']?.[0];
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), setCookie, cookie: setCookie?.split(';')[0] });
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const login = async email => {
    const result = await api('/api/auth/login', null, 'POST', { email, password: 'CampusDemo!24' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.cookie;
  };
  const slow = async (path, cookie, method) => {
    let finish;
    let rejectResponse;
    const response = new Promise((resolve, reject) => {
      rejectResponse = reject;
      finish = httpRequest(origin + path, {
        method,
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }
      }, incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => {
          try {
            resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch (error) { reject(error); }
        });
      });
      finish.on('error', reject);
      finish.setTimeout(5000, () => finish.destroy(new Error('Slow-body test timed out.')));
    });
    // Attach before sending so this promise proves the request handler has begun.
    await new Promise((resolve, reject) => {
      const observed = req => {
        if (req.url === path && req.method === method) {
          app.server.off('request', observed);
          resolve();
        }
      };
      app.server.on('request', observed);
      finish.once('error', error => {
        app.server.off('request', observed);
        reject(error);
        rejectResponse(error);
      });
      finish.write('{');
    });
    return { end: fields => finish.end(JSON.stringify(fields).slice(1)), response };
  };
  return { app, api, login, slow };
}

test('login failure limiting uses the same trimmed email as authentication', async t => {
  const { api } = await fixture(t);
  for (let index = 0; index < 5; index++) {
    const result = await api('/api/auth/login', null, 'POST', {
      email: `${' '.repeat(index)}minji@kaist.ac.kr`,
      password: 'WrongPassword!24'
    });
    assert.equal(result.status, 401);
  }
  const limited = await api('/api/auth/login', null, 'POST', {
    email: '     minji@kaist.ac.kr ', password: 'CampusDemo!24'
  });
  assert.equal(limited.status, 429, 'Whitespace must not create a fresh login-attempt bucket.');
});

test('one lost report cannot authorize the handover of two different found items', async t => {
  const { api, login } = await fixture(t);
  const admin = await login('admin@kaist.ac.kr');
  const member = await login('minji@kaist.ac.kr');
  const claims = [];
  for (const itemId of ['demo_found_umbrella', 'demo_found_earbuds']) {
    const result = await api('/api/requests', member, 'POST', {
      itemId, lostReportId: 'demo_lost_umbrella', identity: 'Verified identity', evidence: 'Ownership evidence'
    });
    assert.equal(result.status, 201);
    claims.push(result.body.request.id);
  }
  const approve = id => api(`/api/requests/${id}/action`, admin, 'POST', {
    action: 'approve', pickupLocation: 'Official pickup desk', department: 'Student support'
  });
  assert.equal((await approve(claims[0])).status, 200);
  assert.equal((await approve(claims[1])).status, 409, 'Another approved claim already uses this lost report.');
  assert.equal((await api('/api/items/demo_found_umbrella/action', admin, 'POST', { action: 'handover' })).status, 200);
  assert.equal((await approve(claims[1])).status, 409, 'A completed lost report cannot authorize another claim.');
  assert.equal((await api('/api/items/demo_found_earbuds/action', admin, 'POST', { action: 'handover' })).status, 409);
});

test('blocking an account also rejects its request already waiting for a JSON body', async t => {
  const { api, login, slow } = await fixture(t);
  const admin = await login('admin@kaist.ac.kr');
  const member = await login('minji@kaist.ac.kr');
  const pending = await slow('/api/issues', member, 'POST');
  assert.equal((await api('/api/users/demo_minji/action', admin, 'POST', { action: 'block' })).status, 200);
  pending.end({ message: 'This blocked account must not submit a delayed issue.' });
  assert.equal((await pending.response).status, 401);
  const snapshot = await api('/api/data', admin);
  assert.equal(snapshot.body.issues.length, 0);
});

test('revoking an administrator role applies before a delayed settings request executes', async t => {
  const { api, login, slow } = await fixture(t);
  const admin = await login('admin@kaist.ac.kr');
  const finder = await login('finder@kaist.ac.kr');
  const role = value => api('/api/users/demo_finder/action', admin, 'POST', { action: 'role', role: value });
  assert.equal((await role('Administrator')).status, 200);
  const pending = await slow('/api/settings', finder, 'PATCH');
  // Replace state through a failed mutation as well: old user references must
  // never preserve an administrator grant after rollback and later demotion.
  assert.equal((await api('/api/settings', admin, 'PATCH', { storedDays: 0 })).status, 400);
  assert.equal((await role('User')).status, 200);
  pending.end({ storedDays: 999 });
  assert.equal((await pending.response).status, 403);
  const snapshot = await api('/api/data', admin);
  assert.equal(snapshot.body.settings.storedDays, 30);
});

test('an explicitly configured HTTPS origin supports a host-preserving proxy and secure cookies', async t => {
  const { api } = await fixture(t, { publicOrigin: 'https://demo.example' }, {
    Host: 'demo.example', Origin: 'https://demo.example'
  });
  const credentials = { email: 'minji@kaist.ac.kr', password: 'CampusDemo!24' };
  const result = await api('/api/auth/login', null, 'POST', credentials);
  assert.equal(result.status, 200);
  assert.match(result.setCookie, /; Secure(?:;|$)/);
  assert.equal((await api('/api/data', result.cookie)).status, 200);
  assert.equal((await api('/api/auth/login', null, 'POST', credentials, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await api('/api/auth/login', null, 'POST', credentials, { Host: 'evil.example' })).status, 403);
  assert.equal((await api('/api/auth/login', null, 'POST', credentials, {
    Host: 'evil.example', Origin: 'https://evil.example',
    'X-Forwarded-Host': 'demo.example', 'X-Forwarded-Proto': 'https'
  })).status, 403);
});

test('forwarded headers cannot choose the origin or secure-cookie policy without explicit configuration', async t => {
  const { api } = await fixture(t);
  const credentials = { email: 'minji@kaist.ac.kr', password: 'CampusDemo!24' };
  assert.equal((await api('/api/auth/login', null, 'POST', credentials, {
    Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https'
  })).status, 403);
  const result = await api('/api/auth/login', null, 'POST', credentials, { 'X-Forwarded-Proto': 'https' });
  assert.equal(result.status, 200);
  assert.doesNotMatch(result.setCookie, /; Secure(?:;|$)/);
});

test('pickup access requires the approved requester and records an audit event, with incident blocking', async t => {
  const { api, login } = await fixture(t);
  const admin = await login('admin@kaist.ac.kr');
  const member = await login('minji@kaist.ac.kr');
  const finder = await login('finder@kaist.ac.kr');
  const created = await api('/api/requests', member, 'POST', {
    itemId: 'demo_found_umbrella', identity: 'Verified identity', evidence: 'Ownership evidence'
  });
  assert.equal(created.status, 201);
  const id = created.body.request.id;
  const pickup = cookie => api(`/api/requests/${id}/pickup`, cookie, 'POST', {});
  assert.equal((await pickup(member)).status, 403, 'Pending claims must not receive the pickup location.');
  assert.equal((await api(`/api/requests/${id}/action`, admin, 'POST', {
    action: 'approve', pickupLocation: 'Approved requester desk', department: 'Student support'
  })).status, 200);
  assert.equal((await pickup(finder)).status, 403);
  assert.equal((await pickup(admin)).status, 403, 'This endpoint audits requester access, not administrative inspection.');
  const memberSnapshot = await api('/api/data', member);
  assert.equal(memberSnapshot.body.requests.find(entry => entry.id === id).pickupLocation, undefined);
  assert.equal(memberSnapshot.body.requests.find(entry => entry.id === id).department, undefined);
  assert.equal(memberSnapshot.body.items.find(entry => entry.id === 'demo_found_umbrella').pickupLocation, undefined);
  const result = await pickup(member);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { pickupLocation: 'Approved requester desk', department: 'Student support' });
  const snapshot = await api('/api/data', admin);
  const access = snapshot.body.audit.filter(entry => entry.action === '수령 장소 열람' && entry.targetId === id);
  assert.equal(access.length, 1);
  assert.equal(access[0].actorId, 'demo_minji');
  assert.equal((await api('/api/items/demo_found_umbrella/action', admin, 'POST', { action: 'handover' })).status, 200);
  assert.equal((await api('/api/items/demo_found_umbrella/action', admin, 'POST', { action: 'report-error', reason: 'Identity recheck' })).status, 200);
  assert.equal((await pickup(member)).status, 409);
  const blocked = await api('/api/data', member);
  assert.equal(blocked.body.requests.find(entry => entry.id === id).pickupLocation, undefined);
});

test('reported occurrence times validate HH:mm and survive updates and authorized reads', async t => {
  const { api, login } = await fixture(t);
  const member = await login('minji@kaist.ac.kr');
  const body = {
    kind: 'lost', name: 'Timed report', category: '기타', location: 'Library',
    date: '2026-11-05', description: 'Report with an approximate occurrence time.'
  };
  for (const occurredTime of ['24:00', '12:60', '9:05', '09:5', '09:05:00', 905]) {
    assert.equal((await api('/api/items', member, 'POST', { ...body, occurredTime })).status, 400);
  }
  const created = await api('/api/items', member, 'POST', { ...body, occurredTime: '00:00' });
  assert.equal(created.status, 201);
  const id = created.body.item.id;
  assert.equal(created.body.item.occurredTime, '00:00');
  assert.equal((await api(`/api/items/${id}`, member, 'PATCH', { occurredTime: '23:59' })).status, 200);
  assert.equal((await api(`/api/items/${id}`, member, 'PATCH', { occurredTime: '25:00' })).status, 400);
  const snapshot = await api('/api/data', member);
  assert.equal(snapshot.body.items.find(entry => entry.id === id).occurredTime, '23:59');
  assert.equal((await api('/api/items', member, 'POST', body)).status, 201, 'Occurrence time remains optional.');
});

test('withdrawing an open lost report detaches approved claims and is not undone by handover', async t => {
  const { api, login } = await fixture(t);
  const admin = await login('admin@kaist.ac.kr');
  const member = await login('minji@kaist.ac.kr');
  const created = await api('/api/requests', member, 'POST', {
    itemId: 'demo_found_umbrella', lostReportId: 'demo_lost_umbrella',
    identity: 'Verified identity', evidence: 'Ownership evidence'
  });
  const id = created.body.request.id;
  assert.equal((await api(`/api/requests/${id}/action`, admin, 'POST', {
    action: 'approve', pickupLocation: 'Official pickup desk', department: 'Student support'
  })).status, 200);
  assert.equal((await api('/api/items/demo_lost_umbrella/action', member, 'POST', { action: 'withdraw' })).status, 200);
  let snapshot = await api('/api/data', member);
  assert.equal(snapshot.body.requests.find(entry => entry.id === id).lostReportId, null);
  assert.equal((await api('/api/items/demo_found_umbrella/action', admin, 'POST', { action: 'handover' })).status, 200);
  snapshot = await api('/api/data', member);
  assert.equal(snapshot.body.items.find(entry => entry.id === 'demo_lost_umbrella').state, 'Withdrawn');
  assert.equal(snapshot.body.requests.find(entry => entry.id === id).status, 'Completed');
});
