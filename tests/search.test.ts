import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchPlan, levenshteinDistance, normalizeSearchText } from '../src/search.js';

test('buildSearchPlan emits safe FTS queries from natural punctuation', () => {
  const plan = buildSearchPlan(`Claude's "production-ready" memory?`);
  assert.deepEqual(plan.tokens, ['claude', 'production', 'ready', 'memory']);
  assert.ok(plan.strictQuery.includes('"claude"*'));
  assert.ok(!plan.strictQuery.includes('?'));
});

test('buildSearchPlan extracts author, category, and domain directives', () => {
  const plan = buildSearchPlan('@alice category:research domain:github.com agent memory');
  assert.equal(plan.author, 'alice');
  assert.equal(plan.category, 'research');
  assert.equal(plan.domain, 'github.com');
  assert.deepEqual(plan.tokens, ['agent', 'memory']);
});

test('normalizeSearchText handles smart apostrophes and whitespace', () => {
  assert.equal(normalizeSearchText('  Claude\u2019s\n memory '), "Claude's memory");
});

test('levenshteinDistance measures typo distance', () => {
  assert.equal(levenshteinDistance('bookmakr', 'bookmark'), 2);
  assert.equal(levenshteinDistance('search', 'search'), 0);
});
