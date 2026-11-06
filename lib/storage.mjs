import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync, unlinkSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

const COLLECTIONS = ['users', 'items', 'requests', 'matches', 'notifications', 'audit', 'issues'];

export class EncryptedStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.directory = directory;
    const keyPath = join(directory, 'encryption.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    this.key = readFileSync(keyPath);
    this.path = join(directory, 'campus.sqlite');
    this.db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, payload BLOB NOT NULL,
        PRIMARY KEY(collection, id)
      )`);
    this.fingerprints = new Map();
    this.dailyBackup = null;
  }

  decrypt(payload) {
    const bytes = Buffer.from(payload);
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
  }

  encrypt(serialized) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(serialized), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }

  fingerprint(serialized, position) {
    return `${position}:${createHash('sha256').update(serialized).digest('hex')}`;
  }

  read() {
    this.fingerprints.clear();
    const rows = this.db.prepare('SELECT collection,id,position,payload FROM records ORDER BY collection,position').all();
    if (!rows.length) {
      // Legacy databases held one encrypted JSON document. The next write migrates it atomically.
      const row = this.db.prepare('SELECT payload FROM state WHERE id=1').get();
      return row ? this.decrypt(row.payload) : null;
    }
    const state = Object.fromEntries(COLLECTIONS.map(name => [name, []]));
    for (const row of rows) {
      const value = this.decrypt(row.payload);
      if (row.collection === 'settings') state.settings = value;
      else if (COLLECTIONS.includes(row.collection)) state[row.collection].push(value);
      this.fingerprints.set(`${row.collection}:${row.id}`, this.fingerprint(JSON.stringify(value), row.position));
    }
    return state;
  }

  write(state) {
    const next = new Map();
    const upsert = this.db.prepare(`INSERT INTO records(collection,id,position,payload) VALUES(?,?,?,?)
      ON CONFLICT(collection,id) DO UPDATE SET position=excluded.position,payload=excluded.payload`);
    const remove = this.db.prepare('DELETE FROM records WHERE collection=? AND id=?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const save = (collection, id, value, position) => {
        const key = `${collection}:${id}`, serialized = JSON.stringify(value);
        const fingerprint = this.fingerprint(serialized, position);
        next.set(key, fingerprint);
        if (this.fingerprints.get(key) !== fingerprint) upsert.run(collection, id, position, this.encrypt(serialized));
      };
      for (const collection of COLLECTIONS) state[collection].forEach((value, index) => save(collection, value.id, value, index));
      save('settings', 'settings', state.settings, 0);
      for (const key of this.fingerprints.keys()) if (!next.has(key)) {
        const colon = key.indexOf(':');
        remove.run(key.slice(0, colon), key.slice(colon + 1));
      }
      this.db.exec('DELETE FROM state; COMMIT');
      this.fingerprints = next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  backup(date = new Date(), force = false) {
    const day = date.toISOString().slice(0, 10);
    if (!force && this.dailyBackup?.day === day) return this.dailyBackup.name;
    const folder = join(this.directory, 'backups');
    mkdirSync(folder, { recursive: true });
    const name = `campus-${day}${force ? '-' + Date.now() + '-' + randomBytes(3).toString('hex') : ''}.sqlite`;
    const target = join(folder, name);
    if (!existsSync(target)) {
      const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        copyFileSync(this.path, temporary);
        renameSync(temporary, target);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    const backups = readdirSync(folder).filter(n => /^campus-.*\.sqlite$/.test(n))
      .map(name => ({ name, modified: statSync(join(folder, name)).mtimeMs }))
      .sort((a, b) => a.modified - b.modified || Number(a.name === name) - Number(b.name === name) || a.name.localeCompare(b.name));
    for (const old of backups.slice(0, -7)) unlinkSync(join(folder, old.name));
    if (!force) this.dailyBackup = { day, name };
    this.lastBackupAt = statSync(target).mtime.toISOString();
    return name;
  }

  close() { this.db.close(); }
}
