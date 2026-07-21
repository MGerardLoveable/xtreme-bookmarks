import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupDb, listDbBackups, openDb, restoreDbBackup, saveDb } from '../src/db.js';

test('openDb shares one live database across leases', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-db-shared-'));
  const dbPath = path.join(dir, 'bookmarks.db');
  const first = await openDb(dbPath);
  try {
    first.run('CREATE TABLE values_table (value TEXT)');
    first.run("INSERT INTO values_table VALUES ('first')");
    saveDb(first, dbPath);

    const second = await openDb(dbPath);
    try {
      second.run("INSERT INTO values_table VALUES ('second')");
      saveDb(second, dbPath);
      const rows = first.exec('SELECT value FROM values_table ORDER BY rowid');
      assert.deepEqual(rows[0]?.values, [['first'], ['second']]);
    } finally {
      second.close();
    }
  } finally {
    first.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveDb creates restorable private backups', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-db-backup-'));
  const dbPath = path.join(dir, 'bookmarks.db');
  const db = await openDb(dbPath);
  try {
    db.run('CREATE TABLE sample (value TEXT)');
    saveDb(db, dbPath);
    const backup = backupDb(dbPath, 'test');
    assert.ok(backup);
    assert.equal(fs.statSync(backup.path).mode & 0o777, 0o600);
    assert.equal(listDbBackups(dbPath).length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveDb refuses to overwrite a database changed by another process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-db-stale-'));
  const dbPath = path.join(dir, 'bookmarks.db');
  const db = await openDb(dbPath);
  try {
    db.run('CREATE TABLE sample (value TEXT)');
    saveDb(db, dbPath);
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(dbPath, future, future);
    db.run("INSERT INTO sample VALUES ('unsafe')");
    assert.throws(() => saveDb(db, dbPath), /Refusing to overwrite a newer bookmark database/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restoreDbBackup restores a closed database and preserves the replaced copy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-db-restore-'));
  const dbPath = path.join(dir, 'bookmarks.db');
  const db = await openDb(dbPath);
  db.run('CREATE TABLE sample (value TEXT)');
  db.run("INSERT INTO sample VALUES ('before')");
  saveDb(db, dbPath);
  const backup = backupDb(dbPath, 'known-good');
  db.run("INSERT INTO sample VALUES ('after')");
  saveDb(db, dbPath);
  db.close();

  try {
    assert.ok(backup);
    restoreDbBackup(dbPath, backup.name);
    const restored = await openDb(dbPath);
    try {
      const rows = restored.exec('SELECT value FROM sample ORDER BY rowid');
      assert.deepEqual(rows[0]?.values, [['before']]);
    } finally {
      restored.close();
    }
    assert.ok(listDbBackups(dbPath).some((item) => item.name.includes('before-restore')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
