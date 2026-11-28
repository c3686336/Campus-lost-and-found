import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore } from '../lib/storage.mjs';
import { CampusService } from '../lib/service.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'campus-notifications-'));
  const store = new EncryptedStore(directory);
  let clock = new Date('2026-11-05T03:00:00Z');
  const service = new CampusService(store, { now: () => clock });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, service, advance(days) { clock = new Date(clock.getTime() + days * 86400000); } };
}

// #28 extends REQ-5.3/6.4 notification UX; §5.3.2–5.3.3 still requires private access.
test('#28 / §5.3.2: one read persists independently, is idempotent and returns detached data', t => {
  const { directory, service } = fixture(t);
  const admin = service.user('demo_admin'), member = service.user('demo_minji');
  service.createRequest(member, { itemId: 'demo_found_earbuds', identity: '김민지', evidence: 'MJ 각인' });
  service.issue(member, { message: '알림 검수' });
  const [target, other] = service.data(admin).notifications;
  const memberBefore = structuredClone(service.data(member).notifications);
  const first = service.readNotification(admin, target.id);
  assert.equal(first.notification.read, true);
  assert.deepEqual(service.readNotification(admin, target.id), first);
  first.notification.message = '응답을 바꿔도 저장된 알림은 유지';
  const current = service.data(admin).notifications;
  assert.equal(current.find(n => n.id === target.id).message, target.message);
  assert.equal(current.find(n => n.id === other.id).read, false);
  assert.deepEqual(service.data(member).notifications, memberBefore);
  const reopened = new EncryptedStore(directory);
  try {
    assert.equal(reopened.read().notifications.find(n => n.id === target.id).read, true);
    assert.equal(reopened.read().notifications.find(n => n.id === other.id).read, false);
  } finally { reopened.close(); }
});

test('#28 / §5.3.3: foreign and missing IDs disclose nothing and change no state', t => {
  const { store, service } = fixture(t);
  const member = service.user('demo_minji'), finder = service.user('demo_finder');
  const target = service.data(member).notifications[0];
  const before = structuredClone(service.state);
  assert.throws(() => service.readNotification(finder, target.id), { status: 404, message: '알림을 찾을 수 없습니다.' });
  assert.throws(() => service.readNotification(finder, 'missing'), { status: 404, message: '알림을 찾을 수 없습니다.' });
  assert.deepEqual(service.state, before);
  assert.deepEqual(store.read(), before);
  service.readNotifications(finder);
  assert.equal(service.data(member).notifications.find(n => n.id === target.id).read, false);
  service.readNotifications(member);
  assert.equal(service.data(member).notifications.find(n => n.id === target.id).read, true);
});

test('#28 / §5.5.6: expired notifications cannot be resurrected by a read', t => {
  const { service, advance } = fixture(t);
  const member = service.user('demo_minji'), admin = service.user('demo_admin');
  const target = service.data(member).notifications[0];
  service.settings(admin, { dataRetentionDays: 1 });
  advance(2);
  assert.ok(!service.data(member).notifications.some(n => n.id === target.id));
  assert.throws(() => service.readNotification(member, target.id), { status: 404 });
  assert.ok(!service.state.notifications.some(n => n.id === target.id));
});

test('#28 / §5.4.2: a failed notification write rolls back memory and persistence before retry', t => {
  const { store, service } = fixture(t);
  const member = service.user('demo_minji');
  const target = service.data(member).notifications[0];
  const before = structuredClone(service.state);
  store.db.exec(`CREATE TRIGGER fail_notification BEFORE INSERT ON records WHEN NEW.collection='notifications'
    BEGIN SELECT RAISE(ABORT, 'injected notification write failure'); END`);
  assert.throws(() => service.readNotification(member, target.id), /injected notification write failure/);
  assert.deepEqual(service.state, before);
  assert.deepEqual(store.read(), before);
  store.db.exec('DROP TRIGGER fail_notification');
  service.readNotification(member, target.id);
  assert.equal(store.read().notifications.find(n => n.id === target.id).read, true);
});
