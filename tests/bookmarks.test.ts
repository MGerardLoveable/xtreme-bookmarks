import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeApiRecord, normalizeBookmarkPage } from '../src/bookmarks.js';

test('normalizeBookmarkPage: does not treat tweet creation time as bookmark time', () => {
  const records = normalizeBookmarkPage({
    data: [{
      id: '123',
      text: 'Hello world',
      author_id: '42',
      created_at: '2026-04-01T12:00:00.000Z',
      entities: {
        urls: [{ expanded_url: 'https://example.com', url: 'https://t.co/abc' }],
      },
    }],
    includes: {
      users: [{ id: '42', username: 'testuser', name: 'Test User' }],
    },
  }, '2026-04-08T00:00:00.000Z');

  assert.equal(records.length, 1);
  assert.equal(records[0].postedAt, '2026-04-01T12:00:00.000Z');
  assert.equal(records[0].bookmarkedAt, null);
  assert.equal(records[0].syncedAt, '2026-04-08T00:00:00.000Z');
  assert.deepEqual(records[0].links, ['https://example.com']);
});

test('mergeApiRecord preserves rich metadata and original capture time from sparse API rows', () => {
  const existing = {
    id: '123', tweetId: '123', url: 'https://x.com/rich/status/123', text: 'Rich text',
    authorHandle: 'rich', authorName: 'Rich Author', authorProfileImageUrl: 'https://img.test/avatar.jpg',
    author: { handle: 'rich', description: 'Detailed bio', followersCount: 42 },
    engagement: { likeCount: 9, viewCount: 100 },
    mediaObjects: [{ type: 'photo', mediaUrl: 'https://img.test/photo.jpg' }],
    links: ['https://example.com'], tags: ['research'],
    syncedAt: '2026-04-01T00:00:00.000Z', ingestedVia: 'graphql' as const,
  };
  const incoming = {
    id: '123', tweetId: '123', url: 'https://x.com/i/status/123', text: '',
    authorHandle: undefined, authorName: undefined,
    engagement: { likeCount: 0 }, mediaObjects: [], links: [], tags: [],
    syncedAt: '2026-04-08T00:00:00.000Z', ingestedVia: 'api' as const,
  };

  const merged = mergeApiRecord(existing, incoming);

  assert.equal(merged.text, 'Rich text');
  assert.equal(merged.url, 'https://x.com/rich/status/123');
  assert.equal(merged.author?.description, 'Detailed bio');
  assert.equal(merged.engagement?.likeCount, 0);
  assert.equal(merged.engagement?.viewCount, 100);
  assert.equal(merged.mediaObjects?.length, 1);
  assert.deepEqual(merged.links, ['https://example.com']);
  assert.deepEqual(merged.tags, ['research']);
  assert.equal(merged.syncedAt, '2026-04-01T00:00:00.000Z');
  assert.equal(merged.ingestedVia, 'graphql');
});
