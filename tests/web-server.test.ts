import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWhere, resolveWebGrabSyncOptions } from '../src/web-server.js';

test('backfill without a saved cursor starts a non-incremental full scan', () => {
  const options = resolveWebGrabSyncOptions(undefined, 'chrome', undefined, 'backfill');

  assert.equal(options.incremental, false);
  assert.equal(options.resumeCursor, undefined);
  assert.equal(options.stalePageLimit, Infinity);
});

test('quick grab ignores a stale saved backfill cursor', () => {
  const options = resolveWebGrabSyncOptions(
    { lastCursor: 'saved-cursor', stopReason: 'max pages reached' },
    'chrome',
    undefined,
    'quick',
  );

  assert.equal(options.incremental, true);
  assert.equal(options.resumeCursor, undefined);
});

test('Inbox filters by local capture time without changing posted-date filters', () => {
  const captured = buildWhere({ capturedAfter: '2026-07-01T00:00:00.000Z' });
  const posted = buildWhere({ after: '2026-06-01T00:00:00.000Z' });

  assert.match(captured.where, /b\.synced_at >= \?/);
  assert.doesNotMatch(captured.where, /posted_at/);
  assert.match(posted.where, /COALESCE\(b\.posted_at, b\.bookmarked_at\) >= \?/);
  assert.deepEqual(captured.params, ['2026-07-01T00:00:00.000Z']);
});
