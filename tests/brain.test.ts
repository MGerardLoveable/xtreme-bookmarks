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
  createBrainNote,
  createBrainSpace,
  listBrainBookmarks,
  listBrainWorkflows,
  listBrainRepos,
  parseGitHubRepo,
  replaceManagedSection,
  runBrainWorkflow,
  seedBrainSpace,
  syncBrainMemory,
} from '../src/brain.js';

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
