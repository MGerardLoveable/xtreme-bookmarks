import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildIndex, updateIndexIncrementally, searchBookmarks, getStats, formatSearchResults, getBookmarkById } from '../src/bookmarks-db.js';
import { openDb, saveDb } from '../src/db.js';
import { twitterBookmarksIndexPath } from '../src/paths.js';

const FIXTURES = [
  { id: '1', tweetId: '1', url: 'https://x.com/alice/status/1', text: 'Machine learning is transforming healthcare', authorHandle: 'alice', authorName: 'Alice Smith', syncedAt: '2026-01-01T00:00:00Z', postedAt: '2026-01-01T12:00:00Z', language: 'en', engagement: { likeCount: 100, repostCount: 10 }, mediaObjects: [], links: ['https://example.com'], tags: [], ingestedVia: 'graphql' },
  { id: '2', tweetId: '2', url: 'https://x.com/bob/status/2', text: 'Rust is a great systems programming language', authorHandle: 'bob', authorName: 'Bob Jones', syncedAt: '2026-02-01T00:00:00Z', postedAt: '2026-02-01T12:00:00Z', language: 'en', engagement: { likeCount: 50 }, mediaObjects: [], links: [], tags: [], ingestedVia: 'graphql' },
  { id: '3', tweetId: '3', url: 'https://x.com/alice/status/3', text: 'Deep learning models need massive compute', authorHandle: 'alice', authorName: 'Alice Smith', syncedAt: '2026-03-01T00:00:00Z', postedAt: '2026-03-01T12:00:00Z', language: 'en', engagement: { likeCount: 200, repostCount: 30 }, mediaObjects: [{ type: 'photo', url: 'https://img.com/1.jpg' }], links: [], tags: [], ingestedVia: 'graphql' },
];

async function withIsolatedDataDir(fn: () => Promise<void>, fixtures: any[] = FIXTURES): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ft-test-'));
  const jsonl = fixtures.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(path.join(dir, 'bookmarks.jsonl'), jsonl);

  const saved = process.env.FT_DATA_DIR;
  process.env.FT_DATA_DIR = dir;
  try {
    await fn();
  } finally {
    if (saved !== undefined) process.env.FT_DATA_DIR = saved;
    else delete process.env.FT_DATA_DIR;
  }
}

test('buildIndex creates a searchable database', async () => {
  await withIsolatedDataDir(async () => {
    const result = await buildIndex();
    assert.equal(result.recordCount, 3);
    assert.equal(result.newRecords, 3);
  });
});

test('buildIndex refreshes existing rows without dropping classifications', async () => {
  await withIsolatedDataDir(async () => {
    await buildIndex();

    const dbPath = twitterBookmarksIndexPath();
    const db = await openDb(dbPath);
    try {
      db.run(
        `UPDATE bookmarks
         SET categories = ?, primary_category = ?, domains = ?, primary_domain = ?, github_urls = ?
         WHERE id = ?`,
        ['ai,ml', 'research', 'example.com', 'example.com', '["https://github.com/openai/test"]', '1']
      );
      saveDb(db, dbPath);
    } finally {
      db.close();
    }

    const updatedFixtures = FIXTURES.map((fixture) =>
      fixture.id === '1'
        ? {
            ...fixture,
            text: 'Machine learning note updated',
            bookmarkedAt: '2026-04-02T00:00:00Z',
          }
        : fixture
    );
    const jsonl = updatedFixtures.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(path.join(process.env.FT_DATA_DIR!, 'bookmarks.jsonl'), jsonl);

    const result = await buildIndex();
    assert.equal(result.recordCount, 3);
    assert.equal(result.newRecords, 0);

    const bookmark = await getBookmarkById('1');
    assert.ok(bookmark);
    assert.equal(bookmark.text, 'Machine learning note updated');
    assert.equal(bookmark.bookmarkedAt, '2026-04-02T00:00:00.000Z');
    assert.deepEqual(bookmark.categories, ['ai', 'ml']);
    assert.equal(bookmark.primaryCategory, 'research');
    assert.deepEqual(bookmark.domains, ['example.com']);
    assert.equal(bookmark.primaryDomain, 'example.com');
    assert.deepEqual(bookmark.githubUrls, ['https://github.com/openai/test']);
  });
});

test('updateIndexIncrementally adds new rows without rebuilding existing rows', async () => {
  await withIsolatedDataDir(async () => {
    await buildIndex();
    const added = {
      ...FIXTURES[0],
      id: '4',
      tweetId: '4',
      url: 'https://x.com/carol/status/4',
      text: 'A newly\u2028synced bookmark',
      authorHandle: 'carol',
    };
    const jsonl = [...FIXTURES, added].map((r) => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(path.join(process.env.FT_DATA_DIR!, 'bookmarks.jsonl'), jsonl);

    const result = await updateIndexIncrementally();
    assert.equal(result.recordCount, 4);
    assert.equal(result.newRecords, 1);
    assert.equal((await searchBookmarks({ query: 'newly synced' }))[0]?.id, '4');

    const repeated = await updateIndexIncrementally();
    assert.equal(repeated.recordCount, 4);
    assert.equal(repeated.newRecords, 0);
  });
});

test('updateIndexIncrementally refreshes changed rows and preserves classifications', async () => {
  await withIsolatedDataDir(async () => {
    await buildIndex();
    const dbPath = twitterBookmarksIndexPath();
    const db = await openDb(dbPath);
    try {
      db.run('UPDATE bookmarks SET categories = ?, primary_category = ? WHERE id = ?', ['ai,tools', 'tools', '1']);
      saveDb(db, dbPath);
    } finally {
      db.close();
    }

    const updated = FIXTURES.map((record) => record.id === '1'
      ? { ...record, text: 'A refreshed resilience handbook', sortIndex: '2031520476165046272' }
      : record);
    await writeFile(
      path.join(process.env.FT_DATA_DIR!, 'bookmarks.jsonl'),
      updated.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );

    const result = await updateIndexIncrementally();
    assert.equal(result.newRecords, 0);
    assert.equal((await searchBookmarks({ query: 'resilience handbook' }))[0]?.id, '1');
    assert.equal((await searchBookmarks({ query: 'transforming healthcare' })).length, 0);
    const bookmark = await getBookmarkById('1');
    assert.deepEqual(bookmark?.categories, ['ai', 'tools']);
    assert.equal(bookmark?.primaryCategory, 'tools');

    const check = await openDb(dbPath);
    try {
      assert.equal(check.exec('SELECT sort_index FROM bookmarks WHERE id = ?', ['1'])[0]?.values[0]?.[0], '2031520476165046272');
    } finally {
      check.close();
    }
  });
});

test('only an explicit forced rebuild removes records absent from the archive', async () => {
  await withIsolatedDataDir(async () => {
    await buildIndex();
    await writeFile(
      path.join(process.env.FT_DATA_DIR!, 'bookmarks.jsonl'),
      FIXTURES.slice(0, 2).map((record) => JSON.stringify(record)).join('\n') + '\n',
    );

    assert.equal((await buildIndex()).recordCount, 3);
    assert.equal((await buildIndex({ force: true })).recordCount, 2);
    assert.equal(await getBookmarkById('3'), null);
  });
});

test('searchBookmarks: full-text search returns matching results', async () => {
  await withIsolatedDataDir(async () => {
    await buildIndex();
    const results = await searchBookmarks({ query: 'learning', limit: 10 });
    assert.equal(results.length, 2);
    assert.ok(results.some((r) => r.id === '1'));
    assert.ok(results.some((r) => r.id === '3'));
  });
});

test('searchBookmarks: author filter works', async () => {
  await withIsolatedDataDir(async () => {
    await buildIndex();
    const results = await searchBookmarks({ query: '', author: 'alice', limit: 10 });
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.authorHandle === 'alice'));
  });
});

test('searchBookmarks: combined query + author filter', async () => {
  await withIsolatedDataDir(async () => {
    await buildIndex();
    const results = await searchBookmarks({ query: 'learning', author: 'alice', limit: 10 });
    assert.equal(results.length, 2);
  });
});

test('searchBookmarks: no results for unmatched query', async () => {
  await withIsolatedDataDir(async () => {
    await buildIndex();
    const results = await searchBookmarks({ query: 'cryptocurrency', limit: 10 });
    assert.equal(results.length, 0);
  });
});

test('getStats returns correct aggregate data', async () => {
  await withIsolatedDataDir(async () => {
    await buildIndex();
    const stats = await getStats();
    assert.equal(stats.totalBookmarks, 3);
    assert.equal(stats.uniqueAuthors, 2);
    assert.equal(stats.topAuthors[0].handle, 'alice');
    assert.equal(stats.topAuthors[0].count, 2);
    assert.equal(stats.languageBreakdown[0].language, 'en');
    assert.equal(stats.languageBreakdown[0].count, 3);
  });
});

test('getStats returns chronological date range for legacy Twitter timestamps', async () => {
  const fixtures = [
    {
      id: 'old',
      tweetId: '10',
      url: 'https://x.com/old/status/10',
      text: 'Old tweet',
      authorHandle: 'old',
      authorName: 'Old',
      syncedAt: '2026-04-01T00:00:00Z',
      postedAt: 'Fri Apr 03 12:00:00 +0000 2020',
      mediaObjects: [],
      links: [],
      tags: [],
      ingestedVia: 'graphql',
    },
    {
      id: 'new',
      tweetId: '20',
      url: 'https://x.com/new/status/20',
      text: 'New tweet',
      authorHandle: 'new',
      authorName: 'New',
      syncedAt: '2026-04-01T00:00:00Z',
      postedAt: 'Wed Apr 08 06:30:15 +0000 2026',
      mediaObjects: [],
      links: [],
      tags: [],
      ingestedVia: 'graphql',
    },
  ];

  await withIsolatedDataDir(async () => {
    await buildIndex({ force: true });
    const stats = await getStats();
    assert.equal(stats.dateRange.earliest, '2020-04-03');
    assert.equal(stats.dateRange.latest, '2026-04-08');
  }, fixtures);
});

test('formatSearchResults: formats results with author, date, text, url', () => {
  const results = [
    { id: '1', url: 'https://x.com/test/status/1', text: 'Hello world', authorHandle: 'test', authorName: 'Test', postedAt: '2026-01-15T00:00:00Z', score: -1.5 },
  ];
  const formatted = formatSearchResults(results);
  assert.ok(formatted.includes('@test'));
  assert.ok(formatted.includes('2026-01-15'));
  assert.ok(formatted.includes('Hello world'));
  assert.ok(formatted.includes('https://x.com/test/status/1'));
});

test('formatSearchResults: returns message for empty results', () => {
  assert.equal(formatSearchResults([]), 'No results found.');
});
