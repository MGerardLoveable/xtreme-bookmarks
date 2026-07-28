import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAskDocument, normalizeAskMarkdown, parseAskDocument } from '../web/js/ask-results.js';
import { renderMarkdown } from '../web/js/markdown.js';

test('markdown renderer does not create nested links', () => {
  const html = renderMarkdown('Read [source](https://x.com/example/status/123) now.');
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.match(html, /href="https:\/\/x\.com\/example\/status\/123"/);
});

test('markdown renderer supports tables, task lists, and wrapped list items', () => {
  const html = renderMarkdown(`
| Role | Model |
| --- | --- |
| Planner | Grok |

- [ ] **Now — Test it**: run one query
- [x] Connected

1. **Plan**
   Define the expected output.
2. **Run**
   Compare the result.
`);

  assert.match(html, /<table>/);
  assert.match(html, /class="task-list"/);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /<li><strong>Plan<\/strong> Define the expected output\.<\/li>/);
});

test('Ask document parser recognizes the required research sections', () => {
  const document = parseAskDocument(`
# Codex orchestration

## Executive Summary
- A direct answer.

## Key Findings
Detailed analysis with [source](https://x.com/example/status/1).

## Recommended Actions
- [ ] **Now — Test**: validate the workflow.

## Step-by-Step Plan
1. Start.

## Risks, Gaps, and Contradictions
The evidence is early.

## Bottom Line
Run a bounded experiment.
`);

  assert.equal(document.title, 'Codex orchestration');
  assert.deepEqual(document.sections.map((section) => section.kind), [
    'summary',
    'findings',
    'actions',
    'steps',
    'risks',
    'conclusion',
  ]);
  assert.equal(document.sourceCount, 1);
  assert.equal(document.actionCount, 1);
});

test('Ask result renderer is structured and escapes untrusted markup', () => {
  const html = renderAskDocument(`
# <img src=x onerror=alert(1)>

## Executive Summary
<script>alert(1)</script>

## Recommended Actions
- [ ] Review the evidence.
`, { prefix: 'turn-1' });

  assert.match(html, /class="ask-report"/);
  assert.match(html, /data-kind="summary"/);
  assert.match(html, /data-kind="actions"/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
});

test('Action plan renderer labels execution sections and uses the artifact variant', () => {
  const html = renderAskDocument(`
# Codex orchestration action plan

## Executive Overview
- Start with a bounded pilot.

## Success Criteria
- [ ] The pilot has a measurable result.

## Priority Actions
- [ ] **P0 - Run pilot**: compare the workflow.

## Implementation Steps
1. Define the task.

## Decisions and Tradeoffs
| Decision | Recommendation | Why |
| --- | --- | --- |
| Scope | One task | Reversible |

## Risks and Mitigations
Keep the test bounded.

## First 30 Minutes
1. Open the top source.
`, {
    prefix: 'made-1',
    kicker: 'Action plan',
    variant: 'artifact',
  });

  assert.match(html, /class="ask-report ask-report-artifact"/);
  assert.match(html, />Action plan</);
  assert.match(html, /data-kind="success"/);
  assert.match(html, /data-kind="actions"/);
  assert.match(html, /data-kind="steps"/);
  assert.match(html, /data-kind="decisions"/);
  assert.match(html, /data-kind="quickstart"/);
  assert.match(html, /data-ask-section="made-1-executive-overview"/);
  assert.doesNotMatch(html, /href="#made-1-/);
});

test('Ask citation normalizer repairs Grok nested source links', () => {
  const malformed = '([source]([https://x.com/example/status/123))](x.com/example/status/123)))';
  assert.equal(
    normalizeAskMarkdown(malformed),
    '[@example](https://x.com/example/status/123)',
  );
});

test('Ask citations use evidence author labels for shortened links', () => {
  assert.equal(
    normalizeAskMarkdown(
      'Read [source](https://t.co/abc123).',
      { 'https://t.co/abc123': '@researcher' },
    ),
    'Read [@researcher](https://t.co/abc123).',
  );
});

test('Ask citations keep a neutral label when no author can be identified', () => {
  assert.equal(
    normalizeAskMarkdown('Read [source](https://example.com/report).'),
    'Read [source](https://example.com/report).',
  );
});
