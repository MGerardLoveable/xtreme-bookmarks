import test from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { initBrainSchema } from '../src/brain.js';
import {
  buildActionPlanPrompt,
  buildContextPackFromDb,
  makeKnowledgeArtifactFromDb,
  makeKnowledgeArtifactWithEngineFromDb,
} from '../src/context-packs.js';

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

test('Action plan fallback produces a complete execution structure instead of sentence fragments', async () => {
  const db = await knowledgeFixture();
  try {
    const result = makeKnowledgeArtifactFromDb(db, {
      type: 'checklist',
      query: 'How should I implement durable agent memory?',
      synthesis: `
# Durable agent memory

## Executive Summary
- Preserve provenance and keep retrieval bounded.

## Recommended Actions
- [ ] **P0 - Define the memory boundary**: Decide which information is durable.

## Step-by-Step Plan
1. Inventory the current memory inputs.

## Risks, Gaps, and Contradictions
- Generated summaries can drift away from the source.
`,
    });

    assert.match(result.markdown, /## Recommended Approach/);
    assert.match(result.markdown, /## Success Criteria/);
    assert.match(result.markdown, /## Priority Actions/);
    assert.match(result.markdown, /## Implementation Steps/);
    assert.match(result.markdown, /## Decisions and Tradeoffs/);
    assert.match(result.markdown, /## First 30 Minutes/);
    assert.ok((result.markdown.match(/^- \[ \]\s+/gm) || []).length >= 5);
    assert.ok((result.markdown.match(/^\d+\.\s+/gm) || []).length >= 5);
    assert.match(result.markdown, /\[@alice\]\(https:\/\/x\.com\/alice\/status\/1\)/);
  } finally {
    db.close();
  }
});

test('Action plan prompt requires prioritized deliverables, done conditions, and author citations', async () => {
  const db = await knowledgeFixture();
  try {
    const pack = buildContextPackFromDb(db, { query: 'agent memory provenance' });
    const prompt = buildActionPlanPrompt(
      'Agent memory action plan',
      'How should I implement durable agent memory?',
      'Keep source provenance visible.',
      pack.evidence,
    );

    assert.match(prompt, /Do not merely reformat the answer/);
    assert.match(prompt, /## Success Criteria/);
    assert.match(prompt, /P0\/P1\/P2 - Verb-led action/);
    assert.match(prompt, /\*\*Done when:\*\*/);
    assert.match(prompt, /## Decisions and Tradeoffs/);
    assert.match(prompt, /## First 30 Minutes/);
    assert.match(prompt, /Never use the generic label "source"/);
    assert.match(prompt, /\[1\] @alice/);
  } finally {
    db.close();
  }
});

test('Engine-backed Action plan saves a validated structured plan', async () => {
  const db = await knowledgeFixture();
  try {
    const markdown = `
# Agent memory action plan

## Executive Overview
- Build a bounded memory pilot.

## Recommended Approach
Start with provenance-first storage.

## Success Criteria
- [ ] Every conclusion links to a source.
- [ ] Retrieval stays within the evidence budget.

## Priority Actions
- [ ] **P0 - Define scope**: Write the boundary. **Done when:** it is approved.
- [ ] **P0 - Preserve sources**: Store immutable inputs. **Done when:** links resolve.
- [ ] **P1 - Build retrieval**: Add bounded search. **Done when:** tests pass.
- [ ] **P1 - Run pilot**: Use a real task. **Done when:** results are recorded.

## Implementation Steps
1. Define the output. **Done when:** it is measurable.
2. Store sources. **Done when:** provenance is visible.
3. Add retrieval. **Done when:** limits are enforced.
4. Run the pilot. **Done when:** a decision is recorded.

## Decisions and Tradeoffs
| Decision | Recommendation | Why |
| --- | --- | --- |
| Scope | One workflow | Keep it reversible. |

## Risks and Mitigations
| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Drift | Weakens trust | Keep source links. |

## First 30 Minutes
1. Define the workflow.
2. Open the evidence.
3. Pick the pilot.

## Sources
- [@alice](https://x.com/alice/status/1)
`;
    const result = await makeKnowledgeArtifactWithEngineFromDb(db, {
      type: 'checklist',
      query: 'How should I implement durable agent memory?',
    }, {
      generate: async () => ({ markdown, engine: 'test-planner' }),
    });

    assert.equal(result.engine, 'test-planner');
    assert.equal(result.markdown.trim(), markdown.trim());
    assert.equal(result.savedArtifact.kind, 'synthesis');
  } finally {
    db.close();
  }
});
