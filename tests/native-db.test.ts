import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openNativeDatabase } from '../src/native-db.js';
import { openDb, saveDb, backupDb } from '../src/db.js';

test('native adapter preserves prepared statements, transactions, FTS, and persistence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-native-'));
  const file = path.join(dir, 'bookmarks.db');
  let db = openNativeDatabase(file);
  try {
    db.run('CREATE VIRTUAL TABLE docs USING fts5(body)');
    db.run('BEGIN');
    const statement = db.prepare('INSERT INTO docs(body) VALUES (?)');
    statement.run(['durable research memory']); statement.free();
    db.run('COMMIT');
    assert.equal(db.getRowsModified(), 1);
    assert.deepEqual(db.exec('SELECT body FROM docs WHERE docs MATCH ?', ['memory'])[0].values, [['durable research memory']]);
    db.close(); db = openNativeDatabase(file);
    assert.equal(db.exec('SELECT COUNT(*) FROM docs')[0].values[0][0], 1);
    db.run('BEGIN'); db.run("INSERT INTO docs VALUES ('rollback')"); db.run('ROLLBACK');
    assert.equal(db.exec('SELECT COUNT(*) FROM docs')[0].values[0][0], 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native backup includes committed WAL data', async () => {
  const previous = process.env.XB_DB_DRIVER;
  process.env.XB_DB_DRIVER = 'native';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-native-backup-'));
  const file = path.join(dir, 'bookmarks.db');
  const db = await openDb(file);
  try {
    db.run('CREATE TABLE items(value TEXT)'); db.run("INSERT INTO items VALUES ('saved')");
    saveDb(db, file);
    const backup = backupDb(file, 'wal'); assert.ok(backup);
    const restored = openNativeDatabase(backup.path);
    try { assert.deepEqual(restored.exec('SELECT value FROM items')[0].values, [['saved']]); }
    finally { restored.close(); }
  } finally {
    db.close(); if (previous) process.env.XB_DB_DRIVER = previous; else delete process.env.XB_DB_DRIVER;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
