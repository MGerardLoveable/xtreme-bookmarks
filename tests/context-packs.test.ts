import test from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { initBrainSchema } from '../src/brain.js';
import { buildContextPackFromDb, makeKnowledgeArtifactFromDb } from '../src/context-packs.js';

async function knowledgeFixture() {
  const db = await createDb();
  db.run(`CREATE TABLE bookmarks (
    id TEXT PRIMARY KEY,
    url TEXT,
    text TEXT,
    author_handle TEXT,
    author_name TEXT,
    bookmarked_at TEXT,
    posted_at TEXT,
    synced_at TEXT
  )`);
  db.run(`CREATE TABLE bookmark_notes (
    bookmark_id TEXT PRIMARY KEY,
    note TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE bookmark_highlights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bookmark_id TEXT NOT NULL,
    text_fragment TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.run(
    `INSERT INTO bookmarks VALUES (
      'source-1',
      'https://x.com/alice/status/1',
      'Durable agent memory needs provenance and bounded evidence retrieval.',
      'alice',
      'Alice',
      '2026-07-20T00:00:00Z',
      '2026-07-19T00:00:00Z',
      '2026-07-20T00:00:00Z'
    )`,
  );
  db.run(
    `INSERT INTO bookmark_notes VALUES (
      'source-1',
      'Use provenance to keep generated synthesis separate from my own interpretation.',
      '2026-07-21T00:00:00Z'
    )`,
  );
  initBrainSchema(db);
  return db;
}

test('context packs keep source, annotation, and synthesis provenance visible', async () => {
  const db = await knowledgeFixture();
  try {
    const pack = buildContextPackFromDb(db, {
      query: 'agent memory provenance',
      synthesis: 'A useful memory system should make every conclusion inspectable.',
    });
    assert.ok(pack.evidence.some((item) => item.kind === 'bookmark'));
    assert.ok(pack.evidence.some((item) => item.kind === 'note'));
    assert.match(pack.markdown, /## Your annotations/);
    assert.match(pack.markdown, /## Source material/);
    assert.match(pack.markdown, /## Sources/);
    assert.equal(pack.counts.personalAnnotations, 1);
  } finally {
    db.close();
  }
});

test('Make produces and saves a reusable artifact without another model call', async () => {
  const db = await knowledgeFixture();
  try {
    const result = makeKnowledgeArtifactFromDb(db, {
      type: 'decision',
      query: 'How should agent memory preserve provenance?',
      synthesis: 'Keep raw sources immutable and store notes and generated conclusions in separate layers.',
    });
    assert.equal(result.type, 'decision');
    assert.match(result.markdown, /## Tradeoffs and uncertainty/);
    assert.equal(result.savedArtifact.kind, 'synthesis');

    const rows = db.exec(`SELECT source_type, title, body FROM brain_artifacts`);
    assert.equal(rows[0]?.values.length, 1);
    assert.equal(rows[0].values[0][0], 'synthesis');
    assert.match(String(rows[0].values[0][2]), /raw sources immutable/i);
  } finally {
    db.close();
  }
});
