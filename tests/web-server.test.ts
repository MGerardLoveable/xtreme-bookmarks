import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildWhere,
  dedupeHomeWorkspaces,
  resolveBrowserAttemptOrder,
  resolveBookmarkListSort,
  resolveWebGrabSyncOptions,
} from '../src/web-server.js';
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

test('bookmark grab retries the last working browser first without duplicates', () => {
  assert.deepEqual(
    resolveBrowserAttemptOrder(['chrome', 'edge', 'brave', 'edge'], 'brave'),
    ['brave', 'chrome', 'edge'],
  );
  assert.deepEqual(
    resolveBrowserAttemptOrder(['chrome', 'edge'], 'firefox'),
    ['chrome', 'edge'],
  );
});

test('Inbox filters by local capture time without changing posted-date filters', () => {
  const captured = buildWhere({ capturedAfter: '2026-07-01T00:00:00.000Z' });
  const posted = buildWhere({ after: '2026-06-01T00:00:00.000Z' });

  assert.match(captured.where, /b\.synced_at >= \?/);
  assert.doesNotMatch(captured.where, /posted_at/);
  assert.match(posted.where, /COALESCE\(b\.posted_at, b\.bookmarked_at\) >= \?/);
  assert.deepEqual(captured.params, ['2026-07-01T00:00:00.000Z']);
});

test('bookmark list sort keeps relevance as an explicit search mode', () => {
  assert.equal(resolveBookmarkListSort('relevance'), 'relevance');
  assert.equal(resolveBookmarkListSort('newest'), 'desc');
  assert.equal(resolveBookmarkListSort('oldest'), 'asc');
  assert.equal(resolveBookmarkListSort('unexpected'), 'desc');
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

test('legacy archive order falls back to ISO timestamps before tweet ids', async () => {
  const db = await openDb(':memory:');
  try {
    db.run('CREATE TABLE bookmarks (id TEXT, tweet_id TEXT, sort_index TEXT, bookmarked_at TEXT, posted_at TEXT)');
    db.run('INSERT INTO bookmarks VALUES (?, ?, NULL, NULL, ?)', ['older-high-id', '999', '2026-01-01T00:00:00.000Z']);
    db.run('INSERT INTO bookmarks VALUES (?, ?, NULL, NULL, ?)', ['newer-low-id', '100', '2026-08-01T00:00:00.000Z']);

    const rows = db.exec(`SELECT b.id FROM bookmarks b ${bookmarkSortClause('desc')}`);
    assert.deepEqual(rows[0]?.values.map((row) => row[0]), ['newer-low-id', 'older-high-id']);
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

test('Library provides newest and oldest saved ordering for text search', async () => {
  const library = await readFile(new URL('../web/js/views/library.js', import.meta.url), 'utf8');

  assert.match(library, /id="lib-search-sort"/);
  assert.match(library, />Best match<\/option>/);
  assert.match(library, />Newest saved<\/option>/);
  assert.match(library, />Oldest saved<\/option>/);
});

test('Topics provides an editable accept or dismiss review queue for workspace findings', async () => {
  const [brain, api, server] = await Promise.all([
    readFile(new URL('../web/js/views/brain.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/js/api.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/web-server.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(brain, /data-finding-edit/);
  assert.match(brain, /data-finding-quick="accepted"/);
  assert.match(brain, /data-finding-quick="dismissed"/);
  assert.match(brain, /Accept into memory/);
  assert.match(brain, /data-finding-filter="open"/);
  assert.match(brain, /data-finding-filter="accepted"/);
  assert.match(brain, /data-finding-filter="dismissed"/);
  assert.match(api, /decideBrainFinding/);
  assert.match(api, /decision=/);
  assert.match(server, /\/api\/brain\/agents\/findings/);
  assert.match(brain, /Recall and apply/);
  assert.match(brain, /Explain it from memory/);
  assert.match(brain, /Source-backed answer/);
  assert.match(brain, /Practice on Home/);
  assert.match(api, /scheduleBrainPractice/);
  assert.match(server, /queueBookmarkForRecallFromDb/);
});

test('Home exposes recall and working-knowledge actions without restoring Today', async () => {
  const [index, app, home, api, server, layout] = await Promise.all([
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/js/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/js/views/home.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/js/api.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/web-server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../web/css/layout.css', import.meta.url), 'utf8'),
  ]);

  assert.match(index, /data-view="home"/);
  assert.match(app, /home:\s*HomeView/);
  assert.match(home, /Worth bringing back/);
  assert.match(home, /Recall session/);
  assert.match(home, /data-practice-reveal/);
  assert.match(home, /data-recall-action="again"/);
  assert.match(home, /data-recall-action="remembered"/);
  assert.match(home, /Recent progress/);
  assert.match(home, /home-progress-list/);
  assert.match(home, /data-ask-source/);
  assert.match(home, /data-file-source/);
  assert.match(home, /data-recall-action="done"/);
  assert.match(home, /data-recall-action="snooze"/);
  assert.match(home, /ask:\s*\{\s*question:/);
  assert.match(api, /homeRecallAction/);
  assert.match(server, /pathname === '\/api\/home'/);
  assert.match(server, /homeRecallMatch/);
  assert.match(server, /reviewRecallQueueItemFromDb/);
  assert.match(layout, /grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(home, /Today/);
});

test('Ask waits for the server fallback and opens cited bookmarks by immutable ID', async () => {
  const [ask, app, library] = await Promise.all([
    readFile(new URL('../web/js/views/ask.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/js/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/js/views/library.js', import.meta.url), 'utf8'),
  ]);

  assert.match(ask, /ASK_BROWSER_TIMEOUT_MS\s*=\s*200_000/);
  assert.match(ask, /bookmarkId:\s*item\.itemId/);
  assert.match(ask, /typeof payload === 'string'/);
  assert.match(app, /views\.library\?\.openBookmark/);
  assert.match(library, /openBookmark\(id\)/);
});

test('Home combines historical copies of the same workspace for display', () => {
  const base = {
    name: 'Useful Tools',
    description: '',
    keywords: ['tools'],
    category: null,
    domain: null,
    collection: null,
    kind: 'project' as const,
    status: 'active' as const,
    focusQuestion: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeededAt: null,
    pagePath: '/tmp/useful-tools.md',
    repoCount: 0,
  };
  const result = dedupeHomeWorkspaces([
    {
      ...base,
      id: 'useful-tools',
      updatedAt: '2026-01-02T00:00:00.000Z',
      lastAgentRunAt: null,
      bookmarkCount: 12,
      openFindings: 2,
    },
    {
      ...base,
      id: 'useful-tools-2',
      description: 'Tools worth testing',
      focusQuestion: 'Which tools deserve a trial?',
      updatedAt: '2026-01-03T00:00:00.000Z',
      lastAgentRunAt: '2026-01-03T00:00:00.000Z',
      bookmarkCount: 14,
      openFindings: 5,
    },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'useful-tools');
  assert.equal(result[0].combinedWorkspaceCount, 2);
  assert.equal(result[0].bookmarkCount, 14);
  assert.equal(result[0].openFindings, 5);
  assert.equal(result[0].focusQuestion, 'Which tools deserve a trial?');
});
