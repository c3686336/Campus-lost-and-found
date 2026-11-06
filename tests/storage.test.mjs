import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore } from '../lib/storage.mjs';
import { CampusService } from '../lib/service.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'campus-storage-'));
  const store = new EncryptedStore(directory);
  let clock = new Date('2026-11-06T03:00:00Z');
  const service = new CampusService(store, { now: () => clock });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, service, advance: days => { clock = new Date(clock.getTime() + days * 86400000); } };
}

test('backup failure never undoes a committed change and can be retried explicitly', t => {
  const { store, service } = fixture(t);
  const backup = store.backup.bind(store);
  store.backup = () => { throw new Error('disk full'); };
  service.nextBackupAttempt = 0;
  service.settings(service.user('demo_admin'), { storedDays: 99 });
  assert.equal(service.state.settings.storedDays, 99);
  assert.equal(store.read().settings.storedDays, 99);
  assert.ok(service.data(service.user('demo_admin')).maintenance.backupError);
  assert.equal(service.data(service.user('demo_minji')).maintenance, undefined);
  assert.throws(() => service.backup(true), { status: 503 });
  store.backup = backup;
  assert.ok(service.backup(true));
  assert.equal(service.maintenance.backupError, null);
});

test('a failed SQLite transaction restores memory and cannot partially persist rows', t => {
  const { store, service } = fixture(t);
  const before = structuredClone(service.state);
  store.db.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON records WHEN NEW.collection='audit'
    BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`);
  assert.throws(() => service.settings(service.user('demo_admin'), { storedDays: 88 }), /injected write failure/);
  assert.deepEqual(service.state, before);
  assert.deepEqual(store.read(), before);
  store.db.exec('DROP TRIGGER fail_audit');
  service.settings(service.user('demo_admin'), { storedDays: 77 });
  assert.equal(store.read().settings.storedDays, 77);
});

test('unchanged reads do not write and elapsed retention is still persisted', t => {
  const { store, service, advance } = fixture(t);
  let writes = 0;
  const write = store.write.bind(store);
  store.write = state => { writes++; write(state); };
  for (let i = 0; i < 20; i++) service.data(service.user('demo_minji'));
  assert.equal(writes, 0);
  service.settings(service.user('demo_admin'), { dataRetentionDays: 1 });
  service.itemAction(service.user('demo_minji'), 'demo_lost_umbrella', { action: 'withdraw' });
  writes = 0;
  advance(2);
  assert.ok(!service.data(service.user('demo_minji')).items.some(i => i.id === 'demo_lost_umbrella'));
  assert.equal(writes, 1);
  assert.ok(!store.read().items.some(i => i.id === 'demo_lost_umbrella'));
});

test('legacy encrypted snapshots migrate without changing content or losing encryption', t => {
  const { directory, store, service } = fixture(t);
  const before = structuredClone(service.state);
  store.db.exec('DELETE FROM records');
  store.db.prepare('INSERT INTO state(id,payload) VALUES(1,?)').run(store.encrypt(JSON.stringify(before)));
  const migrated = new EncryptedStore(directory);
  try {
    const reopened = new CampusService(migrated, { now: service.now });
    assert.deepEqual(reopened.state, before);
    assert.equal(migrated.db.prepare('SELECT count(*) AS n FROM state').get().n, 0);
    assert.ok(migrated.db.prepare('SELECT count(*) AS n FROM records').get().n > 1);
    const bytes = readFileSync(migrated.path);
    assert.equal(bytes.includes(Buffer.from('admin@kaist.ac.kr')), false);
    assert.equal(bytes.includes(Buffer.from('별 스티커')), false);
  } finally { migrated.close(); }
});

test('updating one account leaves unrelated ciphertext intact and survives reopening', t => {
  const { directory, store, service } = fixture(t);
  const previous = store.db.prepare("SELECT payload FROM records WHERE collection='items' AND id='demo_found_umbrella'").get().payload;
  service.profile(service.user('demo_minji'), { name: '바뀐 이름' });
  assert.deepEqual(store.db.prepare("SELECT payload FROM records WHERE collection='items' AND id='demo_found_umbrella'").get().payload, previous);
  const reopened = new EncryptedStore(directory);
  try { assert.equal(reopened.read().users.find(u => u.id === 'demo_minji').name, '바뀐 이름'); }
  finally { reopened.close(); }
});

test('encrypted backups restore with the original key and keep the newest seven snapshots', t => {
  const { directory, store, service } = fixture(t);
  for (let i = 0; i < 9; i++) service.backup(true);
  assert.equal(readdirSync(join(directory, 'backups')).filter(n => n.endsWith('.sqlite')).length, 7);
  const name = service.backup(true);
  const recovery = mkdtempSync(join(tmpdir(), 'campus-restore-'));
  try {
    copyFileSync(join(directory, 'backups', name), join(recovery, 'campus.sqlite'));
    copyFileSync(join(directory, 'encryption.key'), join(recovery, 'encryption.key'));
    const restored = new EncryptedStore(recovery);
    try { assert.deepEqual(restored.read(), service.state); }
    finally { restored.close(); }
    assert.ok(!readdirSync(join(directory, 'backups')).some(n => n.endsWith('.tmp')));
  } finally { rmSync(recovery, { recursive: true, force: true }); }
});

test('category/date matching remains complete, ordered, and notification-idempotent', t => {
  const { service } = fixture(t);
  const u = service.user('demo_minji');
  const before = service.state.notifications.length;
  service.generateMatches();
  service.generateMatches();
  assert.equal(service.state.notifications.length, before);
  const same = service.item('demo_found_umbrella');
  const newer = { ...structuredClone(same), id: 'newer-other-place', location: '학생회관', date: '2026-11-06' };
  same.date = '2026-11-05';
  service.item('demo_lost_umbrella').date = '2026-11-04';
  service.state.items.push(newer);
  service.generateMatches();
  const matches = service.data(u).matches.filter(m => m.lostId === 'demo_lost_umbrella');
  assert.deepEqual(matches.map(m => m.foundId), ['demo_found_umbrella', 'newer-other-place']);
  assert.equal(service.item('demo_lost_umbrella').state, 'Open');
  assert.equal(same.state, 'Stored');
});
