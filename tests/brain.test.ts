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
  brainWorkspaceBriefFromDb,
  consolidateExactDuplicateBrainSpacesFromDb,
  createBrainNote,
  createBrainSpace,
  decideBrainFindingFromDb,
  deleteBrainSpace,
  diversifyBrainIdeas,
  findExactDuplicateBrainSpaceGroupsFromDb,
  listBrainSpacesFromDb,
  listBrainFindingsFromDb,
  listBrainBookmarks,
  listBrainWorkflows,
  listBrainRepos,
  openBrainDb,
  parseGitHubRepo,
  replaceManagedSection,
  runBrainWorkflow,
  scoreGithubDiscovery,
  seedBrainSpace,
  syncBrainMemory,
  saveWorkingUnderstandingFromDb,
  saveWorkingUnderstanding,
  workingUnderstandingFromDb,
} from '../src/brain.js';
import { ensureActivationSchema } from '../src/activation.js';
import { saveDb } from '../src/db.js';

test('working understanding preserves revisions, evidence and searchable note bodies', async () => {
  await withDataDir(async () => {
    const space = await createBrainSpace({ name: 'Research experiments', focusQuestion: 'Can this improve my work?' });
    await addBrainBookmark(space.id, '1');
    const { db } = await openBrainDb();
    try {
      const input = { conclusion: 'Research loops may help', challenge: 'No measurable improvement', nextStep: 'Run one bounded comparison', successMeasure: 'Compare completed tasks', outcome: '', evidenceIds: ['1'] };
      const first = saveWorkingUnderstandingFromDb(db, space.id, input);
      assert.deepEqual(first.evidenceIds, ['1']);
      saveWorkingUnderstandingFromDb(db, space.id, input);
      assert.equal(workingUnderstandingFromDb(db, space.id).length, 1);
      saveWorkingUnderstandingFromDb(db, space.id, { ...input, outcome: 'Completed two more tasks' });
      const history = workingUnderstandingFromDb(db, space.id);
      assert.equal(history.length, 2);
      assert.equal(history[0].outcome, 'Completed two more tasks');
      assert.ok(history.some(item => item.outcome === 'Completed two more tasks'));
      assert.ok(history.some(item => item.outcome === ''));
      assert.equal(brainWorkspaceBriefFromDb(db, space.id).understanding.length, 2);
      const bodies = db.exec("SELECT body FROM brain_artifacts WHERE source_label = 'Working understanding'")[0].values.flat().join(' ');
      assert.match(bodies, /https:\/\/x.com\/a\/status\/1/);
      assert.match(bodies, /Completed two more tasks/);
      assert.throws(() => saveWorkingUnderstandingFromDb(db, space.id, { ...input, evidenceIds: ['2'] }), /belong/);
      assert.throws(() => saveWorkingUnderstandingFromDb(db, space.id, { ...input, conclusion: 42 }), /Invalid/);
      assert.throws(() => saveWorkingUnderstandingFromDb(db, space.id, { ...input, conclusion: '', nextStep: '' }), /Add a conclusion/);
      assert.throws(() => saveWorkingUnderstandingFromDb(db, 'missing', input), /not found/);
    } finally { db.close(); }
    await saveWorkingUnderstanding(space.id, { conclusion: 'Persisted conclusion', challenge: '', nextStep: 'Try one comparison', successMeasure: 'One completed task', outcome: '', evidenceIds: ['1'] });
    const reopened = await openBrainDb();
    try {
      assert.equal(workingUnderstandingFromDb(reopened.db, space.id)[0].conclusion, 'Persisted conclusion');
    } finally { reopened.db.close(); }
  });
});

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

test('workspace ideas preserve ranking while avoiding one-author monoculture', () => {
  const ideas = [
    { author: 'alice', id: 1 },
    { author: 'alice', id: 2 },
    { author: 'alice', id: 3 },
    { author: 'bob', id: 4 },
    { author: 'carol', id: 5 },
    { author: 'dave', id: 6 },
    { author: 'erin', id: 7 },
  ];
  assert.deepEqual(diversifyBrainIdeas(ideas).map((idea) => idea.id), [1, 2, 4, 5, 6, 7]);
});

test('GitHub discovery favors distinctive workspace signals over generic AI matches', () => {
  const terms = ['gbrain', 'karpathy', 'research', 'agents'];
  assert.equal(scoreGithubDiscovery({ full_name: 'garrytan/gbrain', description: 'Agent memory' }, terms), 4);
  assert.equal(scoreGithubDiscovery({ full_name: 'random/agent-list', description: 'AI research tools' }, terms), 0);
  assert.equal(scoreGithubDiscovery({ full_name: 'labs/memory', description: 'Karpathy experiments' }, terms), 2);
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

test('repo watcher stores useful intelligence and only alerts on real changes', async () => {
  await withDataDir(async () => {
    const originalFetch = globalThis.fetch;
    let commitSha = 'baseline-sha';
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/search/repositories')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.endsWith('/releases?per_page=1')) return new Response('[]', { status: 200 });
      if (url.endsWith('/commits?per_page=1')) {
        return new Response(JSON.stringify([{
          sha: commitSha,
          html_url: `https://github.com/garrytan/gbrain/commit/${commitSha}`,
          commit: { message: commitSha === 'baseline-sha' ? 'Initial memory engine' : 'Improve retrieval evaluation', author: { name: 'Gary Tan', date: '2026-09-01T12:00:00Z' } },
        }]), { status: 200 });
      }
      if (url.endsWith('/readme')) {
        return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('# GBrain\n\nPersistent memory with retrieval benchmarks and explicit synchronization.').toString('base64') }), { status: 200 });
      }
      return new Response(JSON.stringify({
        description: 'Persistent memory for coding agents',
        html_url: 'https://github.com/garrytan/gbrain',
        stargazers_count: 4200,
        open_issues_count: 12,
        default_branch: 'main',
        topics: ['memory', 'agents'],
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const space = await createBrainSpace({
        name: 'AI Research',
        keywords: ['memory'],
        focusQuestion: 'How should durable agent memory work?',
      });
      await addBrainRepo(space.id, { repo: 'garrytan/gbrain' });

      let opened = await openBrainDb();
      try {
        opened.db.run(
          `INSERT INTO brain_agent_runs (space_id, agent_type, status, started_at) VALUES (?, 'repo_watcher', 'running', ?)`,
          [space.id, '2000-01-01T00:00:00.000Z'],
        );
        saveDb(opened.db, opened.dbPath);
      } finally {
        opened.db.close();
      }

      await runBrainWorkflow('watch', space.id);
      let repos = await listBrainRepos(space.id);
      assert.equal(repos[0].description, 'Persistent memory for coding agents');
      assert.equal(repos[0].latestCommitTitle, 'Initial memory engine');
      assert.deepEqual(repos[0].topics, ['memory', 'agents']);
      assert.match(repos[0].recommendedAction, /Start with the README/);

      opened = await openBrainDb();
      try {
        assert.equal(listBrainFindingsFromDb(opened.db, 50).filter((finding) => finding.agentType === 'repo_watcher').length, 0);
        assert.equal(opened.db.exec(`SELECT status FROM brain_agent_runs WHERE started_at = '2000-01-01T00:00:00.000Z'`)[0]?.values[0]?.[0], 'error');
      } finally {
        opened.db.close();
      }

      await runBrainWorkflow('watch', space.id);
      opened = await openBrainDb();
      try {
        assert.equal(listBrainFindingsFromDb(opened.db, 50).filter((finding) => finding.agentType === 'repo_watcher').length, 0);
      } finally {
        opened.db.close();
      }

      commitSha = 'changed-sha';
      await runBrainWorkflow('watch', space.id);
      repos = await listBrainRepos(space.id);
      assert.equal(repos[0].latestCommitTitle, 'Improve retrieval evaluation');
      assert.match(repos[0].recommendedAction, /Inspect "Improve retrieval evaluation"/);

      opened = await openBrainDb();
      try {
        const findings = listBrainFindingsFromDb(opened.db, 50).filter((finding) => finding.agentType === 'repo_watcher');
        assert.equal(findings.length, 1);
        assert.match(findings[0].detail, /Next step:/);
      } finally {
        opened.db.close();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('workspace seeding gives named authors an authority bonus and refreshes old scores', async () => {
  await withDataDir(async () => {
    const space = await createBrainSpace({ name: 'Alice research', keywords: ['Alice'] });
    const first = await seedBrainSpace(space.id);
    assert.equal(first.matched, 1);
    let bookmarks = await listBrainBookmarks(space.id);
    assert.equal(bookmarks[0].score, 6);

    const opened = await openBrainDb();
    try {
      opened.db.run(`UPDATE brain_space_bookmarks SET score = 1 WHERE space_id = ? AND bookmark_id = '1'`, [space.id]);
      saveDb(opened.db, opened.dbPath);
    } finally {
      opened.db.close();
    }
    await seedBrainSpace(space.id);
    bookmarks = await listBrainBookmarks(space.id);
    assert.equal(bookmarks[0].score, 6);
  });
});

test('workspace brief turns matching sources into ideas and next actions', async () => {
  await withDataDir(async () => {
    const space = await createBrainSpace({
      name: 'AI Research',
      focusQuestion: 'How should autonomous research loops be used?',
      keywords: ['autoresearch', 'karpathy'],
    });
    await seedBrainSpace(space.id);
    const opened = await openBrainDb();
    try {
      ensureActivationSchema(opened.db);
      opened.db.run(`
        INSERT INTO bookmark_enrichment (
          bookmark_id, source_hash, status, summary, key_claim, why_it_matters,
          suggested_action, enriched_at
        ) VALUES (?, 'hash', 'ready', ?, ?, ?, ?, ?)
      `, [
        '1',
        'Autonomous research loops can run bounded experiments.',
        'Bounded loops make research agents easier to evaluate.',
        'The workflow can produce repeatable evidence instead of one-off answers.',
        'Define one measurable experiment and a stopping condition.',
        '2026-05-03T00:00:00.000Z',
      ]);
      const brief = brainWorkspaceBriefFromDb(opened.db, space.id);
      assert.match(brief.overview, /How should autonomous research loops/);
      assert.equal(brief.keyIdeas[0].bookmarkId, '1');
      assert.match(brief.keyIdeas[0].title, /Bounded loops/);
      assert.match(brief.nextActions[0].action, /stopping condition/);
      assert.match(brief.practice?.cue || '', /@alice.*Autoresearch/i);
      assert.match(brief.practice?.answer || '', /Karpathy autoresearch autonomous AI research loops/);
      assert.notEqual(brief.practice?.cue, brief.practice?.answer);
    } finally {
      opened.db.close();
    }
  });
});

test('workspace brief derives evidence-linked actions when older sources have no suggested action', async () => {
  await withDataDir(async () => {
    const space = await createBrainSpace({
      name: 'Research Queue',
      focusQuestion: 'Which research loop should we test?',
      keywords: ['autoresearch'],
    });
    await seedBrainSpace(space.id);
    const opened = await openBrainDb();
    try {
      const brief = brainWorkspaceBriefFromDb(opened.db, space.id);
      assert.equal(brief.nextActions.length, 1);
      assert.equal(brief.nextActions[0].bookmarkId, '1');
      assert.match(brief.nextActions[0].action, /Verify the main claim/);
      assert.match(brief.nextActions[0].action, /one small test/);
    } finally {
      opened.db.close();
    }
  });
});

test('workspace brief ranks relevance before recently enriched noise', async () => {
  await withDataDir(async () => {
    const space = await createBrainSpace({ name: 'Ranked research', keywords: ['autoresearch'] });
    await seedBrainSpace(space.id);
    const opened = await openBrainDb();
    try {
      ensureActivationSchema(opened.db);
      opened.db.run(
        `INSERT INTO brain_space_bookmarks (space_id, bookmark_id, source, score, added_at)
         VALUES (?, '2', 'seed', 1, '2026-08-01T00:00:00Z')`,
        [space.id],
      );
      opened.db.run(
        `INSERT INTO bookmark_enrichment (
           bookmark_id, source_hash, status, summary, key_claim, why_it_matters, suggested_action, enriched_at
         ) VALUES ('2', 'newer', 'ready', 'Recent but weak', 'Recent but weak', '', '', '2026-09-01T00:00:00Z')`,
      );
      const brief = brainWorkspaceBriefFromDb(opened.db, space.id);
      assert.equal(brief.keyIdeas[0].bookmarkId, '1');
    } finally {
      opened.db.close();
    }
  });
});

test('finding review promotes accepted discoveries and keeps dismissed noise out of memory', async () => {
  await withDataDir(async () => {
    const space = await createBrainSpace({ name: 'Tool Watch', kind: 'project' });
    const { db } = await openBrainDb();
    try {
      db.run(
        `INSERT INTO brain_agent_runs (space_id, agent_type, status, started_at, finished_at)
         VALUES (?, 'research_scout', 'success', '2026-08-01T00:00:00Z', '2026-08-01T00:01:00Z')`,
        [space.id],
      );
      const runId = Number(db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0]);
      db.run(
        `INSERT INTO brain_agent_findings
         (run_id, space_id, agent_type, finding_type, title, url, detail, severity, created_at)
         VALUES
           (?, ?, 'research_scout', 'github_discovery', 'Original title', 'https://github.com/karpathy/autoresearch', 'Original detail', 'info', '2026-08-01T00:02:00Z'),
           (?, ?, 'research_scout', 'web_search_disabled', 'Noisy update', NULL, 'Ignore this', 'info', '2026-08-01T00:03:00Z')`,
        [runId, space.id, runId, space.id],
      );
      const ids = db.exec('SELECT id FROM brain_agent_findings ORDER BY id')[0]?.values.map((row) => Number(row[0])) ?? [];

      const accepted = decideBrainFindingFromDb(db, ids[0], {
        decision: 'accepted',
        title: 'Autonomous research loop',
        detail: 'A bounded loop for running and evaluating research experiments.',
        note: 'Compare against our current agent workflow.',
      });
      assert.equal(accepted.finding.decision, 'accepted');
      assert.equal(accepted.finding.resolved, true);
      assert.equal(accepted.watchedRepo, 'karpathy/autoresearch');
      assert.ok(accepted.artifactId);
      assert.equal(db.exec('SELECT COUNT(*) FROM brain_artifacts WHERE id = ?', [accepted.artifactId])[0]?.values[0]?.[0], 1);
      assert.equal(db.exec('SELECT source FROM brain_space_repos WHERE space_id = ? AND repo = ?', [space.id, 'karpathy/autoresearch'])[0]?.values[0]?.[0], 'accepted_finding');

      const dismissed = decideBrainFindingFromDb(db, ids[1], { decision: 'dismissed', note: 'Configuration noise.' });
      assert.equal(dismissed.finding.decision, 'dismissed');
      assert.equal(dismissed.artifactId, null);
      assert.equal(db.exec(`SELECT COUNT(*) FROM brain_artifacts WHERE source_type = 'accepted_finding'`)[0]?.values[0]?.[0], 1);
      assert.equal(db.exec(`SELECT COUNT(*) FROM brain_timeline_events WHERE event_type LIKE 'finding_%'`)[0]?.values[0]?.[0], 2);
      assert.deepEqual(listBrainFindingsFromDb(db, 50, false, 'accepted').map((item) => item.id), [ids[0]]);
      assert.deepEqual(listBrainFindingsFromDb(db, 50, false, 'dismissed').map((item) => item.id), [ids[1]]);
      assert.equal(listBrainFindingsFromDb(db, 50, true, 'open').length, 0);
    } finally {
      db.close();
    }
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
           (2, ?, 'github', 'release', 'Shared release', 'https://example.com/release', 'Duplicate', 'info', '2026-07-20T00:00:02Z'),
           (3, ?, 'github', 'release', 'Shared release', 'https://example.com/release', 'Canonical', 'info', '2026-07-20T00:00:03Z')`,
        [space.id, duplicateId, duplicateId],
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
