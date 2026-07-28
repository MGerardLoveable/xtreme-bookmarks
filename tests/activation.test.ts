import test from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { initBrainSchema } from '../src/brain.js';
import {
  activationSchemaPending,
  addBookmarkToProjectFromDb,
  brainCycleBacklogPendingFromDb,
  brainCycleDueFromDb,
  brainCyclePendingCountFromDb,
  ensureActivationSchema,
  generateTodayQueueFromDb,
  getAuthorDossierFromDb,
  getBookmarkActivationDetailsFromDb,
  getBrainCycleStatusFromDb,
  runBrainCycleFromDb,
  todayKey,
  updateTodayQueueItemFromDb,
  upsertActivationProfileFromDb,
} from '../src/activation.js';

async function activationFixture() {
  const db = await createDb();
  db.run(`CREATE TABLE bookmarks (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    author_handle TEXT,
    author_name TEXT,
    author_profile_image_url TEXT,
    primary_category TEXT,
    domains TEXT,
    primary_domain TEXT,
    url TEXT,
    posted_at TEXT,
    bookmarked_at TEXT,
    synced_at TEXT,
    source_hash TEXT
  )`);
  db.run(`CREATE TABLE bookmark_notes (
    bookmark_id TEXT PRIMARY KEY,
    note TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE bookmark_read_status (
    bookmark_id TEXT PRIMARY KEY,
    is_read INTEGER NOT NULL DEFAULT 0,
    read_at TEXT
  )`);
  initBrainSchema(db);
  db.run(
    `INSERT INTO bookmarks VALUES
      ('a', 'Agent memory systems improve when evidence and personal notes stay separate.', 'alice', 'Alice', NULL, 'ai', 'example.com', 'example.com', 'https://x.com/alice/status/a', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', '2025-01-02T00:00:00Z', 'hash-a'),
      ('b', 'A new model launch changes the cost of long running agent workflows.', 'alice', 'Alice', NULL, 'ai', 'models.example', 'models.example', 'https://x.com/alice/status/b', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', 'hash-b'),
      ('c', 'A practical research workflow should end in a decision or experiment.', 'bob', 'Bob', NULL, 'research', 'lab.example', 'lab.example', 'https://x.com/bob/status/c', '2024-02-01T00:00:00Z', '2024-02-02T00:00:00Z', '2024-02-02T00:00:00Z', 'hash-c')`,
  );
  db.run(
    `INSERT INTO bookmark_notes VALUES
     ('a', 'Use this when designing the retrieval layer.', '2026-07-21T00:00:00Z')`,
  );
  return db;
}

test('activation schema is additive and profiles preserve user intent', async () => {
  const db = await activationFixture();
  try {
    assert.equal(activationSchemaPending(db), true);
    ensureActivationSchema(db);
    assert.equal(activationSchemaPending(db), false);
    const profile = upsertActivationProfileFromDb(db, 'a', {
      intent: 'build',
      whySaved: 'Apply this to a source-backed research assistant.',
      importance: 5,
      nextReviewAt: '2026-01-01T00:00:00Z',
    });
    assert.equal(profile.intent, 'build');
    assert.equal(profile.importance, 5);
    assert.match(profile.whySaved, /source-backed/);

    const details = getBookmarkActivationDetailsFromDb(db, 'a');
    assert.deepEqual(details.profile, profile);
  } finally {
    db.close();
  }
});

test('Today queue uses explainable scoring and supports review actions', async () => {
  const db = await activationFixture();
  try {
    ensureActivationSchema(db);
    initBrainSchema(db);
    db.run(
      `INSERT INTO brain_spaces (
        id, name, description, keywords_json, category, domain, collection,
        created_at, updated_at, page_path, kind, status, focus_question
      ) VALUES ('memory-project', 'Memory project', '', '[]', NULL, NULL, NULL,
        '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', 'memory.md',
        'project', 'active', 'How should recall work?')`,
    );
    upsertActivationProfileFromDb(db, 'a', {
      intent: 'build',
      whySaved: 'Useful for the current memory project.',
      importance: 5,
      nextReviewAt: '2026-01-01T00:00:00Z',
    });
    addBookmarkToProjectFromDb(db, 'a', 'memory-project', 'decision');
    db.run(
      `INSERT INTO brain_space_bookmarks
       (space_id, bookmark_id, source, score, added_at)
       VALUES ('memory-project', 'b', 'seed', 0.5, '2026-07-20T00:00:00Z')`,
    );

    const queue = generateTodayQueueFromDb(db, {
      date: '2026-07-27',
      limit: 3,
      force: true,
    });
    assert.ok(queue.length >= 1);
    assert.equal(queue[0].bookmarkId, 'a');
    assert.equal(queue[0].reason, 'overdue_review');
    assert.ok(queue[0].scoreBreakdown.some((part) => part.key === 'why'));
    assert.ok(queue[0].scoreBreakdown.some((part) => part.key === 'project'));
    assert.deepEqual(getBookmarkActivationDetailsFromDb(db, 'b').projects, []);

    const acted = updateTodayQueueItemFromDb(db, queue[0].id, 'done');
    assert.equal(acted?.status, 'done');
  } finally {
    db.close();
  }
});

test('Today fills an unclassified daily queue while preserving author diversity', async () => {
  const db = await activationFixture();
  try {
    ensureActivationSchema(db);
    for (let index = 0; index < 8; index += 1) {
      db.run(
        `INSERT INTO bookmarks (
          id, text, author_handle, author_name, primary_category, url,
          posted_at, bookmarked_at, synced_at, source_hash
        ) VALUES (?, ?, ?, ?, 'unclassified', ?, ?, ?, ?, ?)`,
        [
          `daily-${index}`,
          `A distinct research signal number ${index} with enough detail to revisit and use in a practical decision.`,
          `author-${index}`,
          `Author ${index}`,
          `https://x.com/author-${index}/status/${index}`,
          '2026-07-25T00:00:00Z',
          '2026-07-25T00:00:00Z',
          '2026-07-25T00:00:00Z',
          `hash-${index}`,
        ],
      );
    }

    const queue = generateTodayQueueFromDb(db, {
      date: '2026-07-27',
      limit: 7,
      force: true,
    });
    assert.equal(queue.length, 7);
  } finally {
    db.close();
  }
});

test('Brain Cycle enriches incrementally and author dossiers connect the results', async () => {
  const db = await activationFixture();
  try {
    ensureActivationSchema(db);
    const targeted = runBrainCycleFromDb(db, {
      budget: 1,
      bookmarkIds: ['a'],
    });
    assert.equal(targeted.enriched, 1);
    assert.equal(getBookmarkActivationDetailsFromDb(db, 'a').enrichment?.bookmarkId, 'a');

    const first = runBrainCycleFromDb(db, { budget: 10 });
    assert.equal(first.status, 'success');
    assert.equal(first.enriched, 2);
    assert.ok(first.claimsCreated >= 2);

    const second = runBrainCycleFromDb(db, { budget: 10 });
    assert.equal(second.enriched, 0);

    const refreshed = runBrainCycleFromDb(db, {
      budget: 1,
      bookmarkIds: ['a'],
      force: true,
    });
    assert.equal(refreshed.enriched, 1);

    const status = getBrainCycleStatusFromDb(db);
    assert.equal(status.enriched, 3);
    assert.equal(status.pending, 0);

    const dossier = getAuthorDossierFromDb(db, '@alice');
    assert.equal(dossier?.totals.bookmarks, 2);
    assert.equal(dossier?.totals.enriched, 2);
    assert.ok((dossier?.claims.length ?? 0) >= 2);
    assert.equal(dossier?.recentSignals[0].id, 'b');
  } finally {
    db.close();
  }
});

test('Brain Cycle records partial backlog state until every batch is current', async () => {
  const db = await activationFixture();
  try {
    ensureActivationSchema(db);
    const first = runBrainCycleFromDb(db, { budget: 1 });
    assert.equal(first.pendingAfter, 2);
    assert.equal(brainCycleBacklogPendingFromDb(db), true);
    assert.equal(brainCycleDueFromDb(db, 20), false);

    const final = runBrainCycleFromDb(db, { budget: 10 });
    assert.equal(final.pendingAfter, 0);
    assert.equal(brainCycleBacklogPendingFromDb(db), false);
  } finally {
    db.close();
  }
});

test('Brain Cycle rolls back enrichment and claims together when a bookmark fails', async () => {
  const db = await activationFixture();
  try {
    ensureActivationSchema(db);
    runBrainCycleFromDb(db, { budget: 1, bookmarkIds: ['a'] });
    const before = getBookmarkActivationDetailsFromDb(db, 'a').enrichment;
    const claimCountBefore = Number(
      db.exec(`SELECT COUNT(*) FROM activation_claims WHERE bookmark_id = 'a'`)[0]?.values[0]?.[0] ?? 0,
    );
    db.run(`
      CREATE TRIGGER reject_a_claim
      BEFORE INSERT ON activation_claims
      WHEN NEW.bookmark_id = 'a'
      BEGIN
        SELECT RAISE(ABORT, 'forced claim failure');
      END
    `);

    assert.throws(
      () => runBrainCycleFromDb(db, { budget: 1, bookmarkIds: ['a'], force: true }),
      /forced claim failure/,
    );
    const after = getBookmarkActivationDetailsFromDb(db, 'a').enrichment;
    const claimCountAfter = Number(
      db.exec(`SELECT COUNT(*) FROM activation_claims WHERE bookmark_id = 'a'`)[0]?.values[0]?.[0] ?? 0,
    );
    assert.equal(after?.version, before?.version);
    assert.equal(claimCountAfter, claimCountBefore);
    assert.equal((getBrainCycleStatusFromDb(db).latest as { status: string }).status, 'error');
  } finally {
    db.close();
  }
});

test('Brain Cycle treats a computed hash as current for legacy null-hash bookmarks', async () => {
  const db = await activationFixture();
  try {
    ensureActivationSchema(db);
    db.run(
      `INSERT INTO bookmarks (
         id, text, author_handle, author_name, primary_category, url,
         posted_at, bookmarked_at, synced_at, source_hash
       ) VALUES (
         'legacy-null-hash', 'A manually imported source without a stored hash.',
         'legacy', 'Legacy', 'research', 'https://example.com/legacy',
         '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z',
         '2026-07-20T00:00:00Z', NULL
       )`,
    );
    const first = runBrainCycleFromDb(db, {
      budget: 1,
      bookmarkIds: ['legacy-null-hash'],
    });
    assert.equal(first.enriched, 1);
    assert.equal(brainCyclePendingCountFromDb(db), 3);
    const second = runBrainCycleFromDb(db, {
      budget: 1,
      bookmarkIds: ['legacy-null-hash'],
    });
    assert.equal(second.enriched, 0);
  } finally {
    db.close();
  }
});

test('Today uses the server local calendar day', () => {
  const localEvening = new Date(2026, 6, 27, 23, 30, 0);
  assert.equal(todayKey(localEvening), '2026-07-27');
});
