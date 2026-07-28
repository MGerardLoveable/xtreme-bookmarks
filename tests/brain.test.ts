import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildIndex } from '../src/bookmarks-db.js';
import {
  addBrainBookmark,
  addBrainRepo,
  brainMemoryOverview,
  consolidateExactDuplicateBrainSpacesFromDb,
  createBrainNote,
  createBrainSpace,
  deleteBrainSpace,
  findExactDuplicateBrainSpaceGroupsFromDb,
  listBrainSpacesFromDb,
  listBrainBookmarks,
  listBrainWorkflows,
  listBrainRepos,
  openBrainDb,
  parseGitHubRepo,
  replaceManagedSection,
  runBrainWorkflow,
  seedBrainSpace,
  syncBrainMemory,
} from '../src/brain.js';
import { ensureActivationSchema } from '../src/activation.js';
import { saveDb } from '../src/db.js';

const FIXTURES = [
  {
    id: '1',
    tweetId: '1',
    url: 'https://x.com/a/status/1',
    text: 'Karpathy autoresearch autonomous AI research loops',
    authorHandle: 'alice',
    authorName: 'Alice',
    syncedAt: '2026-05-01T00:00:00Z',
    postedAt: '2026-05-01T12:00:00Z',
    language: 'en',
    links: ['https://github.com/karpathy/autoresearch'],
    tags: [],
    ingestedVia: 'graphql',
  },
  {
    id: '2',
    tweetId: '2',
    url: 'https://x.com/b/status/2',
    text: 'Gardening notes and soil amendments',
    authorHandle: 'bob',
    authorName: 'Bob',
    syncedAt: '2026-05-02T00:00:00Z',
    postedAt: '2026-05-02T12:00:00Z',
    language: 'en',
    links: [],
    tags: [],
    ingestedVia: 'graphql',
  },
];

async function withDataDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xb-brain-test-'));
  const saved = process.env.FT_DATA_DIR;
  process.env.FT_DATA_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'bookmarks.jsonl'), FIXTURES.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await buildIndex({ force: true });
    await fn(dir);
  } finally {
    if (saved !== undefined) process.env.FT_DATA_DIR = saved;
    else delete process.env.FT_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('parseGitHubRepo accepts owner/name and GitHub URLs', () => {
  assert.deepEqual(parseGitHubRepo('karpathy/autoresearch'), {
    owner: 'karpathy',
    name: 'autoresearch',
    repo: 'karpathy/autoresearch',
  });
  assert.deepEqual(parseGitHubRepo('https://github.com/Karpathy/nanoGPT'), {
    owner: 'Karpathy',
    name: 'nanoGPT',
    repo: 'karpathy/nanogpt',
  });
  assert.equal(parseGitHubRepo('not-a-repo'), null);
});

test('replaceManagedSection preserves manual notes', () => {
  const original = [
    '# AI Research',
    '',
    'Manual note that should stay.',
    '',
    '<!-- xb:managed:start brain-summary -->',
    'old generated text',
    '<!-- xb:managed:end brain-summary -->',
    '',
    'Another manual note.',
  ].join('\n');
  const updated = replaceManagedSection(original, 'new generated text');
  assert.ok(updated.includes('Manual note that should stay.'));
  assert.ok(updated.includes('Another manual note.'));
  assert.ok(updated.includes('new generated text'));
  assert.ok(!updated.includes('old generated text'));
});

test('Sub-Brain seeding matches hybrid keyword and repo signals', async () => {
  await withDataDir(async () => {
    const space = await createBrainSpace({
      name: 'AI Research',
      keywords: ['autoresearch', 'karpathy'],
    });
    await addBrainRepo(space.id, { repo: 'karpathy/autoresearch' });
    const seed = await seedBrainSpace(space.id);
    assert.equal(seed.matched, 1);
    assert.equal(seed.added, 1);

    const bookmarks = await listBrainBookmarks(space.id);
    assert.equal(bookmarks.length, 1);
    assert.equal(bookmarks[0].id, '1');

    const repos = await listBrainRepos(space.id);
    assert.equal(repos.length, 1);
    assert.equal(repos[0].repo, 'karpathy/autoresearch');
  });
});

test('manual Sub-Brain bookmark membership is preserved', async () => {
  await withDataDir(async () => {
    const space = await createBrainSpace({ name: 'Manual Space' });
    await addBrainBookmark(space.id, '2');
    const bookmarks = await listBrainBookmarks(space.id);
    assert.equal(bookmarks.length, 1);
    assert.equal(bookmarks[0].id, '2');
    assert.equal(bookmarks[0].source, 'manual');
  });
});

test('workspace creation is idempotent and exact duplicates consolidate safely', async () => {
  await withDataDir(async () => {
    const space = await createBrainSpace({ name: 'Useful Tools', kind: 'project' });
    const repeated = await createBrainSpace({ name: ' useful tools ', kind: 'project' });
    assert.equal(repeated.id, space.id);

    fs.mkdirSync(path.dirname(space.pagePath), { recursive: true });
    fs.writeFileSync(
      space.pagePath,
      '# Useful Tools\n\nManual notes can go here.\n\n<!-- xb:managed:start brain-summary -->\nGenerated A\n<!-- xb:managed:end brain-summary -->\n',
    );

    const { db } = await openBrainDb();
    try {
      const duplicateId = `${space.id}-2`;
      const duplicatePagePath = path.join(path.dirname(space.pagePath), `${duplicateId}.md`);
      fs.writeFileSync(
        duplicatePagePath,
        '# Useful Tools\n\nManual notes can go here.\n\n<!-- xb:managed:start brain-summary -->\nGenerated B\n<!-- xb:managed:end brain-summary -->\n',
      );
      db.run(
        `INSERT INTO brain_spaces (
          id, name, description, keywords_json, category, domain, collection,
          created_at, updated_at, page_path, kind, status, focus_question
        ) VALUES (?, 'Useful Tools', '', '[]', NULL, NULL, NULL, ?, ?, ?,
          'project', 'active', '')`,
        [
          duplicateId,
          '2026-07-20T00:00:01Z',
          '2026-07-20T00:00:01Z',
          duplicatePagePath,
        ],
      );
      db.run(
        `INSERT INTO brain_space_bookmarks
         (space_id, bookmark_id, source, score, added_at)
         VALUES (?, '1', 'seed', 0.5, '2026-07-20T00:00:01Z')`,
        [duplicateId],
      );
      db.run(
        `INSERT INTO brain_agent_findings
         (run_id, space_id, agent_type, finding_type, title, url, detail, severity, created_at)
         VALUES
           (1, ?, 'github', 'release', 'Shared release', 'https://example.com/release', 'Canonical', 'info', '2026-07-20T00:00:01Z'),
           (2, ?, 'github', 'release', 'Shared release', 'https://example.com/release', 'Duplicate', 'info', '2026-07-20T00:00:02Z')`,
        [space.id, duplicateId],
      );
      db.run(
        `INSERT INTO brain_artifacts (
           id, source_type, source_id, space_id, title, body, captured_at, updated_at
         ) VALUES
           ('canonical-artifact', 'bookmark', '1', ?, 'Canonical source', 'Canonical body',
            '2026-07-20T00:00:01Z', '2026-07-20T00:00:01Z'),
           ('duplicate-artifact', 'bookmark', '1', ?, 'Duplicate source', 'Duplicate body',
            '2026-07-20T00:00:02Z', '2026-07-20T00:00:02Z')`,
        [space.id, duplicateId],
      );
      db.run(
        `INSERT INTO brain_claims (id, artifact_id, claim, created_at)
         VALUES ('duplicate-claim', 'duplicate-artifact', 'Preserve this claim', '2026-07-20T00:00:02Z')`,
      );

      const groups = await findExactDuplicateBrainSpaceGroupsFromDb(db);
      assert.deepEqual(groups, [{ canonicalId: space.id, duplicateIds: [duplicateId] }]);
      assert.equal(consolidateExactDuplicateBrainSpacesFromDb(db, groups), 1);
      assert.equal(listBrainSpacesFromDb(db).length, 1);
      const membership = db.exec(
        'SELECT source FROM brain_space_bookmarks WHERE space_id = ? AND bookmark_id = ?',
        [space.id, '1'],
      );
      assert.equal(membership[0]?.values.length, 1);
      const findings = db.exec(
        'SELECT title FROM brain_agent_findings WHERE space_id = ?',
        [space.id],
      );
      assert.equal(findings[0]?.values.length, 2);
      const artifacts = db.exec(
        `SELECT id, space_id FROM brain_artifacts
         WHERE id IN ('canonical-artifact', 'duplicate-artifact')
         ORDER BY id`,
      );
      assert.deepEqual(artifacts[0]?.values, [
        ['canonical-artifact', space.id],
        ['duplicate-artifact', null],
      ]);
      const preservedClaim = db.exec(
        `SELECT artifact_id FROM brain_claims WHERE id = 'duplicate-claim'`,
      );
      assert.equal(preservedClaim[0]?.values[0]?.[0], 'duplicate-artifact');
    } finally {
      db.close();
    }
  });
});

test('deleting a workspace clears roles and preserves its artifacts as unscoped knowledge', async () => {
  await withDataDir(async () => {
    const space = await createBrainSpace({ name: 'Temporary Project', kind: 'project' });
    const { db, dbPath } = await openBrainDb();
    try {
      ensureActivationSchema(db);
      db.run(
        `INSERT INTO project_item_roles (space_id, bookmark_id, role, created_at, updated_at)
         VALUES (?, '1', 'evidence', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z')`,
        [space.id],
      );
      db.run(
        `INSERT INTO brain_artifacts (
           id, source_type, source_id, space_id, title, body, captured_at, updated_at
         ) VALUES (
           'temporary-artifact', 'note', 'temporary-note', ?, 'Keep me', 'Durable knowledge',
           '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z'
         )`,
        [space.id],
      );
      saveDb(db, dbPath);
    } finally {
      db.close();
    }

    await deleteBrainSpace(space.id);
    const reopened = await openBrainDb();
    try {
      const roles = reopened.db.exec(
        `SELECT COUNT(*) FROM project_item_roles WHERE space_id = ?`,
        [space.id],
      );
      assert.equal(roles[0]?.values[0]?.[0], 0);
      const artifact = reopened.db.exec(
        `SELECT space_id FROM brain_artifacts WHERE id = 'temporary-artifact'`,
      );
      assert.equal(artifact[0]?.values[0]?.[0], null);
    } finally {
      reopened.db.close();
    }
  });
});

test('Brain memory sync creates artifacts, claims, entities, and workflows', async () => {
  await withDataDir(async () => {
    const space = await createBrainSpace({
      name: 'AI Research',
      keywords: ['autoresearch', 'karpathy'],
    });
    await seedBrainSpace(space.id);

    const synced = await syncBrainMemory();
    assert.equal(synced.artifacts, 1);
    assert.equal(synced.created, 1);
    assert.ok(synced.edges >= 1);

    const memory = await brainMemoryOverview();
    assert.equal(memory.artifactCount, 1);
    assert.ok(memory.entityCount >= 1);
    assert.ok(memory.recentArtifacts[0].title.includes('Karpathy') || memory.recentArtifacts[0].body.includes('Karpathy'));

    const workflows = await listBrainWorkflows();
    assert.ok(workflows.some((workflow) => workflow.id === 'capture'));
    assert.ok(workflows.some((workflow) => workflow.id === 'connect'));
  });
});

test('Quick Brain notes become memory cards and can match a topic', async () => {
  await withDataDir(async () => {
    const space = await createBrainSpace({
      name: 'AI Research',
      keywords: ['gbrain', 'agents'],
    });
    const note = await createBrainNote({
      title: 'GBrain integration',
      text: 'GBrain should help agents remember source-backed claims and connect bookmarks to useful workflows.',
      tags: ['gbrain'],
    });

    assert.equal(note.spaceId, space.id);
    assert.equal(note.sourceType, 'note');

    const memory = await brainMemoryOverview();
    assert.ok(memory.artifactCount >= 1);
    assert.ok(memory.recentArtifacts.some((artifact) => artifact.sourceType === 'note'));
  });
});

test('Brain capture workflow indexes existing topic sources', async () => {
  await withDataDir(async () => {
    const space = await createBrainSpace({
      name: 'AI Research',
      keywords: ['autoresearch'],
    });
    await seedBrainSpace(space.id);
    const result = await runBrainWorkflow('capture', space.id);
    assert.equal(result.workflow, 'capture');
    assert.match(result.summary, /memory card/i);

    const memory = await brainMemoryOverview();
    assert.equal(memory.artifactCount, 1);
  });
});
