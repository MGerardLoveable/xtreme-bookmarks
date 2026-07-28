import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../src/bookmarks-db.js';
import { openDb, saveDb } from '../src/db.js';
import { initBrainSchema, createBrainSpace, upsertBrainArtifactFromDb } from '../src/brain.js';
import {
  listKnowledgeItemsFromDb,
  listKnowledgeAnnotationsFromDb,
  listKnowledgeTopicsFromDb,
  retrieveKnowledgeEvidence,
  retrieveKnowledgeEvidenceFromDb,
  saveSynthesisFromDb,
} from '../src/knowledge-service.js';
import { formatConversationForTest, formatEvidenceForTest } from '../src/md-ask.js';
import { twitterBookmarksIndexPath } from '../src/paths.js';

const BOOKMARK = {
  id: 'bookmark-1', tweetId: 'bookmark-1', url: 'https://x.com/alice/status/1',
  text: 'Durable agent memory needs evidence and provenance.', authorHandle: 'alice', authorName: 'Alice',
  syncedAt: '2026-07-01T00:00:00Z', postedAt: '2026-07-01T00:00:00Z', links: [], tags: [], ingestedVia: 'graphql',
};

async function withKnowledgeDb(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-knowledge-test-'));
  const saved = process.env.FT_DATA_DIR;
  process.env.FT_DATA_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'bookmarks.jsonl'), `${JSON.stringify(BOOKMARK)}\n`);
    await buildIndex({ force: true });
    await fn(dir);
  } finally {
    if (saved === undefined) delete process.env.FT_DATA_DIR;
    else process.env.FT_DATA_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('canonical Topics and Items adapt legacy Brain records', async () => {
  await withKnowledgeDb(async () => {
    const topic = await createBrainSpace({ name: 'Agent Memory', keywords: ['memory'] });
    const db = await openDb(twitterBookmarksIndexPath());
    try {
      initBrainSchema(db);
      upsertBrainArtifactFromDb(db, {
        sourceType: 'note', sourceId: 'note-1', spaceId: topic.id, title: 'Memory note',
        body: 'Evidence-backed memory remains inspectable.', author: 'You', sourceLabel: 'Quick note',
      });
      const topics = listKnowledgeTopicsFromDb(db);
      const items = listKnowledgeItemsFromDb(db, { topicId: topic.id });
      assert.equal(topics[0].name, 'Agent Memory');
      assert.equal(topics[0].legacy?.pagePath, topic.pagePath);
      assert.equal(items[0].kind, 'note');
      assert.deepEqual(items[0].topicIds, [topic.id]);
      assert.equal(items[0].provenance.sourceId, 'note-1');
    } finally {
      db.close();
    }
  });
});

test('knowledge retrieval includes bookmark notes, highlights, and Brain artifacts with provenance', async () => {
  await withKnowledgeDb(async () => {
    const dbPath = twitterBookmarksIndexPath();
    const db = await openDb(dbPath);
    try {
      initBrainSchema(db);
      db.run('CREATE TABLE IF NOT EXISTS bookmark_notes (bookmark_id TEXT PRIMARY KEY, note TEXT NOT NULL, updated_at TEXT NOT NULL)');
      db.run('CREATE TABLE IF NOT EXISTS bookmark_highlights (id INTEGER PRIMARY KEY AUTOINCREMENT, bookmark_id TEXT NOT NULL, text_fragment TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL)');
      db.run('INSERT INTO bookmark_notes VALUES (?, ?, ?)', ['bookmark-1', 'Provenance makes agent memory trustworthy.', '2026-07-02T00:00:00Z']);
      db.run('INSERT INTO bookmark_highlights (bookmark_id, text_fragment, color, created_at) VALUES (?, ?, ?, ?)', ['bookmark-1', 'evidence and provenance', 'green', '2026-07-02T00:00:00Z']);
      upsertBrainArtifactFromDb(db, {
        sourceType: 'note', sourceId: 'brain-note', title: 'Agent evidence',
        body: 'Agent answers should preserve provenance.', author: 'You', sourceLabel: 'Brain note',
      });
      saveDb(db, dbPath);

      const evidence = retrieveKnowledgeEvidenceFromDb(db, 'agent provenance', { limit: 20 });
      const annotations = listKnowledgeAnnotationsFromDb(db, 'bookmark-1');
      assert.ok(evidence.some((item) => item.kind === 'bookmark'));
      assert.ok(evidence.some((item) => item.kind === 'note' && item.provenance.sourceType === 'bookmark_note'));
      assert.ok(evidence.some((item) => item.kind === 'highlight' && item.provenance.fragment === 'evidence and provenance'));
      assert.ok(evidence.some((item) => item.provenance.sourceId === 'brain-note'));
      assert.ok(evidence.every((item) => item.provenance.sourceType && item.provenance.sourceId));
      assert.deepEqual(annotations.map((item) => item.kind).sort(), ['highlight', 'note']);
    } finally {
      db.close();
    }
  });
});

test('saved concepts participate in unified evidence retrieval', async () => {
  await withKnowledgeDb(async (dir) => {
    const concepts = path.join(dir, 'md', 'concepts');
    fs.mkdirSync(concepts, { recursive: true });
    fs.writeFileSync(path.join(concepts, 'durable-memory.md'), '# Durable memory\n\nSaved concepts preserve provenance for later agent work.\n');
    const evidence = await retrieveKnowledgeEvidence('saved concepts provenance', { limit: 20 });
    assert.ok(evidence.some((item) => item.kind === 'concept' && item.title === 'Durable memory'));
  });
});

test('workspace-scoped retrieval excludes global concepts and unrelated artifacts', async () => {
  await withKnowledgeDb(async (dir) => {
    const topic = await createBrainSpace({ name: 'Scoped Memory', keywords: ['memory'] });
    const concepts = path.join(dir, 'md', 'concepts');
    fs.mkdirSync(concepts, { recursive: true });
    fs.writeFileSync(
      path.join(concepts, 'global-provenance.md'),
      '# Global provenance\n\nA global concept about provenance that is outside this workspace.\n',
    );

    const dbPath = twitterBookmarksIndexPath();
    const db = await openDb(dbPath);
    try {
      initBrainSchema(db);
      db.run(
        `INSERT INTO brain_space_bookmarks (space_id, bookmark_id, source, score, added_at)
         VALUES (?, 'bookmark-1', 'manual', 1, '2026-07-02T00:00:00Z')`,
        [topic.id],
      );
      upsertBrainArtifactFromDb(db, {
        sourceType: 'note', sourceId: 'scoped-note', spaceId: topic.id,
        title: 'Scoped provenance', body: 'Workspace provenance stays isolated.',
      });
      upsertBrainArtifactFromDb(db, {
        sourceType: 'note', sourceId: 'global-note',
        title: 'Global provenance', body: 'Unrelated global provenance should not leak.',
      });
      saveDb(db, dbPath);
    } finally {
      db.close();
    }

    const evidence = await retrieveKnowledgeEvidence('provenance', {
      topicId: topic.id,
      limit: 20,
    });
    assert.ok(evidence.some((item) => item.provenance.sourceId === 'bookmark-1'));
    assert.ok(evidence.some((item) => item.provenance.sourceId === 'scoped-note'));
    assert.ok(!evidence.some((item) => item.kind === 'concept'));
    assert.ok(!evidence.some((item) => item.provenance.sourceId === 'global-note'));
  });
});

test('saved answers become first-class synthesis Items with evidence links', async () => {
  await withKnowledgeDb(async () => {
    const db = await openDb(twitterBookmarksIndexPath());
    try {
      const source = retrieveKnowledgeEvidenceFromDb(db, 'agent memory', { limit: 5 });
      const synthesis = saveSynthesisFromDb(db, {
        question: 'How should agent memory work?',
        answer: 'It should remain source-backed and inspectable.',
        evidence: source,
        filePath: '/tmp/concept.md',
      });
      assert.equal(synthesis.kind, 'synthesis');
      assert.equal(synthesis.title, 'How should agent memory work?');
      assert.equal(synthesis.provenance.sourceType, 'synthesis');
      assert.ok(listKnowledgeItemsFromDb(db).some((item) => item.id === synthesis.id));
    } finally {
      db.close();
    }
  });
});

test('saving synthesis rejects missing or archived Topics without orphaning knowledge', async () => {
  await withKnowledgeDb(async () => {
    const archived = await createBrainSpace({ name: 'Archived research' });
    const db = await openDb(twitterBookmarksIndexPath());
    try {
      initBrainSchema(db);
      db.run(`UPDATE brain_spaces SET status = 'archived' WHERE id = ?`, [archived.id]);
      const count = (table: string) =>
        Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0] ?? 0);
      const before = {
        artifacts: count('brain_artifacts'),
        edges: count('brain_edges'),
        claims: count('brain_claims'),
      };

      for (const topicId of ['missing-workspace', archived.id]) {
        assert.throws(
          () => saveSynthesisFromDb(db, {
            question: 'Should this be saved?',
            answer: 'No orphaned workspace references should be created.',
            topicId,
          }),
          /Topic not found:/,
        );
      }

      assert.deepEqual({
        artifacts: count('brain_artifacts'),
        edges: count('brain_edges'),
        claims: count('brain_claims'),
      }, before);
    } finally {
      db.close();
    }
  });
});

test('Ask context formatting is bounded and preserves evidence provenance', () => {
  const conversation = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `turn ${index}`,
  }));
  const formattedConversation = formatConversationForTest(conversation);
  assert.doesNotMatch(formattedConversation, /turn 0/);
  assert.match(formattedConversation, /turn 9/);

  const formattedEvidence = formatEvidenceForTest([{
    id: 'e1', itemId: 'b1', kind: 'highlight', title: 'Evidence', excerpt: 'A useful excerpt', url: 'https://example.com', score: 10,
    provenance: { sourceType: 'bookmark_highlight', sourceId: 'h1', fragment: 'useful excerpt' },
  }]);
  assert.match(formattedEvidence, /bookmark_highlight\/h1/);
  assert.match(formattedEvidence, /Source fragment: useful excerpt/);
});
