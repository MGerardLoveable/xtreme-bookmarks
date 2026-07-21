import { ensureDir, pathExists, readJson, readJsonLines, writeJson, writeJsonLines } from './fs.js';
import { ensureDataDir, twitterBackfillStatePath, twitterBookmarksCachePath, twitterBookmarksMetaPath } from './paths.js';
import type { BookmarkBackfillState, BookmarkCacheMeta, BookmarkRecord } from './types.js';
import { loadXApiConfig } from './config.js';
import { hasOAuthScopes, loadValidTwitterOAuthToken } from './xauth.js';

export interface BookmarkSyncResult {
  mode: 'full' | 'incremental';
  totalBookmarks: number;
  added: number;
  cachePath: string;
  metaPath: string;
}

type BookmarkApiTweet = {
  id: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  entities?: {
    urls?: Array<{ expanded_url?: string; url?: string }>;
  };
};

type BookmarkApiResponse = {
  data?: BookmarkApiTweet[];
  includes?: {
    users?: Array<{ id: string; username?: string; name?: string }>;
  };
  meta?: {
    next_token?: string;
    result_count?: number;
  };
};

const API_FETCH_TIMEOUT_MS = 30_000;
const API_FETCH_ATTEMPTS = 4;

function makeBookmark(record: Partial<BookmarkRecord> & Pick<BookmarkRecord, 'id' | 'tweetId' | 'url' | 'text'>): BookmarkRecord {
  return {
    id: record.id,
    tweetId: record.tweetId,
    url: record.url,
    text: record.text,
    authorHandle: record.authorHandle,
    authorName: record.authorName,
    postedAt: record.postedAt,
    bookmarkedAt: record.bookmarkedAt,
    sortIndex: record.sortIndex,
    syncedAt: record.syncedAt ?? new Date().toISOString(),
    media: record.media ?? [],
    links: record.links ?? [],
    tags: record.tags ?? [],
    ingestedVia: record.ingestedVia,
  };
}

async function fetchJsonWithUserToken(url: string, accessToken: string, method = 'GET'): Promise<{ ok: boolean; status: number; parsed: any; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    parsed,
    text,
  };
}

function normalizeTimestamp(value?: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function compareChronology(a: BookmarkRecord, b: BookmarkRecord): number {
  if (a.sortIndex && b.sortIndex && a.sortIndex !== b.sortIndex) {
    try {
      return BigInt(a.sortIndex) > BigInt(b.sortIndex) ? -1 : 1;
    } catch { /* fall through to timestamps */ }
  }
  const aTimestamp = normalizeTimestamp(a.bookmarkedAt ?? a.postedAt ?? a.syncedAt) ?? '';
  const bTimestamp = normalizeTimestamp(b.bookmarkedAt ?? b.postedAt ?? b.syncedAt) ?? '';
  return bTimestamp.localeCompare(aTimestamp);
}

function hasValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function mergeDefinedObject<T extends object>(existing: T | undefined, incoming: T | undefined): T | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const merged = { ...existing, ...incoming } as Record<string, unknown>;
  for (const [key, value] of Object.entries(incoming)) {
    if (!hasValue(value) && hasValue((existing as Record<string, unknown>)[key])) {
      merged[key] = (existing as Record<string, unknown>)[key];
    }
  }
  return merged as T;
}

export function mergeApiRecord(existing: BookmarkRecord | undefined, incoming: BookmarkRecord): BookmarkRecord {
  if (!existing) return incoming;
  const merged = {
    ...existing,
    ...incoming,
  };
  for (const [key, value] of Object.entries(incoming)) {
    if (!hasValue(value) && hasValue((existing as unknown as Record<string, unknown>)[key])) {
      (merged as unknown as Record<string, unknown>)[key] = (existing as unknown as Record<string, unknown>)[key];
    }
  }
  return {
    ...merged,
    url: incoming.url.includes('/i/status/') && !existing.url.includes('/i/status/')
      ? existing.url
      : merged.url,
    author: mergeDefinedObject(existing.author, incoming.author),
    engagement: mergeDefinedObject(existing.engagement, incoming.engagement),
    media: incoming.media?.length ? incoming.media : existing.media,
    mediaObjects: incoming.mediaObjects?.length ? incoming.mediaObjects : existing.mediaObjects,
    links: incoming.links?.length ? incoming.links : existing.links,
    tags: existing.tags?.length ? existing.tags : incoming.tags,
    quotedTweet: mergeDefinedObject(existing.quotedTweet, incoming.quotedTweet),
    sortIndex: incoming.sortIndex ?? existing.sortIndex,
    // syncedAt is the local capture time used by Inbox, not a refresh timestamp.
    syncedAt: existing.syncedAt || incoming.syncedAt,
    ingestedVia: existing.ingestedVia ?? incoming.ingestedVia,
  };
}

function validateBookmarkApiPage(value: any): BookmarkApiResponse {
  if (!value || typeof value !== 'object') throw new Error('X bookmarks API returned invalid JSON data.');
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    throw new Error(`X bookmarks API returned errors: ${formatApiDetail(value, 'unknown API error')}`);
  }
  if (value.data !== undefined && !Array.isArray(value.data)) {
    throw new Error('X bookmarks API response changed: expected data to be an array.');
  }
  if (value.meta !== undefined && (!value.meta || typeof value.meta !== 'object')) {
    throw new Error('X bookmarks API response changed: expected meta to be an object.');
  }
  if (value.data === undefined && value.meta?.result_count !== 0) {
    throw new Error('X bookmarks API response changed: bookmark data is missing.');
  }
  return value as BookmarkApiResponse;
}

function formatApiDetail(parsed: any, fallback: string): string {
  if (parsed?.errors?.length) {
    return parsed.errors
      .map((err: any) => err.detail ?? err.title ?? JSON.stringify(err))
      .join('; ');
  }
  return parsed ? JSON.stringify(parsed) : fallback;
}

async function fetchCurrentUserId(accessToken: string): Promise<{ ok: boolean; id?: string; status: number; detail: string }> {
  const result = await fetchJsonWithUserToken('https://api.x.com/2/users/me', accessToken);
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      detail: result.parsed ? JSON.stringify(result.parsed) : result.text,
    };
  }

  const id = result.parsed?.data?.id;
  if (!id) {
    return {
      ok: false,
      status: result.status,
      detail: 'Could not find user id in /2/users/me response',
    };
  }

  return {
    ok: true,
    id: String(id),
    status: result.status,
    detail: 'Resolved current user id',
  };
}

export function normalizeBookmarkPage(page: BookmarkApiResponse, syncedAt: string): BookmarkRecord[] {
  const userMap = new Map<string, { username?: string; name?: string }>();
  for (const user of page.includes?.users ?? []) {
    userMap.set(String(user.id), { username: user.username, name: user.name });
  }

  return (page.data ?? []).map((tweet) => {
    const user = tweet.author_id ? userMap.get(String(tweet.author_id)) : undefined;
    const tweetId = String(tweet.id);
    return makeBookmark({
      id: tweetId,
      tweetId,
      url: `https://x.com/${user?.username ?? 'i'}/status/${tweetId}`,
      text: tweet.text ?? '',
      authorHandle: user?.username,
      authorName: user?.name,
      // The v2 bookmarks endpoint exposes tweet creation, not bookmark creation.
      postedAt: normalizeTimestamp(tweet.created_at),
      bookmarkedAt: null,
      syncedAt,
      links: (tweet.entities?.urls ?? []).map((u) => u.expanded_url ?? u.url ?? '').filter(Boolean),
    });
  });
}

async function fetchBookmarksPage(accessToken: string, userId: string, nextToken?: string): Promise<{ ok: boolean; status: number; detail: string; page?: BookmarkApiResponse; requestUrl: string }> {
  const url = new URL(`https://api.x.com/2/users/${userId}/bookmarks`);
  url.searchParams.set('max_results', '100');
  url.searchParams.set('tweet.fields', 'created_at,author_id,entities');
  url.searchParams.set('expansions', 'author_id');
  url.searchParams.set('user.fields', 'username,name');
  if (nextToken) url.searchParams.set('pagination_token', nextToken);

  for (let attempt = 0; attempt < API_FETCH_ATTEMPTS; attempt++) {
    let result: Awaited<ReturnType<typeof fetchJsonWithUserToken>>;
    try {
      result = await fetchJsonWithUserToken(url.toString(), accessToken);
    } catch (err) {
      if (attempt === API_FETCH_ATTEMPTS - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }

    if (result.status === 429 || result.status >= 500) {
      if (attempt === API_FETCH_ATTEMPTS - 1) break;
      const waitSec = Math.min(15 * Math.pow(2, attempt), 120);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      continue;
    }

    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        detail: result.parsed ? JSON.stringify(result.parsed) : result.text,
        requestUrl: url.toString(),
      };
    }

    return {
      ok: true,
      status: result.status,
      detail: 'ok',
      page: validateBookmarkApiPage(result.parsed),
      requestUrl: url.toString(),
    };
  }

  return {
    ok: false,
    status: 429,
    detail: 'Rate limited after 4 retries. Try again later.',
    requestUrl: url.toString(),
  };
}

export async function syncTwitterBookmarks(
  mode: 'full' | 'incremental',
  options: { targetAdds?: number } = {}
): Promise<BookmarkSyncResult> {
  const token = await loadValidTwitterOAuthToken();
  if (!token?.access_token) {
    throw new Error('Missing user-context OAuth token. Run: xb auth');
  }

  const me = await fetchCurrentUserId(token.access_token);
  if (!me.ok || !me.id) {
    throw new Error(`Could not resolve current user id: ${me.detail}`);
  }

  ensureDataDir();
  const cachePath = twitterBookmarksCachePath();
  const metaPath = twitterBookmarksMetaPath();
  const now = new Date().toISOString();
  const existing = await readJsonLines<BookmarkRecord>(cachePath);
  const existingById = new Map(existing.map((item) => [item.id, item]));

  const allFetched: BookmarkRecord[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  let reachedEnd = false;
  const maxPages = mode === 'full' ? 200 : 2;

  while (pages < maxPages) {
    const pageResult = await fetchBookmarksPage(token.access_token, me.id, nextToken);
    if (!pageResult.ok || !pageResult.page) {
      throw new Error(`Bookmark fetch failed (${pageResult.status}): ${pageResult.detail}`);
    }

    const normalized = normalizeBookmarkPage(pageResult.page, now);
    allFetched.push(...normalized);
    nextToken = pageResult.page.meta?.next_token;
    pages += 1;

    if (!nextToken) {
      reachedEnd = true;
      break;
    }
    if (mode === 'incremental' && normalized.every((item) => existingById.has(item.id))) break;
    if (typeof options.targetAdds === 'number') {
      const uniqueAddsSoFar = allFetched.filter((item, index, arr) => arr.findIndex((x) => x.id === item.id) === index).filter((item) => !existingById.has(item.id)).length;
      if (uniqueAddsSoFar >= options.targetAdds) break;
    }
  }

  const mergedById = new Map(existing.map((record) => [record.id, record]));
  const addedIds = new Set<string>();
  for (const record of allFetched) {
    if (!existingById.has(record.id)) addedIds.add(record.id);
    mergedById.set(record.id, mergeApiRecord(mergedById.get(record.id), record));
  }

  const merged = mode === 'full' && reachedEnd
    ? Array.from(new Set(allFetched.map((record) => record.id))).map((id) => mergedById.get(id)!)
    : Array.from(mergedById.values());
  merged.sort(compareChronology);
  await writeJsonLines(cachePath, merged);

  const previousMeta = (await pathExists(metaPath)) ? await readJson<BookmarkCacheMeta>(metaPath) : undefined;
  const meta: BookmarkCacheMeta = {
    provider: 'twitter',
    schemaVersion: 1,
    lastFullSyncAt: mode === 'full' ? now : previousMeta?.lastFullSyncAt,
    lastIncrementalSyncAt: mode === 'incremental' ? now : previousMeta?.lastIncrementalSyncAt,
    totalBookmarks: merged.length,
  };
  await writeJson(metaPath, meta);

  return {
    mode,
    totalBookmarks: merged.length,
    added: addedIds.size,
    cachePath,
    metaPath,
  };
}

export interface DeleteTwitterBookmarkResult {
  ok: boolean;
  status: number;
  bookmarked?: boolean;
  detail: string;
}

export async function deleteTwitterBookmark(tweetId: string): Promise<DeleteTwitterBookmarkResult> {
  if (!/^\d{1,19}$/.test(tweetId)) {
    throw new Error('X bookmark delete requires a numeric Post ID. This local item is not a normal X Post bookmark.');
  }

  const token = await loadValidTwitterOAuthToken();
  if (!token?.access_token) {
    throw new Error('Missing user-context OAuth token. Run: xb auth, then try "Remove from X too" again.');
  }

  const requiredScopes = ['tweet.read', 'users.read', 'bookmark.write'];
  if (!hasOAuthScopes(token, requiredScopes)) {
    throw new Error(
      `OAuth token is missing ${requiredScopes.filter((scope) => !hasOAuthScopes(token, [scope])).join(', ')}. ` +
      'Run: xb auth again so Xtreme can request bookmark.write.'
    );
  }

  const me = await fetchCurrentUserId(token.access_token);
  if (!me.ok || !me.id) {
    throw new Error(`Could not resolve current X user id: ${me.detail}`);
  }

  const endpoint = `https://api.x.com/2/users/${encodeURIComponent(me.id)}/bookmarks/${encodeURIComponent(tweetId)}`;
  const result = await fetchJsonWithUserToken(endpoint, token.access_token, 'DELETE');
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      detail: formatApiDetail(result.parsed, result.text),
    };
  }

  return {
    ok: true,
    status: result.status,
    bookmarked: Boolean(result.parsed?.data?.bookmarked),
    detail: 'Bookmark removed from X',
  };
}

export function latestBookmarkSyncAt(
  meta?: Pick<BookmarkCacheMeta, 'lastIncrementalSyncAt' | 'lastFullSyncAt'> | null,
): string | null {
  let latestValue: string | null = null;
  let latestTs = Number.NEGATIVE_INFINITY;

  for (const candidate of [meta?.lastIncrementalSyncAt, meta?.lastFullSyncAt]) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isFinite(parsed) || parsed <= latestTs) continue;
    latestTs = parsed;
    latestValue = candidate;
  }

  return latestValue;
}

export async function getTwitterBookmarksStatus(): Promise<BookmarkCacheMeta & { cachePath: string; metaPath: string }> {
  const cachePath = twitterBookmarksCachePath();
  const metaPath = twitterBookmarksMetaPath();
  const statePath = twitterBackfillStatePath();
  const meta = (await pathExists(metaPath))
    ? await readJson<BookmarkCacheMeta>(metaPath)
    : undefined;
  const state = (await pathExists(statePath))
    ? await readJson<BookmarkBackfillState>(statePath)
    : undefined;
  const metaUpdatedAt = latestBookmarkSyncAt(meta);
  const graphQlStatusIsNewer = Boolean(
    state?.lastRunAt && (!metaUpdatedAt || Date.parse(state.lastRunAt) > Date.parse(metaUpdatedAt))
  );

  if (!meta || graphQlStatusIsNewer) {
    const totalBookmarks = (await readJsonLines<BookmarkRecord>(cachePath)).length;
    return {
      provider: 'twitter',
      schemaVersion: meta?.schemaVersion ?? 1,
      lastFullSyncAt: meta?.lastFullSyncAt,
      lastIncrementalSyncAt: state?.lastRunAt ?? meta?.lastIncrementalSyncAt,
      totalBookmarks,
      cachePath,
      metaPath,
    };
  }

  return {
    ...meta,
    cachePath,
    metaPath,
  };
}
