import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildWhere, resolveWebGrabSyncOptions } from '../src/web-server.js';
import { openDb } from '../src/db.js';
import { bookmarkSortClause, hasXOrderSql } from '../src/bookmark-order.js';

test('backfill without a saved cursor starts a non-incremental full scan', () => {
  const options = resolveWebGrabSyncOptions(undefined, 'chrome', undefined, 'backfill');

  assert.equal(options.incremental, false);
  assert.equal(options.resumeCursor, undefined);
  assert.equal(options.stalePageLimit, Infinity);
});

test('quick grab ignores a stale saved backfill cursor', () => {
  const options = resolveWebGrabSyncOptions(
    { lastCursor: 'saved-cursor', stopReason: 'max pages reached' },
    'chrome',
    undefined,
    'quick',
  );

  assert.equal(options.incremental, true);
  assert.equal(options.resumeCursor, undefined);
});

test('Inbox filters by local capture time without changing posted-date filters', () => {
  const captured = buildWhere({ capturedAfter: '2026-07-01T00:00:00.000Z' });
  const posted = buildWhere({ after: '2026-06-01T00:00:00.000Z' });

  assert.match(captured.where, /b\.synced_at >= \?/);
  assert.doesNotMatch(captured.where, /posted_at/);
  assert.match(posted.where, /COALESCE\(b\.posted_at, b\.bookmarked_at\) >= \?/);
  assert.deepEqual(captured.params, ['2026-07-01T00:00:00.000Z']);
});

test('Archive order follows X save positions before tweet publication dates', async () => {
  const db = await openDb(':memory:');
  try {
    db.run(`CREATE TABLE bookmarks (
      id TEXT, tweet_id TEXT, sort_index TEXT, bookmarked_at TEXT, posted_at TEXT
    )`);
    db.run('INSERT INTO bookmarks VALUES (?, ?, ?, ?, ?)', ['saved-first', '100', '999', null, '2020-01-01']);
    db.run('INSERT INTO bookmarks VALUES (?, ?, ?, ?, ?)', ['saved-second', '300', '998', null, '2026-08-09']);
    db.run('INSERT INTO bookmarks VALUES (?, ?, ?, ?, ?)', ['legacy', '400', null, null, '2026-08-10']);

    const rows = db.exec(`SELECT b.id FROM bookmarks b ${bookmarkSortClause('desc')}`);
    assert.deepEqual(rows[0]?.values.map((row) => row[0]), ['saved-first', 'saved-second', 'legacy']);
  } finally {
    db.close();
  }
});

test('X order handles opaque decimal positions without 64-bit casts', async () => {
  const db = await openDb(':memory:');
  try {
    db.run('CREATE TABLE bookmarks (tweet_id TEXT, sort_index TEXT, bookmarked_at TEXT, posted_at TEXT)');
    db.run('INSERT INTO bookmarks VALUES (?, ?, NULL, NULL)', ['1', '99999999999999999999']);
    db.run('INSERT INTO bookmarks VALUES (?, ?, NULL, NULL)', ['2', '100000000000000000000']);
    db.run('INSERT INTO bookmarks VALUES (?, ?, NULL, NULL)', ['3', 'not-a-position']);

    const rows = db.exec(`SELECT b.tweet_id FROM bookmarks b ${bookmarkSortClause('desc')}`);
    assert.deepEqual(rows[0]?.values.map((row) => row[0]), ['2', '1', '3']);
    assert.equal(
      Number(db.exec(`SELECT SUM(CASE WHEN ${hasXOrderSql('b')} THEN 1 ELSE 0 END) FROM bookmarks b`)[0]?.values[0]?.[0]),
      2,
    );
  } finally {
    db.close();
  }
});

test('Library no longer exposes or calls the Today feature', async () => {
  const [library, api, server] = await Promise.all([
    readFile(new URL('../web/js/views/library.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/js/api.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/web-server.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(library, /<h1>Research Library<\/h1>/);
  assert.doesNotMatch(library, /data-section="today"|api\.today|applySection|lib-today/);
  assert.doesNotMatch(api, /\/api\/today|todayAction/);
  assert.doesNotMatch(server, /pathname === '\/api\/today'|todayActionMatch/);
});
