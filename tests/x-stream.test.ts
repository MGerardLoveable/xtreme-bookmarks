import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, openDb, saveDb } from '../src/db.js';
import {
  buildXWatchRule,
  getXPollQueueSummary,
  initXStreamSchema,
  isRateLimitedBrowserPollError,
  listXStreamItems,
  mergeXStreamRemovedItemsFromDisk,
  normalizeXHandle,
  removeXStreamItem,
  removeXStreamItemAndSave,
  removeXStreamItems,
  saveXStreamTweet,
  startXWatchPollQueue,
} from '../src/x-stream.js';

test('normalizeXHandle accepts friendly handles and rejects invalid input', () => {
  assert.equal(normalizeXHandle('@Karpathy'), 'karpathy');
  assert.equal(normalizeXHandle('openai'), 'openai');
  assert.throws(() => normalizeXHandle('@not valid'), /valid X handle/);
});

test('buildXWatchRule uses the requested filtered stream format', () => {
  assert.equal(
    buildXWatchRule(['@account2', 'account1', '@account3']),
    '(from:account1 OR from:account2 OR from:account3)',
  );
});

test('buildXWatchRule can collect posts only for selected accounts', () => {
  assert.equal(
    buildXWatchRule([
      { handle: '@account1', includeReplies: false },
      { handle: '@account2', includeReplies: true },
    ]),
    '((from:account1 -is:reply) OR from:account2)',
  );
});

test('X Feed poll queue starts every watched account as waiting', async () => {
  const db = await createDb();
  initXStreamSchema(db);
  db.run(
    `INSERT INTO x_watch_accounts (handle, user_id, username, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
    [
      'account1',
      '111',
      'account1',
      'Account One',
      '2026-05-01T00:00:00Z',
      '2026-05-01T00:00:00Z',
      'account2',
      '222',
      'account2',
      'Account Two',
      '2026-05-01T00:00:00Z',
      '2026-05-01T00:00:00Z',
    ],
  );

  const summary = startXWatchPollQueue(db, 'run-test', '2026-05-01T01:00:00Z');
  assert.equal(summary.runId, 'run-test');
  assert.equal(summary.total, 2);
  assert.equal(summary.waiting, 2);
  assert.equal(summary.checked, 0);
  assert.equal(summary.delayed, 0);
  assert.equal(summary.failed, 0);
});

test('X Feed poll queue treats rate-limited accounts as delayed, not missed', async () => {
  const db = await createDb();
  initXStreamSchema(db);
  db.run(
    `INSERT INTO x_watch_accounts (handle, user_id, username, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['account1', '111', 'account1', 'Account One', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'],
  );
  startXWatchPollQueue(db, 'run-rate-limit', '2026-05-01T01:00:00Z');
  db.run(
    `UPDATE x_watch_poll_state
     SET state = 'delayed', last_error = ?, retry_after = ?, consecutive_failures = 1
     WHERE handle = ?`,
    [
      'X browser session 429: Rate limit exceeded',
      '2026-05-01T01:10:00Z',
      'account1',
    ],
  );

  const summary = getXPollQueueSummary(db);
  assert.equal(summary.delayed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.waiting, 0);
  assert.equal(summary.delayedAccounts[0].handle, 'account1');
});

test('X Feed poll error classifier detects X rate limits', () => {
  assert.equal(isRateLimitedBrowserPollError('X browser session 429: Rate limit exceeded'), true);
  assert.equal(isRateLimitedBrowserPollError('fetch failed'), false);
});

test('saveXStreamTweet stores posts and deduplicates by tweet ID', async () => {
  const db = await createDb();
  initXStreamSchema(db);
  db.run(
    `INSERT INTO x_watch_accounts (handle, user_id, username, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['account1', '111', 'account1', 'Account One', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'],
  );

  const payload = {
    data: {
      id: '900',
      text: 'New original post',
      author_id: '111',
      created_at: '2026-05-01T01:00:00Z',
      conversation_id: '900',
    },
    includes: {
      users: [{ id: '111', username: 'account1', name: 'Account One' }],
    },
  };

  assert.equal(saveXStreamTweet(db, payload.data, payload.includes, payload), true);
  assert.equal(saveXStreamTweet(db, payload.data, payload.includes, payload), false);

  const items = listXStreamItems(db);
  assert.equal(items.length, 1);
  assert.equal(items[0].tweetId, '900');
  assert.equal(items[0].itemType, 'post');
  assert.equal(items[0].sourceAccount, 'account1');
});

test('saveXStreamTweet ignores nested tweets from unwatched authors', async () => {
  const db = await createDb();
  initXStreamSchema(db);
  db.run(
    `INSERT INTO x_watch_accounts (handle, user_id, username, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['account1', '111', 'account1', 'Account One', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'],
  );

  const payload = {
    data: {
      id: '907',
      text: 'Nested original from someone else',
      author_id: '999',
      created_at: '2026-05-01T01:30:00Z',
      conversation_id: '907',
    },
    includes: {
      users: [{ id: '999', username: 'not_watched', name: 'Not Watched' }],
    },
  };

  assert.equal(saveXStreamTweet(db, payload.data, payload.includes, payload), false);
  assert.equal(listXStreamItems(db).length, 0);
});

test('saveXStreamTweet marks replies', async () => {
  const db = await createDb();
  initXStreamSchema(db);
  db.run(
    `INSERT INTO x_watch_accounts (handle, user_id, username, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['account1', '111', 'account1', 'Account One', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'],
  );

  const payload = {
    data: {
      id: '901',
      text: 'Replying here',
      author_id: '111',
      created_at: '2026-05-01T02:00:00Z',
      conversation_id: '900',
      in_reply_to_user_id: '222',
      referenced_tweets: [{ type: 'replied_to', id: '900' }],
    },
    includes: {
      users: [{ id: '111', username: 'account1', name: 'Account One' }],
    },
  };

  assert.equal(saveXStreamTweet(db, payload.data, payload.includes, payload), true);
  const items = listXStreamItems(db, 20, 'reply');
  assert.equal(items.length, 1);
  assert.equal(items[0].itemType, 'reply');
  assert.equal(items[0].conversationId, '900');
});

test('browser poller storage shape can save posts and replies with metrics', async () => {
  const db = await createDb();
  initXStreamSchema(db);
  db.run(
    `INSERT INTO x_watch_accounts (handle, user_id, username, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['account1', '111', 'account1', 'Account One', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'],
  );

  const payload = {
    data: {
      id: '902',
      text: 'Browser-session item',
      author_id: '111',
      created_at: '2026-05-01T03:00:00.000Z',
      conversation_id: '900',
      in_reply_to_user_id: '222',
      referenced_tweets: [{ type: 'replied_to', id: '900' }],
      attachments: { media_keys: ['m1'] },
      public_metrics: { reply_count: 1, retweet_count: 2, like_count: 3, impression_count: 4 },
    },
    includes: {
      users: [{ id: '111', username: 'account1', name: 'Account One', profile_image_url: 'https://example.test/a.jpg' }],
      media: [{ media_key: 'm1', type: 'photo', url: 'https://example.test/image.jpg', width: 1200, height: 800 }],
    },
    meta: { source: 'browser-session' },
  };

  assert.equal(saveXStreamTweet(db, payload.data, payload.includes, payload), true);
  const items = listXStreamItems(db, 20, 'reply');
  assert.equal(items.length, 1);
  assert.equal(items[0].tweetId, '902');
  assert.equal(items[0].itemType, 'reply');
  assert.equal(((items[0].rawJson as any).includes.media || [])[0].url, 'https://example.test/image.jpg');
  assert.deepEqual((items[0].rawJson as any).meta, { source: 'browser-session' });
});

test('removeXStreamItem blocks a removed post from being re-added', async () => {
  const db = await createDb();
  initXStreamSchema(db);
  db.run(
    `INSERT INTO x_watch_accounts (handle, user_id, username, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['account1', '111', 'account1', 'Account One', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'],
  );

  const payload = {
    data: {
      id: '903',
      text: 'Remove me',
      author_id: '111',
      created_at: '2026-05-01T04:00:00Z',
      conversation_id: '903',
    },
    includes: {
      users: [{ id: '111', username: 'account1', name: 'Account One' }],
    },
  };

  assert.equal(saveXStreamTweet(db, payload.data, payload.includes, payload), true);
  assert.equal(removeXStreamItem(db, ':memory:', '903'), true);
  assert.equal(saveXStreamTweet(db, payload.data, payload.includes, payload), false);
  assert.equal(listXStreamItems(db).length, 0);
});

test('removed X Feed items survive stale poller database saves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfeed-remove-race-'));
  const dbPath = path.join(dir, 'xfeed.sqlite');
  const db = await createDb();
  initXStreamSchema(db);
  db.run(
    `INSERT INTO x_watch_accounts (handle, user_id, username, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['account1', '111', 'account1', 'Account One', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'],
  );
  const payload = {
    data: {
      id: '906',
      text: 'Remove race',
      author_id: '111',
      created_at: '2026-05-01T06:00:00Z',
      conversation_id: '906',
    },
    includes: {
      users: [{ id: '111', username: 'account1', name: 'Account One' }],
    },
  };
  assert.equal(saveXStreamTweet(db, payload.data, payload.includes, payload), true);
  saveDb(db, dbPath);

  const stalePollerDb = await openDb(dbPath);
  const liveDb = await openDb(dbPath);
  assert.equal(removeXStreamItem(liveDb, dbPath, '906'), true);

  await mergeXStreamRemovedItemsFromDisk(stalePollerDb, dbPath);
  saveDb(stalePollerDb, dbPath);

  const reopened = await openDb(dbPath);
  assert.equal(listXStreamItems(reopened).some((item) => item.tweetId === '906'), false);
  assert.equal(saveXStreamTweet(reopened, payload.data, payload.includes, payload), false);

  db.close();
  stalePollerDb.close();
  liveDb.close();
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removeXStreamItemAndSave preserves existing removals from disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfeed-remove-merge-'));
  const dbPath = path.join(dir, 'xfeed.sqlite');
  const db = await createDb();
  initXStreamSchema(db);
  db.run(
    `INSERT INTO x_watch_accounts (handle, user_id, username, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['account1', '111', 'account1', 'Account One', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'],
  );
  const first = {
    data: {
      id: '908',
      text: 'First removed item',
      author_id: '111',
      created_at: '2026-05-01T06:00:00Z',
      conversation_id: '908',
    },
    includes: {
      users: [{ id: '111', username: 'account1', name: 'Account One' }],
    },
  };
  const second = {
    data: {
      id: '909',
      text: 'Second removed item',
      author_id: '111',
      created_at: '2026-05-01T06:01:00Z',
      conversation_id: '909',
    },
    includes: first.includes,
  };
  assert.equal(saveXStreamTweet(db, first.data, first.includes, first), true);
  assert.equal(saveXStreamTweet(db, second.data, second.includes, second), true);
  saveDb(db, dbPath);

  const staleServerDb = await openDb(dbPath);
  const liveDb = await openDb(dbPath);
  assert.equal(await removeXStreamItemAndSave(liveDb, dbPath, '908'), true);
  assert.equal(await removeXStreamItemAndSave(staleServerDb, dbPath, '909'), true);

  const reopened = await openDb(dbPath);
  assert.equal(saveXStreamTweet(reopened, first.data, first.includes, first), false);
  assert.equal(saveXStreamTweet(reopened, second.data, second.includes, second), false);
  assert.equal(listXStreamItems(reopened).length, 0);

  db.close();
  staleServerDb.close();
  liveDb.close();
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removeXStreamItems can clear one account and keep removed posts blocked', async () => {
  const db = await createDb();
  initXStreamSchema(db);
  db.run(
    `INSERT INTO x_watch_accounts (handle, user_id, username, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
    [
      'account1',
      '111',
      'account1',
      'Account One',
      '2026-05-01T00:00:00Z',
      '2026-05-01T00:00:00Z',
      'account2',
      '222',
      'account2',
      'Account Two',
      '2026-05-01T00:00:00Z',
      '2026-05-01T00:00:00Z',
    ],
  );

  const payload1 = {
    data: {
      id: '904',
      text: 'Clear account one',
      author_id: '111',
      created_at: '2026-05-01T05:00:00Z',
      conversation_id: '904',
    },
    includes: {
      users: [{ id: '111', username: 'account1', name: 'Account One' }],
    },
  };
  const payload2 = {
    data: {
      id: '905',
      text: 'Keep account two',
      author_id: '222',
      created_at: '2026-05-01T05:01:00Z',
      conversation_id: '905',
    },
    includes: {
      users: [{ id: '222', username: 'account2', name: 'Account Two' }],
    },
  };

  assert.equal(saveXStreamTweet(db, payload1.data, payload1.includes, payload1), true);
  assert.equal(saveXStreamTweet(db, payload2.data, payload2.includes, payload2), true);

  assert.equal(removeXStreamItems(db, ':memory:', { sourceAccount: '@account1' }), 1);
  assert.equal(saveXStreamTweet(db, payload1.data, payload1.includes, payload1), false);

  const items = listXStreamItems(db);
  assert.equal(items.length, 1);
  assert.equal(items[0].tweetId, '905');
  assert.equal(items[0].sourceAccount, 'account2');
});
