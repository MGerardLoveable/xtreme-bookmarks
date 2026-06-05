import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Database } from 'sql.js';
import { openDb, saveDb } from './db.js';
import { twitterBookmarksIndexPath, mdDir } from './paths.js';
import { deleteTwitterBookmark, syncTwitterBookmarks } from './bookmarks.js';
import { syncBookmarksGraphQL } from './graphql-bookmarks.js';
import { buildIndex, updateBookmarkWikiStatus, ensureMigrations } from './bookmarks-db.js';
import { twitterBookmarksCachePath } from './paths.js';
import { readJsonLines, writeJsonLines } from './fs.js';
import { browserUserDataDir, getBrowser, listBrowserIds } from './browsers.js';
import { addBookmarkToWiki, compileMd } from './md.js';
import { consolidateMemoryTiers, getMemoryTierStats } from './memory-tier.js';
import { getGraphStats, exportGraphAsMermaid, loadGraph } from './graph.js';
import { runMaintenanceAgent, exportHealthReportAsJson } from './agents.js';
import { askMd } from './md-ask.js';
import { detectAvailableEngines, getGrokOauthStatus } from './engine.js';
import { loadPreferences } from './preferences.js';
import { loadEnv } from './config.js';
import { buildTwitterOAuthUrl, exchangeCodeForToken, saveTwitterOAuthToken } from './xauth.js';
import {
  addXWatchAccount,
  backfillAllXWatchAccounts,
  backfillXWatchAccount,
  getXStreamStatus,
  initXStreamSchema,
  listXStreamItems,
  listXWatchAccounts,
  pollAllXWatchAccountsViaBrowser,
  pollXWatchAccountViaBrowser,
  removeXWatchAccount,
  removeXStreamItemAndSave,
  removeXStreamItemsAndSave,
  manualXBrowserPollOptions,
  runXBrowserPollInBackground,
  runXBrowserPollOnce,
  saveXStreamItemToBookmarks,
  startXBrowserPoller,
  startXFilteredStream,
  stopXBrowserPoller,
  stopXFilteredStream,
  syncXStreamRule,
  updateXWatchAccount,
  XApiError,
} from './x-stream.js';
import {
  addBrainBookmark,
  addBrainRepo,
  brainMemoryOverview,
  brainDashboard,
  createBrainNote,
  createBrainSpace,
  deleteBrainSpace,
  initBrainSchema,
  listBrainBookmarks,
  listBrainFindings,
  listBrainRepos,
  listBrainRuns,
  listBrainSpaces,
  listBrainWorkflowRuns,
  listBrainWorkflows,
  removeBrainBookmark,
  runBrainAgents,
  runBrainWorkflow,
  runDueBrainAgents,
  seedBrainSpace,
  syncBrainMemory,
  updateBrainSpace,
  type BrainWorkflowId,
} from './brain.js';
import {
  loadIdeas,
  createIdea,
  deleteIdea,
  promoteIdeaToMarkdown,
} from './ideas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let activeAuthFlow: {
  startedAt: number;
  state: string;
  verifier: string;
  url: string;
} | null = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveWebDir(): string {
  const paths = [
    path.join(__dirname, '..', 'web'),
    path.join(process.cwd(), 'web'),
    path.join(__dirname, 'web')
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return paths[0];
}

function getMimeType(ext: string): string {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  return types[ext] || 'application/octet-stream';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, message: string, status = 500): void {
  sendJson(res, { error: message }, status);
}

function sendXApiError(res: http.ServerResponse, err: unknown): boolean {
  if (!(err instanceof XApiError)) return false;
  const unauthorized = err.status === 401 || err.status === 403;
  sendJson(res, {
    error: err.message,
    userMessage: unauthorized
      ? 'X rejected the saved Bearer Token. Regenerate the Bearer Token in the X Developer Portal, then save it on the X API setup page.'
      : err.message,
    setupUrl: '/setup-x.html',
  }, err.status);
  return true;
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function getXConsumerSecret(): string | undefined {
  return process.env.X_WEBHOOK_CONSUMER_SECRET
    || process.env.X_API_SECRET
    || process.env.X_CONSUMER_SECRET
    || process.env.X_SECRET_KEY;
}

function createXChallengeResponse(crcToken: string): string {
  const consumerSecret = getXConsumerSecret();
  if (!consumerSecret) {
    throw new Error('X_API_SECRET is not set.');
  }
  const digest = crypto
    .createHmac('sha1', consumerSecret)
    .update(crcToken)
    .digest('base64');
  return `sha1=${digest}`;
}

function detectXEventType(payload: Record<string, unknown>): string {
  if (typeof payload.event_type === 'string' && payload.event_type.trim()) return payload.event_type.trim();
  if (Array.isArray(payload.direct_message_events)) return 'direct_message_events';
  if (Array.isArray(payload.tweet_create_events)) return 'tweet_create_events';
  if (Array.isArray(payload.favorite_events)) return 'favorite_events';
  if (Array.isArray(payload.follow_events)) return 'follow_events';
  if (Array.isArray(payload.block_events)) return 'block_events';
  if (Array.isArray(payload.mute_events)) return 'mute_events';
  const keys = Object.keys(payload).filter((key) => key !== 'for_user_id' && key !== 'users');
  return keys.length ? keys.slice(0, 3).join(',') : 'unknown';
}

function parseCsv(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((e) => e.trim()).filter(Boolean);
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

function parseJson(value: unknown): unknown[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isImageUrl(value: unknown): value is string {
  return typeof value === 'string' && (
    /pbs\.twimg\.com\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb|card_img)\//i.test(value) ||
    /\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i.test(value)
  );
}

function pushMediaUrl(target: string[], seen: Set<string>, value: unknown): void {
  if (!isImageUrl(value)) return;
  const url = value.trim();
  if (!url || seen.has(url)) return;
  seen.add(url);
  target.push(url);
}

function pushMediaEntry(target: string[], seen: Set<string>, entry: unknown): void {
  if (!entry || typeof entry !== 'object') {
    pushMediaUrl(target, seen, entry);
    return;
  }
  const mediaObject = entry as Record<string, unknown>;
  pushMediaUrl(target, seen, mediaObject.url);
  pushMediaUrl(target, seen, mediaObject.mediaUrl);
  pushMediaUrl(target, seen, mediaObject.previewUrl);
  pushMediaUrl(target, seen, mediaObject.expandedUrl);

  const variants = [
    ...(Array.isArray(mediaObject.videoVariants) ? mediaObject.videoVariants : []),
    ...(Array.isArray(mediaObject.variants) ? mediaObject.variants : []),
  ];
  for (const variant of variants) {
    if (!variant || typeof variant !== 'object') continue;
    const variantUrl = (variant as Record<string, unknown>).url;
    pushMediaUrl(target, seen, variantUrl);
  }
}

function collectMedia(mediaJson: unknown, linksJson: unknown, quotedTweetJson: unknown): string[] {
  const media: string[] = [];
  const seen = new Set<string>();

  for (const entry of parseJson(mediaJson)) pushMediaEntry(media, seen, entry);
  for (const entry of parseJsonArray(linksJson)) pushMediaUrl(media, seen, entry);

  if (typeof quotedTweetJson === 'string' && quotedTweetJson.trim()) {
    try {
      const quoted = JSON.parse(quotedTweetJson) as Record<string, unknown>;
      for (const entry of Array.isArray(quoted.media) ? quoted.media : []) pushMediaEntry(media, seen, entry);
      for (const entry of Array.isArray(quoted.mediaObjects) ? quoted.mediaObjects : []) pushMediaEntry(media, seen, entry);
    } catch {
      // Older rows may have malformed quoted payloads; keep the direct media instead.
    }
  }

  return media;
}

function normalizeCategory(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const category = value.trim().toLowerCase();
  if (!category) return null;
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(category) ? category : null;
}

function mapRow(row: unknown[]): Record<string, unknown> {
  const media = collectMedia(row[15], row[13], row[24]);
  return {
    id: row[0],
    tweetId: row[1],
    url: row[2],
    text: row[3],
    authorHandle: row[4] ?? null,
    authorName: row[5] ?? null,
    authorProfileImageUrl: row[6] ?? null,
    postedAt: row[7] ?? null,
    bookmarkedAt: row[8] ?? null,
    categories: parseCsv(row[9]),
    primaryCategory: row[10] ?? null,
    domains: parseCsv(row[11]),
    primaryDomain: row[12] ?? null,
    links: parseJsonArray(row[13]),
    mediaCount: Math.max(Number(row[14] ?? 0), media.length),
    media,
    linkCount: Number(row[16] ?? 0),
    likeCount: row[17] ?? null,
    repostCount: row[18] ?? null,
    replyCount: row[19] ?? null,
    quoteCount: row[20] ?? null,
    bookmarkCount: row[21] ?? null,
    viewCount: row[22] ?? null,
    inWiki: Boolean(row[23] ?? 0),
  };
}

function parseBookmarkDate(...values: unknown[]): Date | null {
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function formatUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatUtcWeek(date: Date): string {
  const normalized = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = normalized.getUTCDay() || 7;
  normalized.setUTCDate(normalized.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(normalized.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((normalized.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${normalized.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

function incrementCount(map: Map<string | number, number>, key: string | number): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function toSortedCountEntries<T extends string | number>(map: Map<T, number>, keyName: string): Array<Record<string, string | number>> {
  return [...map.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([key, count]) => ({ [keyName]: key, count }));
}

function isCookieReadFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Cookies database|cookie extraction|No ct0 CSRF cookie|resource busy|locked|EBUSY/i.test(message);
}

function installedBrowserIds(): string[] {
  const preferred = ['chrome', 'edge', 'brave', 'comet', 'chromium', 'firefox'];
  const ids = preferred.filter(id => listBrowserIds().includes(id));
  return ids.filter(id => {
    try {
      const dir = browserUserDataDir(getBrowser(id));
      return Boolean(dir && fs.existsSync(dir));
    } catch {
      return false;
    }
  });
}

function startAuthFlow(): string {
  if (activeAuthFlow && Date.now() - activeAuthFlow.startedAt < 10 * 60 * 1000) {
    return activeAuthFlow.url;
  }

  const flow = buildTwitterOAuthUrl();
  activeAuthFlow = {
    startedAt: Date.now(),
    state: flow.state,
    verifier: flow.verifier,
    url: flow.url,
  };
  return flow.url;
}

async function handleOAuthCallback(reqUrl: URL, res: http.ServerResponse): Promise<void> {
  const code = reqUrl.searchParams.get('code');
  const state = reqUrl.searchParams.get('state');
  const error = reqUrl.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<h1>X authorization failed</h1><p>${escapeHtml(error)}</p>`);
    return;
  }

  if (!activeAuthFlow || !code || state !== activeAuthFlow.state) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<h1>X authorization failed</h1><p>The callback did not match the active authorization request. Go back to Xtreme Bookmarks and try Grab again.</p>');
    return;
  }

  const verifier = activeAuthFlow.verifier;
  activeAuthFlow = null;
  try {
    const token = await exchangeCodeForToken(code, verifier);
    await saveTwitterOAuthToken(token);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<h1>Xtreme Bookmarks is authorized</h1><p>You can close this tab and press Grab new bookmarks again.</p>');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<h1>X authorization failed</h1><p>${escapeHtml(message)}</p>`);
  }
}

async function rebuildIndexAndReload(dbPath: string, state?: { db: Database }): Promise<void> {
  await buildIndex();
  if (state) {
    state.db.close();
    state.db = await openDb(dbPath);
  }
}

async function reloadStateDb(dbPath: string, state?: { db: Database }): Promise<void> {
  if (!state) return;
  state.db.close();
  state.db = await openDb(dbPath);
  ensureMigrations(state.db);
  initBrainSchema(state.db);
  initXStreamSchema(state.db);
}

function xBrowserPollOptions(
  dbPath: string,
  state?: { db: Database },
  waitForCurrent = false,
  pollOptions: { accountDelayMs?: number; rateLimitRetryMs?: number } = {},
) {
  return {
    dbPath,
    waitForCurrent,
    ...pollOptions,
    getDb: () => openDb(dbPath),
    releaseDb: (db: Database) => { db.close(); },
    afterPoll: () => reloadStateDb(dbPath, state),
  };
}

// ── Query builder ───────────────────────────────────────────────────────────

interface Filters {
  q?: string;
  author?: string;
  category?: string;
  domain?: string;
  collection?: string;
  after?: string;
  before?: string;
  sort?: string;
  limit?: number;
  offset?: number;
  readStatus?: string;
}

interface WebAuthConfig {
  enabled: boolean;
  username: string;
  password: string;
}

function getWebAuthConfig(): WebAuthConfig {
  const password = process.env.XTREME_BOOKMARKS_WEB_PASSWORD || process.env.XB_WEB_PASSWORD || '';
  const username = process.env.XTREME_BOOKMARKS_WEB_USER || process.env.XB_WEB_USER || 'xtreme';
  return { enabled: password.length > 0, username, password };
}

function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isRequestAuthorized(req: http.IncomingMessage, auth: WebAuthConfig): boolean {
  if (!auth.enabled) return true;
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) return false;

  let decoded = '';
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    return false;
  }

  const splitAt = decoded.indexOf(':');
  if (splitAt < 0) return false;
  const username = decoded.slice(0, splitAt);
  const password = decoded.slice(splitAt + 1);
  return safeCompare(username, auth.username) && safeCompare(password, auth.password);
}

function requestWebAuth(res: http.ServerResponse): void {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Basic realm="Xtreme Bookmarks", charset="UTF-8"',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ error: 'Authentication required' }));
}

function buildWhere(filters: Filters): { where: string; params: (string | number)[] } {
  const conds: string[] = [];
  const params: (string | number)[] = [];

  if (filters.q) {
    conds.push(`b.rowid IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ?)`);
    params.push(filters.q);
  }
  if (filters.author) {
    conds.push(`b.author_handle = ? COLLATE NOCASE`);
    params.push(filters.author);
  }
  if (filters.category) {
    conds.push(`b.categories LIKE ?`);
    params.push(`%${filters.category}%`);
  }
  if (filters.domain) {
    conds.push(`b.domains LIKE ?`);
    params.push(`%${filters.domain}%`);
  }
  if (filters.collection) {
    conds.push(`b.id IN (SELECT bookmark_id FROM bookmark_collections WHERE collection_name = ?)`);
    params.push(filters.collection);
  }
  if (filters.after) {
    conds.push(`COALESCE(b.posted_at, b.bookmarked_at) >= ?`);
    params.push(filters.after);
  }
  if (filters.before) {
    conds.push(`COALESCE(b.posted_at, b.bookmarked_at) <= ?`);
    params.push(filters.before);
  }
  if (filters.readStatus === 'unread') {
    conds.push(`b.id NOT IN (SELECT bookmark_id FROM bookmark_read_status WHERE is_read = 1)`);
  }
  if (filters.readStatus === 'read') {
    conds.push(`b.id IN (SELECT bookmark_id FROM bookmark_read_status WHERE is_read = 1)`);
  }

  return {
    where: conds.length ? `WHERE ${conds.join(' AND ')}` : '',
    params,
  };
}

const BOOKMARK_COLS = `
  b.id, b.tweet_id, b.url, b.text,
  b.author_handle, b.author_name, b.author_profile_image_url,
  b.posted_at, b.bookmarked_at,
  b.categories, b.primary_category,
  b.domains, b.primary_domain,
  b.links_json, b.media_count, b.media_json, b.link_count,
  b.like_count, b.repost_count, b.reply_count,
  b.quote_count, b.bookmark_count, b.view_count, b.in_wiki,
  b.quoted_tweet_json
`;

function sortClause(dir: string = 'desc'): string {
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY CASE
    WHEN b.bookmarked_at GLOB '____-__-__*' THEN b.bookmarked_at
    WHEN b.posted_at GLOB '____-__-__*' THEN b.posted_at
    ELSE '' END ${d}, CAST(b.tweet_id AS INTEGER) ${d}`;
}

// ── API handlers ────────────────────────────────────────────────────────────

function handleBookmarks(db: Database, params: URLSearchParams): unknown {
  const unread = params.get('unread');
  const filters: Filters = {
    q: params.get('q') || undefined,
    author: params.get('author') || undefined,
    category: params.get('category') || undefined,
    domain: params.get('domain') || undefined,
    collection: params.get('collection') || undefined,
    after: params.get('after') || undefined,
    before: params.get('before') || undefined,
    sort: params.get('sort') || 'desc',
    limit: Math.min(Number(params.get('limit')) || 30, 100),
    offset: Number(params.get('offset')) || 0,
    readStatus: params.get('readStatus') || (unread === 'true' ? 'unread' : unread === 'false' ? 'read' : undefined),
  };

  const { where, params: qp } = buildWhere(filters);

  const countRows = db.exec(`SELECT COUNT(*) FROM bookmarks b ${where}`, qp);
  const total = Number(countRows[0]?.values?.[0]?.[0] ?? 0);

  const sql = `SELECT ${BOOKMARK_COLS} FROM bookmarks b ${where} ${sortClause(filters.sort)} LIMIT ? OFFSET ?`;
  const allParams = [...qp, filters.limit!, filters.offset!];
  const rows = db.exec(sql, allParams);
  const bookmarks = (rows[0]?.values ?? []).map(mapRow);

  // Attach collections to each bookmark
  if (bookmarks.length) {
    const ids = bookmarks.map((b: any) => b.id);
    const placeholders = ids.map(() => '?').join(',');
    const colRows = db.exec(
      `SELECT bookmark_id, collection_name FROM bookmark_collections WHERE bookmark_id IN (${placeholders})`,
      ids,
    );
    const colMap: Record<string, string[]> = {};
    for (const r of (colRows[0]?.values ?? [])) {
      const bid = r[0] as string;
      if (!colMap[bid]) colMap[bid] = [];
      colMap[bid].push(r[1] as string);
    }
    for (const b of bookmarks as any[]) {
      b.collections = colMap[b.id] || [];
    }

    const readRows = db.exec(
      `SELECT bookmark_id, is_read FROM bookmark_read_status WHERE bookmark_id IN (${placeholders})`,
      ids,
    );
    const readMap = new Map<string, boolean>();
    for (const r of (readRows[0]?.values ?? [])) {
      readMap.set(r[0] as string, Number(r[1] ?? 0) === 1);
    }
    for (const b of bookmarks as any[]) {
      b.isRead = readMap.get(b.id) ?? false;
    }
  }

  return { bookmarks, total, limit: filters.limit, offset: filters.offset };
}

function handleBookmarkById(db: Database, id: string): unknown {
  const rows = db.exec(`SELECT ${BOOKMARK_COLS} FROM bookmarks b WHERE b.id = ? LIMIT 1`, [id]);
  const row = rows[0]?.values?.[0];
  if (!row) return null;

  const bookmark = mapRow(row);

  // Get note if exists
  const noteRows = db.exec(`SELECT note, updated_at FROM bookmark_notes WHERE bookmark_id = ?`, [id]);
  const noteRow = noteRows[0]?.values?.[0];
  if (noteRow) {
    (bookmark as Record<string, unknown>).note = noteRow[0];
    (bookmark as Record<string, unknown>).noteUpdatedAt = noteRow[1];
  }

  const colRows = db.exec(
    `SELECT collection_name FROM bookmark_collections WHERE bookmark_id = ? ORDER BY collection_name COLLATE NOCASE`,
    [id],
  );
  (bookmark as Record<string, unknown>).collections = (colRows[0]?.values ?? []).map((r) => r[0]);

  const readRows = db.exec(`SELECT is_read FROM bookmark_read_status WHERE bookmark_id = ?`, [id]);
  (bookmark as Record<string, unknown>).isRead = Number(readRows[0]?.values?.[0]?.[0] ?? 0) === 1;

  return bookmark;
}

function handleStats(db: Database): unknown {
  const total = Number(db.exec('SELECT COUNT(*) FROM bookmarks')[0]?.values[0]?.[0] ?? 0);
  const authors = Number(db.exec('SELECT COUNT(DISTINCT author_handle) FROM bookmarks')[0]?.values[0]?.[0] ?? 0);
  const catRows = db.exec(`SELECT COUNT(DISTINCT primary_category) FROM bookmarks WHERE primary_category IS NOT NULL AND primary_category != 'unclassified'`);
  const categoriesCount = Number(catRows[0]?.values[0]?.[0] ?? 0);
  const domRows = db.exec(`SELECT COUNT(DISTINCT primary_domain) FROM bookmarks WHERE primary_domain IS NOT NULL`);
  const domainsCount = Number(domRows[0]?.values[0]?.[0] ?? 0);

  const rangeRows = db.exec('SELECT MIN(posted_at), MAX(posted_at) FROM bookmarks WHERE posted_at IS NOT NULL');
  const range = rangeRows[0]?.values[0];

  const topAuthorsRows = db.exec(
    `SELECT author_handle, COUNT(*) as c FROM bookmarks WHERE author_handle IS NOT NULL GROUP BY author_handle ORDER BY c DESC LIMIT 15`
  );
  const topAuthors = (topAuthorsRows[0]?.values ?? []).map((r) => ({ handle: r[0], count: r[1] }));

  const topCatRows = db.exec(
    `SELECT primary_category, COUNT(*) as c FROM bookmarks WHERE primary_category IS NOT NULL AND primary_category != 'unclassified' GROUP BY primary_category ORDER BY c DESC LIMIT 15`
  );
  const topCategories = (topCatRows[0]?.values ?? []).map((r) => ({ name: r[0], count: r[1] }));

  const topDomRows = db.exec(
    `SELECT primary_domain, COUNT(*) as c FROM bookmarks WHERE primary_domain IS NOT NULL GROUP BY primary_domain ORDER BY c DESC LIMIT 15`
  );
  const topDomains = (topDomRows[0]?.values ?? []).map((r) => ({ name: r[0], count: r[1] }));

  return {
    totalBookmarks: total,
    uniqueAuthors: authors,
    categoriesCount,
    domainsCount,
    dateRange: { earliest: range?.[0] ?? null, latest: range?.[1] ?? null },
    topAuthors,
    topCategories,
    topDomains,
  };
}

function handleCategories(db: Database): unknown {
  const rows = db.exec(
    `SELECT primary_category, COUNT(*) as c FROM bookmarks WHERE primary_category IS NOT NULL GROUP BY primary_category ORDER BY c DESC`
  );
  return { categories: (rows[0]?.values ?? []).map((r) => ({ name: r[0], count: r[1] })) };
}

function handleDomains(db: Database): unknown {
  const rows = db.exec(
    `SELECT primary_domain, COUNT(*) as c FROM bookmarks WHERE primary_domain IS NOT NULL GROUP BY primary_domain ORDER BY c DESC`
  );
  return { domains: (rows[0]?.values ?? []).map((r) => ({ name: r[0], count: r[1] })) };
}

function handleTimeline(db: Database): unknown {
  let rows = db.exec(`
    SELECT strftime('%Y-%W', COALESCE(bookmarked_at, posted_at)) as week, COUNT(*) as c
    FROM bookmarks
    WHERE COALESCE(bookmarked_at, posted_at) IS NOT NULL
      AND COALESCE(bookmarked_at, posted_at) GLOB '____-__-__*'
    GROUP BY week ORDER BY week
  `);

  if (!rows.length || !rows[0].values.length) {
    rows = db.exec(`
      SELECT 'chunk-' || (rowid / 100) as period, COUNT(*) as c
      FROM bookmarks
      GROUP BY period
      ORDER BY rowid
    `);
  }

  return { timeline: (rows[0]?.values ?? []).map((r) => ({ period: r[0], count: r[1] })) };
}

// ── Router ──────────────────────────────────────────────────────────────────

async function handleApi(
  db: Database,
  dbPath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  state?: { db: Database },
): Promise<void> {
  try {

    // ── Ideas / Quick Notepad API ─────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/ideas') {
      sendJson(res, loadIdeas());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ideas') {
      const body = await parseBody(req);
      const ideaData = JSON.parse(body);
      const newIdea = createIdea(ideaData);
      sendJson(res, newIdea);
      return;
    }

    const ideaMatch = pathname.match(/^\/api\/ideas\/([^/]+)$/);
    if (req.method === 'DELETE' && ideaMatch) {
      const id = decodeURIComponent(ideaMatch[1]);
      deleteIdea(id);
      sendJson(res, { success: true });
      return;
    }

    const promoteMatch = pathname.match(/^\/api\/ideas\/([^/]+)\/promote$/);
    if (req.method === 'POST' && promoteMatch) {
      const id = decodeURIComponent(promoteMatch[1]);
      const result = promoteIdeaToMarkdown(id);
      sendJson(res, result);
      return;
    }

        if (req.method === 'GET' && pathname === '/api/bookmarks') {
      sendJson(res, handleBookmarks(db, url.searchParams));
      return;
    }

    const bookmarkMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)$/);
    if (req.method === 'GET' && bookmarkMatch) {
      const result = handleBookmarkById(db, bookmarkMatch[1]);
      if (!result) { sendError(res, 'Not found', 404); return; }
      sendJson(res, result);
      return;
    }

    const noteMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)\/note$/);
    if (req.method === 'POST' && noteMatch) {
      const body = await parseBody(req);
      const { note } = JSON.parse(body) as { note: string };
      const id = noteMatch[1];
      const now = new Date().toISOString();
      db.run(
        `INSERT OR REPLACE INTO bookmark_notes (bookmark_id, note, updated_at) VALUES (?, ?, ?)`,
        [id, note ?? '', now],
      );
      saveDb(db, dbPath);
      sendJson(res, { success: true, updatedAt: now });
      return;
    }

    const categoryMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)\/category$/);
    if (req.method === 'POST' && categoryMatch) {
      const body = await parseBody(req);
      const { category: rawCategory } = JSON.parse(body) as { category?: string };
      const id = decodeURIComponent(categoryMatch[1]);
      const category = normalizeCategory(rawCategory);
      if (!category) {
        sendError(res, 'Category must be a lowercase slug like tool, research, or ai-news.', 400);
        return;
      }
      db.run(`UPDATE bookmarks SET categories = ?, primary_category = ? WHERE id = ?`, [category, category, id]);
      saveDb(db, dbPath);
      sendJson(res, { success: true, category, categories: [category], primaryCategory: category });
      return;
    }

    const deleteMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      const id = decodeURIComponent(deleteMatch[1]);
      const body = await parseBody(req);
      let fromX = false;
      try { fromX = JSON.parse(body).fromX === true; } catch {}

      const bookmarkRows = db.exec(`SELECT id, tweet_id FROM bookmarks WHERE id = ? LIMIT 1`, [id]);
      const bookmarkRow = bookmarkRows[0]?.values?.[0];
      if (!bookmarkRow) {
        sendError(res, 'Bookmark not found', 404);
        return;
      }
      const tweetId = String(bookmarkRow[1] ?? id);

      let xDeleted = false;
      let xStatus: number | undefined;
      if (fromX) {
        try {
          const xResult = await deleteTwitterBookmark(tweetId);
          xStatus = xResult.status;
          if (!xResult.ok) {
            sendJson(res, {
              success: false,
              localDeleted: false,
              xDeleted: false,
              xStatus,
              xError: xResult.detail,
            }, 502);
            return;
          }
          xDeleted = true;
        } catch (err) {
          sendJson(res, {
            success: false,
            localDeleted: false,
            xDeleted: false,
            xError: err instanceof Error ? err.message : String(err),
          }, 502);
          return;
        }
      }

      db.run('BEGIN TRANSACTION');
      try {
        db.run(`DELETE FROM bookmark_notes WHERE bookmark_id = ?`, [id]);
        db.run(`DELETE FROM bookmark_collections WHERE bookmark_id = ?`, [id]);
        db.run(`DELETE FROM bookmark_read_status WHERE bookmark_id = ?`, [id]);
        db.run(`DELETE FROM bookmark_highlights WHERE bookmark_id = ?`, [id]);
        db.run(`DELETE FROM dead_links WHERE bookmark_id = ?`, [id]);
        db.run(`DELETE FROM bookmarks WHERE id = ?`, [id]);
        db.run(`INSERT INTO bookmarks_fts(bookmarks_fts) VALUES('rebuild')`);
        db.run('COMMIT');
      } catch (err) {
        db.run('ROLLBACK');
        throw err;
      }
      saveDb(db, dbPath);

      try {
        const cachePath = twitterBookmarksCachePath();
        const records = await readJsonLines<{ id: string; tweetId?: string }>(cachePath);
        const filtered = records.filter(r => r.id !== id && r.tweetId !== tweetId);
        if (filtered.length < records.length) {
          await writeJsonLines(cachePath, filtered);
        }
      } catch {}
      sendJson(res, { success: true, localDeleted: true, xDeleted, xStatus });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/stats') {
      sendJson(res, handleStats(db));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/authors') {
      const q = (url.searchParams.get('q') || '').trim().replace(/^@/, '');
      let sql: string;
      let qp: string[];
      if (q) {
        sql = `SELECT author_handle, author_name, COUNT(*) as c
          FROM bookmarks
          WHERE author_handle IS NOT NULL
            AND (author_handle LIKE ? COLLATE NOCASE OR author_name LIKE ? COLLATE NOCASE)
          GROUP BY author_handle
          ORDER BY
            CASE WHEN author_handle LIKE ? COLLATE NOCASE THEN 0 ELSE 1 END,
            c DESC
          LIMIT 20`;
        qp = [`%${q}%`, `%${q}%`, `${q}%`];
      } else {
        sql = `SELECT author_handle, author_name, COUNT(*) as c FROM bookmarks WHERE author_handle IS NOT NULL GROUP BY author_handle ORDER BY c DESC LIMIT 20`;
        qp = [];
      }
      const rows = db.exec(sql, qp);
      const authors = (rows[0]?.values ?? []).map(r => ({ handle: r[0], name: r[1], count: Number(r[2]) }));
      sendJson(res, { authors });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/categories') {
      sendJson(res, handleCategories(db));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/domains') {
      sendJson(res, handleDomains(db));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/timeline') {
      sendJson(res, handleTimeline(db));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/collections') {
      const rows = db.exec(`
        SELECT c.name, c.color, c.created_at, c.keywords, COUNT(bc.bookmark_id) as count
        FROM collections c
        LEFT JOIN bookmark_collections bc ON bc.collection_name = c.name
        GROUP BY c.name ORDER BY count DESC, c.name
      `);
      const collections = (rows[0]?.values ?? []).map(r => ({
        name: r[0], color: r[1], createdAt: r[2], keywords: r[3] ?? '', count: Number(r[4]),
      }));
      sendJson(res, { collections });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/collections') {
      const body = JSON.parse(await parseBody(req)) as { name: string; color?: string };
      const name = (body.name || '').trim();
      if (!name) { sendError(res, 'Name is required', 400); return; }
      const now = new Date().toISOString();
      db.run(`INSERT OR IGNORE INTO collections (name, color, created_at) VALUES (?, ?, ?)`,
        [name, body.color || null, now]);
      saveDb(db, dbPath);
      sendJson(res, { success: true, name });
      return;
    }

    const colDeleteMatch = pathname.match(/^\/api\/collections\/([^/]+)$/);
    if (req.method === 'DELETE' && colDeleteMatch) {
      const name = decodeURIComponent(colDeleteMatch[1]);
      db.run(`DELETE FROM bookmark_collections WHERE collection_name = ?`, [name]);
      db.run(`DELETE FROM collections WHERE name = ?`, [name]);
      saveDb(db, dbPath);
      sendJson(res, { success: true });
      return;
    }

    const addColMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)\/collections$/);
    if (req.method === 'POST' && addColMatch) {
      const id = addColMatch[1];
      const body = JSON.parse(await parseBody(req)) as { collection: string };
      const name = (body.collection || '').trim();
      if (!name) { sendError(res, 'Collection name is required', 400); return; }
      const now = new Date().toISOString();
      db.run(`INSERT OR IGNORE INTO collections (name, color, created_at) VALUES (?, ?, ?)`,
        [name, null, now]);
      db.run(`INSERT OR IGNORE INTO bookmark_collections (bookmark_id, collection_name, added_at) VALUES (?, ?, ?)`,
        [id, name, now]);
      saveDb(db, dbPath);
      sendJson(res, { success: true });
      return;
    }

    const rmColMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)\/collections\/([^/]+)$/);
    if (req.method === 'DELETE' && rmColMatch) {
      const id = rmColMatch[1];
      const name = decodeURIComponent(rmColMatch[2]);
      db.run(`DELETE FROM bookmark_collections WHERE bookmark_id = ? AND collection_name = ?`, [id, name]);
      saveDb(db, dbPath);
      sendJson(res, { success: true });
      return;
    }

    const readMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)\/read$/);
    if (req.method === 'POST' && readMatch) {
      const id = readMatch[1];
      const rawBody = await parseBody(req);
      let requestedRead: boolean | undefined;
      if (rawBody.trim()) {
        try {
          const body = JSON.parse(rawBody) as { read?: boolean };
          if (typeof body.read === 'boolean') requestedRead = body.read;
        } catch {
          sendError(res, 'Invalid JSON body', 400);
          return;
        }
      }
      const currentRows = db.exec(`SELECT is_read FROM bookmark_read_status WHERE bookmark_id = ?`, [id]);
      const currentRead = Number(currentRows[0]?.values?.[0]?.[0] ?? 0) === 1;
      const nextRead = requestedRead ?? !currentRead;
      const now = new Date().toISOString();
      if (nextRead) {
        db.run(`INSERT OR REPLACE INTO bookmark_read_status (bookmark_id, is_read, read_at) VALUES (?, 1, ?)`, [id, now]);
      } else {
        db.run(`INSERT OR REPLACE INTO bookmark_read_status (bookmark_id, is_read, read_at) VALUES (?, 0, NULL)`, [id]);
      }
      saveDb(db, dbPath);
      sendJson(res, { success: true, isRead: nextRead });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/unread-count') {
      const rows = db.exec(`SELECT COUNT(*) FROM bookmarks WHERE id NOT IN (SELECT bookmark_id FROM bookmark_read_status WHERE is_read = 1)`);
      const count = Number(rows[0]?.values[0]?.[0] ?? 0);
      sendJson(res, { count });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/saved-searches') {
      const rows = db.exec(`SELECT id, name, query, created_at FROM saved_searches ORDER BY created_at DESC`);
      const searches = (rows[0]?.values ?? []).map(r => {
        const id = r[0];
        const name = r[1];
        const query = r[2] as string;
        const createdAt = r[3] as string;
        let newCount = 0;
        try {
          const countRows = db.exec(
            `SELECT COUNT(*) FROM bookmarks b WHERE b.id IN (SELECT b2.id FROM bookmarks_fts(?) b2) AND COALESCE(b.bookmarked_at, b.posted_at) > ?`,
            [query, createdAt],
          );
          newCount = Number(countRows[0]?.values[0]?.[0] ?? 0);
        } catch {}
        return { id, name, query, createdAt, newCount };
      });
      sendJson(res, { searches });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/saved-searches') {
      const body = JSON.parse(await parseBody(req)) as { name: string; query: string };
      const name = (body.name || '').trim();
      const query = (body.query || '').trim();
      if (!name || !query) { sendError(res, 'Name and query are required', 400); return; }
      const now = new Date().toISOString();
      db.run(`INSERT INTO saved_searches (name, query, created_at) VALUES (?, ?, ?)`, [name, query, now]);
      saveDb(db, dbPath);
      sendJson(res, { success: true });
      return;
    }

    const savedSearchDeleteMatch = pathname.match(/^\/api\/saved-searches\/(\d+)$/);
    if (req.method === 'DELETE' && savedSearchDeleteMatch) {
      const id = Number(savedSearchDeleteMatch[1]);
      db.run(`DELETE FROM saved_searches WHERE id = ?`, [id]);
      saveDb(db, dbPath);
      sendJson(res, { success: true });
      return;
    }

    const highlightsGetMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)\/highlights$/);
    if (req.method === 'GET' && highlightsGetMatch) {
      const bookmarkId = highlightsGetMatch[1];
      const rows = db.exec(`SELECT id, bookmark_id, text_fragment, color, created_at FROM bookmark_highlights WHERE bookmark_id = ? ORDER BY created_at DESC`, [bookmarkId]);
      const highlights = (rows[0]?.values ?? []).map(r => ({ id: r[0], bookmarkId: r[1], textFragment: r[2], color: r[3], createdAt: r[4] }));
      sendJson(res, { highlights });
      return;
    }

    const highlightsPostMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)\/highlights$/);
    if (req.method === 'POST' && highlightsPostMatch) {
      const bookmarkId = highlightsPostMatch[1];
      const body = JSON.parse(await parseBody(req)) as { textFragment: string; color?: string };
      const textFragment = (body.textFragment || '').trim();
      if (!textFragment) { sendError(res, 'textFragment is required', 400); return; }
      const color = body.color || 'yellow';
      const now = new Date().toISOString();
      db.run(`INSERT INTO bookmark_highlights (bookmark_id, text_fragment, color, created_at) VALUES (?, ?, ?, ?)`, [bookmarkId, textFragment, color, now]);
      saveDb(db, dbPath);
      sendJson(res, { success: true });
      return;
    }

    const highlightDeleteMatch = pathname.match(/^\/api\/highlights\/(\d+)$/);
    if (req.method === 'DELETE' && highlightDeleteMatch) {
      const id = Number(highlightDeleteMatch[1]);
      db.run(`DELETE FROM bookmark_highlights WHERE id = ?`, [id]);
      saveDb(db, dbPath);
      sendJson(res, { success: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/check-links') {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const rows = db.exec(`SELECT b.id, b.url FROM bookmarks b WHERE b.id NOT IN (SELECT bookmark_id FROM dead_links WHERE checked_at > ?) LIMIT 50`, [sevenDaysAgo]);
      const bookmarks = rows[0]?.values ?? [];
      let checked = 0; let dead = 0;
      for (const row of bookmarks) {
        const id = row[0] as string; const bookmarkUrl = row[1] as string;
        if (!bookmarkUrl) continue;
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const response = await fetch(bookmarkUrl, { method: 'HEAD', signal: controller.signal });
          clearTimeout(timeout);
          const now = new Date().toISOString();
          if (response.status >= 400) {
            db.run(`INSERT OR REPLACE INTO dead_links (bookmark_id, status, checked_at) VALUES (?, ?, ?)`, [id, response.status, now]);
            dead++;
          } else { db.run(`DELETE FROM dead_links WHERE bookmark_id = ?`, [id]); }
          checked++;
        } catch {
          const now = new Date().toISOString();
          db.run(`INSERT OR REPLACE INTO dead_links (bookmark_id, status, checked_at) VALUES (?, ?, ?)`, [id, 0, now]);
          checked++; dead++;
        }
      }
      saveDb(db, dbPath);
      sendJson(res, { checked, dead });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/dead-links') {
      const rows = db.exec(`SELECT bookmark_id, status, checked_at FROM dead_links ORDER BY checked_at DESC`);
      const deadLinks = (rows[0]?.values ?? []).map(r => ({ bookmarkId: r[0], status: r[1], checkedAt: r[2] }));
      sendJson(res, { deadLinks });
      return;
    }

    const colRulesPutMatch = pathname.match(/^\/api\/collections\/([^/]+)\/rules$/);
    if (req.method === 'PUT' && colRulesPutMatch) {
      const name = decodeURIComponent(colRulesPutMatch[1]);
      const body = JSON.parse(await parseBody(req)) as { keywords: string };
      db.run(`UPDATE collections SET keywords = ? WHERE name = ?`, [body.keywords || null, name]);
      saveDb(db, dbPath);
      sendJson(res, { success: true });
      return;
    }

    const colRulesGetMatch = pathname.match(/^\/api\/collections\/([^/]+)\/rules$/);
    if (req.method === 'GET' && colRulesGetMatch) {
      const name = decodeURIComponent(colRulesGetMatch[1]);
      const rows = db.exec(`SELECT keywords FROM collections WHERE name = ?`, [name]);
      const keywords = rows[0]?.values[0]?.[0] as string | null;
      sendJson(res, { name, keywords: keywords || '' });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auto-classify') {
      const colRows = db.exec(`SELECT name, keywords FROM collections WHERE keywords IS NOT NULL AND keywords != ''`);
      let matched = 0;
      for (const row of (colRows[0]?.values ?? [])) {
        const collectionName = row[0] as string;
        const keywords = (row[1] as string).split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
        if (!keywords.length) continue;
        const bookmarkRows = db.exec(`SELECT b.id, b.text FROM bookmarks b WHERE b.id NOT IN (SELECT bookmark_id FROM bookmark_collections WHERE collection_name = ?)`, [collectionName]);
        const now = new Date().toISOString();
        for (const bRow of (bookmarkRows[0]?.values ?? [])) {
          const bid = bRow[0] as string;
          const text = ((bRow[1] as string) || '').toLowerCase();
          if (keywords.some(kw => text.includes(kw))) {
            db.run(`INSERT OR IGNORE INTO bookmark_collections (bookmark_id, collection_name, added_at) VALUES (?, ?, ?)`, [bid, collectionName, now]);
            matched++;
          }
        }
      }
      if (matched > 0) saveDb(db, dbPath);
      sendJson(res, { matched, classified: matched });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/duplicates') {
      const textRows = db.exec(`SELECT SUBSTR(b.text, 1, 100) as prefix, GROUP_CONCAT(b.id) as ids FROM bookmarks b WHERE b.text IS NOT NULL AND LENGTH(b.text) > 0 GROUP BY prefix HAVING COUNT(*) > 1`);
      const textGroups = (textRows[0]?.values ?? []).map(r => ({ type: 'similar_text', ids: (r[1] as string).split(','), preview: r[0] as string }));
      const linkRows = db.exec(`SELECT b.links_json, MIN(b.url) as sample_url, GROUP_CONCAT(b.id) as ids FROM bookmarks b WHERE b.links_json IS NOT NULL AND b.links_json != '[]' AND b.links_json != '' GROUP BY b.links_json HAVING COUNT(*) > 1`);
      const linkGroups = (linkRows[0]?.values ?? []).map(r => ({ type: 'same_links', ids: (r[2] as string).split(','), preview: (r[1] as string) || (r[0] as string) }));
      sendJson(res, { groups: [...textGroups, ...linkGroups] });
      return;
    }

    const markdownMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)\/markdown$/);
    if (req.method === 'GET' && markdownMatch) {
      const id = markdownMatch[1];
      const rows = db.exec(`SELECT ${BOOKMARK_COLS} FROM bookmarks b WHERE b.id = ? LIMIT 1`, [id]);
      const row = rows[0]?.values?.[0];
      if (!row) { sendError(res, 'Not found', 404); return; }
      const bm = mapRow(row) as Record<string, unknown>;
      let md = `# ${bm.authorName || bm.authorHandle || 'Unknown'}\n\n${bm.text || ''}\n\n`;
      const links = bm.links as string[] | undefined;
      if (links?.length) { md += `## Links\n\n`; for (const link of links) md += `- ${link}\n`; md += '\n'; }
      md += `---\n*Posted: ${bm.postedAt || 'N/A'}*  \n*Bookmarked: ${bm.bookmarkedAt || 'N/A'}*  \n*URL: ${bm.url || 'N/A'}*\n`;
      sendJson(res, { markdown: md });
      return;
    }

    const htmlExportMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)\/html-export$/);
    if (req.method === 'GET' && htmlExportMatch) {
      const id = htmlExportMatch[1];
      const rows = db.exec(`SELECT ${BOOKMARK_COLS} FROM bookmarks b WHERE b.id = ? LIMIT 1`, [id]);
      const row = rows[0]?.values?.[0];
      if (!row) { sendError(res, 'Not found', 404); return; }
      const bm = mapRow(row) as Record<string, unknown>;
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const links = bm.links as string[] | undefined;
      const linksHtml = (links || []).map((l: string) => `<li><a href="${esc(l)}">${esc(l)}</a></li>`).join('\n');
      const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Bookmark - ${esc(String(bm.authorHandle || 'Unknown'))}</title><style>body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }.author { font-weight: bold; font-size: 1.2rem; }.text { margin: 1rem 0; white-space: pre-wrap; }.meta { color: #666; font-size: 0.9rem; }a { color: #1d9bf0; }</style></head><body><div class="author">${esc(String(bm.authorName || ''))} (@${esc(String(bm.authorHandle || ''))})</div><div class="text">${esc(String(bm.text || ''))}</div>${linksHtml ? `<ul>${linksHtml}</ul>` : ''}<div class="meta"><p>Posted: ${esc(String(bm.postedAt || 'N/A'))}</p><p>Bookmarked: ${esc(String(bm.bookmarkedAt || 'N/A'))}</p><p>URL: <a href="${esc(String(bm.url || ''))}">${esc(String(bm.url || 'N/A'))}</a></p></div></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/analytics') {
      const analyticsRows = db.exec(`SELECT b.posted_at, b.bookmarked_at, b.synced_at, b.primary_category FROM bookmarks b`);
      const rows = analyticsRows[0]?.values ?? [];
      const now = Date.now();
      const last30DaysMs = now - (30 * 86400000); const last84DaysMs = now - (84 * 86400000); const last56DaysMs = now - (56 * 86400000);
      const dayCounts = new Map<string, number>(); const hourCounts = new Map<number, number>(); const weekCounts = new Map<string, number>(); const categoryTotals = new Map<string, number>(); const categoryWeekly = new Map<string, Map<string, number>>();
      for (const row of rows) {
        const date = parseBookmarkDate(row[1], row[0], row[2]); if (!date) continue; const time = date.getTime();
        incrementCount(hourCounts, date.getUTCHours());
        if (time >= last30DaysMs) incrementCount(dayCounts, formatUtcDay(date));
        if (time >= last84DaysMs) incrementCount(weekCounts, formatUtcWeek(date));
        if (row[3] && row[3] !== 'unclassified') {
          const cat = row[3] as string; incrementCount(categoryTotals, cat);
          if (time >= last56DaysMs) {
            const week = formatUtcWeek(date); const weekly = categoryWeekly.get(cat) ?? new Map<string, number>();
            incrementCount(weekly, week); categoryWeekly.set(cat, weekly);
          }
        }
      }
      const dailyCounts = toSortedCountEntries(dayCounts, 'date');
      const hourlyCounts = [...hourCounts.entries()].sort(([a], [b]) => a - b).map(([hour, count]) => ({ hour, count }));
      const weeklyVelocity = toSortedCountEntries(weekCounts, 'week');
      const topCategories = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([category]) => category);
      const categoryGrowth: Record<string, any> = {};
      for (const cat of topCategories) { categoryGrowth[cat] = toSortedCountEntries(categoryWeekly.get(cat) ?? new Map(), 'week'); }
      sendJson(res, { dailyCounts, hourlyCounts, weeklyVelocity, categoryGrowth });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/start') {
      try {
        sendJson(res, { url: await startAuthFlow() });
      } catch (err) {
        sendError(res, err instanceof Error ? err.message : String(err), 500);
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/grab') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('status', { stage: 'syncing', message: 'Grabbing new bookmarks from X...' });
      try {
        let syncResult: Awaited<ReturnType<typeof syncBookmarksGraphQL>> | undefined;
        let lastBrowserError: unknown;

        for (const browserId of installedBrowserIds()) {
          const browser = getBrowser(browserId);
          send('status', { stage: 'syncing', message: `Trying ${browser.displayName} session...` });
          try {
            syncResult = await syncBookmarksGraphQL({ incremental: true, maxPages: 50, delayMs: 600, maxMinutes: 5, browser: browserId, onProgress: (s) => send('progress', s) });
            break;
          } catch (browserErr) {
            if (!isCookieReadFailure(browserErr)) throw browserErr;
            lastBrowserError = browserErr;
          }
        }

        if (!syncResult) {
          send('status', { stage: 'syncing', message: 'Browser sessions were unavailable. Trying OAuth API...' });
          try {
            const apiResult = await syncTwitterBookmarks('incremental', { targetAdds: 50 });
            send('progress', { added: apiResult.added, newAdded: apiResult.added, totalFetched: apiResult.totalBookmarks, running: false, done: true, stopReason: 'oauth api fallback' });
            send('status', { stage: apiResult.added > 0 ? 'indexing' : 'complete', message: apiResult.added > 0 ? 'Indexing...' : 'Done.' });
            if (apiResult.added > 0) await rebuildIndexAndReload(dbPath, state);
            send('done', { ...apiResult, provider: 'x-api', stopReason: 'oauth api fallback' });
            res.end();
            return;
          } catch (apiErr) {
            const browserMessage = lastBrowserError instanceof Error ? lastBrowserError.message : String(lastBrowserError ?? 'No installed browser session could be used.');
            const apiMessage = apiErr instanceof Error ? apiErr.message : String(apiErr);
            let authUrl: string | undefined;
            if (/Missing user-context OAuth token/i.test(apiMessage)) {
              try { authUrl = startAuthFlow(); } catch {}
            }

            if (authUrl) {
              send('auth_required', {
                url: authUrl,
                message: 'Authorize Xtreme Bookmarks with X, then press Grab again.',
              });
            }

            const error = new Error(authUrl
              ? 'Authorization required. Approve X access in the tab that just opened, then press Grab again.'
              : `Could not sync from any installed browser session.\n\n` +
                `Last browser error: ${browserMessage}\n\n` +
                `OAuth fallback also failed: ${apiMessage}\n\n` +
                'Fix: log into X in Brave/Comet, close Chrome/Edge completely and retry, or run: node bin/ft.mjs auth'
            );
            (error as Error & { authUrl?: string }).authUrl = authUrl;
            throw error;
          }
        }

        const shouldRebuild = syncResult.added > 0 || syncResult.bookmarkedAtRepaired > 0;
        send('status', { stage: shouldRebuild ? 'indexing' : 'complete', message: shouldRebuild ? 'Indexing...' : 'Done.' });
        if (shouldRebuild) await rebuildIndexAndReload(dbPath, state);
        send('done', syncResult);
      } catch (err) { send('error', { message: (err as Error).message, authUrl: (err as Error & { authUrl?: string }).authUrl }); }
      res.end();
      return;
    }

    if (req.method === 'POST' && pathname === '/api/wiki') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('status', { stage: 'compiling', message: 'Building knowledge base...' });
      try {
        const result = await compileMd({ nonInteractive: true, onProgress: (msg) => send('progress', { message: msg }) });
        send('done', result);
      } catch (err) { send('error', { message: (err as Error).message }); }
      res.end();
      return;
    }

    const addBookmarkWikiMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)\/wiki$/);
    if (addBookmarkWikiMatch) {
      const id = decodeURIComponent(addBookmarkWikiMatch[1]);
      const currentRows = db.exec(`SELECT in_wiki FROM bookmarks WHERE id = ?`, [id]);
      const currentlyInWiki = Number(currentRows[0]?.values?.[0]?.[0] ?? 0) === 1;

      if (req.method === 'POST') {
        const body = await parseBody(req).catch(() => '{}');
        let nextWiki = !currentlyInWiki;
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed.inWiki === 'boolean') nextWiki = parsed.inWiki;
        } catch {}
        
        await updateBookmarkWikiStatus(id, nextWiki);
        if (state) { state.db.close(); state.db = await openDb(dbPath); } 
        sendJson(res, { success: true, inWiki: nextWiki });
        return;
      }
      if (req.method === 'DELETE') {
        await updateBookmarkWikiStatus(id, false);
        if (state) { state.db.close(); state.db = await openDb(dbPath); }
        sendJson(res, { success: true, inWiki: false });
        return;
      }
    }

    // ── 2nd Brain API endpoints ─────────────────────────────────────────

    if (req.method === 'GET' && pathname === '/api/brain/dashboard') {
      sendJson(res, await brainDashboard());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/brain/engine') {
      const engines = detectAvailableEngines();
      const prefs = loadPreferences();
      const grokOauth = getGrokOauthStatus();
      sendJson(res, {
        engines,
        defaultEngine: prefs.defaultEngine ?? null,
        grokConfigured: engines.includes('grok'),
        superGrokOauthAvailable: grokOauth.cliInstalled && grokOauth.loggedIn,
        superGrokCliInstalled: grokOauth.cliInstalled,
        superGrokLoggedIn: grokOauth.loggedIn,
        superGrokVia: grokOauth.via,
        grokApiConfigured: engines.includes('grok-api'),
        model: process.env.XAI_MODEL || 'grok-4.3',
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/settings/x-credentials') {
      const body = JSON.parse(await parseBody(req)) as {
        apiKey?: string;
        apiSecret?: string;
        bearerToken?: string;
      };
      const entries: Record<string, string | undefined> = {
        X_API_KEY: body.apiKey,
        X_API_SECRET: body.apiSecret,
        X_BEARER_TOKEN: body.bearerToken,
      };
      const envPath = path.join(process.cwd(), '.env.local');
      const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8').split(/\r?\n/) : [];
      const next = [...lines];
      for (const [name, value] of Object.entries(entries)) {
        if (typeof value !== 'string' || !value.trim()) continue;
        const idx = next.findIndex((line) => new RegExp(`^\\s*${name}=`).test(line));
        if (idx >= 0) next[idx] = `${name}=${value.trim()}`;
        else next.push(`${name}=${value.trim()}`);
        process.env[name] = value.trim();
      }
      fs.writeFileSync(envPath, next.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', 'utf-8');
      sendJson(res, {
        success: true,
        saved: Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, Boolean(value && value.trim())])),
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/settings/x-credentials/test') {
      const bodyText = await parseBody(req).catch(() => '{}');
      let tweetId = '20';
      try {
        const body = bodyText.trim() ? JSON.parse(bodyText) as { tweetId?: string } : {};
        if (typeof body.tweetId === 'string' && /^\d{1,20}$/.test(body.tweetId)) tweetId = body.tweetId;
      } catch {}

      const bearerToken = process.env.X_BEARER_TOKEN;
      if (!bearerToken) {
        sendJson(res, { ok: false, status: 0, message: 'X_BEARER_TOKEN is not set.' }, 400);
        return;
      }

      const apiRes = await fetch(
        `https://api.x.com/2/tweets/${encodeURIComponent(tweetId)}?tweet.fields=created_at,author_id,public_metrics`,
        { headers: { Authorization: `Bearer ${bearerToken}` } },
      );
      const text = await apiRes.text();
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch {}
      const data = parsed.data as { id?: string; text?: string } | undefined;
      const errors = parsed.errors as Array<{ title?: string; detail?: string }> | undefined;
      sendJson(res, {
        ok: apiRes.ok,
        status: apiRes.status,
        tweetId,
        hasData: Boolean(data?.id),
        textLength: data?.text?.length ?? 0,
        message: apiRes.ok
          ? 'X API post retrieval works.'
          : String((parsed.title as string | undefined) || errors?.[0]?.title || (parsed.detail as string | undefined) || 'X API request failed.'),
      }, apiRes.ok ? 200 : 200);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/x/webhook') {
      const crcToken = url.searchParams.get('crc_token');
      if (crcToken) {
        try {
          sendJson(res, { response_token: createXChallengeResponse(crcToken) });
        } catch (err) {
          sendError(res, (err as Error).message, 500);
        }
        return;
      }
      sendJson(res, {
        ok: true,
        ready: Boolean(getXConsumerSecret()),
        endpoint: '/api/x/webhook',
        message: getXConsumerSecret()
          ? 'Xtreme webhook receiver is ready for X CRC checks and event posts.'
          : 'Set X_API_SECRET before registering this webhook with X.',
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/x/webhook') {
      const rawBody = await parseBody(req);
      const signature = String(req.headers['x-twitter-webhooks-signature'] || req.headers['x-x-webhooks-signature'] || '');
      let payload: Record<string, unknown> = {};
      let eventType = 'invalid-json';
      try {
        payload = rawBody.trim() ? JSON.parse(rawBody) as Record<string, unknown> : {};
        eventType = detectXEventType(payload);
      } catch {}
      const receivedAt = new Date().toISOString();
      db.run(
        `INSERT INTO x_webhook_events (event_type, payload_json, signature, received_at)
         VALUES (?, ?, ?, ?)`,
        [eventType, rawBody || '{}', signature, receivedAt],
      );
      saveDb(db, dbPath);
      sendJson(res, { success: true, eventType, receivedAt });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/x/webhook/events') {
      const rawLimit = Number(url.searchParams.get('limit') || 50);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
      const rows = db.exec(
        `SELECT id, event_type, payload_json, signature, received_at
         FROM x_webhook_events
         ORDER BY id DESC
         LIMIT ?`,
        [limit],
      );
      const events = (rows[0]?.values ?? []).map((row) => {
        let payload: unknown = {};
        try { payload = JSON.parse(String(row[2] ?? '{}')); } catch { payload = { raw: String(row[2] ?? '') }; }
        return {
          id: Number(row[0]),
          eventType: String(row[1] ?? 'unknown'),
          payload,
          hasSignature: Boolean(row[3]),
          receivedAt: String(row[4] ?? ''),
        };
      });
      sendJson(res, { events });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/x/watchlist') {
      sendJson(res, { accounts: listXWatchAccounts(db) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/x/watchlist') {
      const body = JSON.parse(await parseBody(req)) as { handle?: string; backfill?: boolean };
      let account;
      try {
        account = await addXWatchAccount(db, dbPath, body.handle || '');
      } catch (err) {
        if (sendXApiError(res, err)) return;
        throw err;
      }
      let backfill: { saved: number; handle: string } | null = null;
      let backfillError: string | null = null;
      if (body.backfill !== false) {
        try {
          backfill = await pollXWatchAccountViaBrowser(db, dbPath, account.handle);
        } catch (err) {
          backfillError = (err as Error).message;
        }
      }
      await startXBrowserPoller(xBrowserPollOptions(dbPath, state));
      sendJson(res, { account, backfill, backfillError, rule: null, status: getXStreamStatus() });
      return;
    }

    const watchDeleteMatch = pathname.match(/^\/api\/x\/watchlist\/([^/]+)$/);
    if (req.method === 'PATCH' && watchDeleteMatch) {
      const handle = decodeURIComponent(watchDeleteMatch[1]);
      const body = JSON.parse(await parseBody(req)) as { includeReplies?: boolean };
      const account = updateXWatchAccount(db, dbPath, handle, { includeReplies: body.includeReplies });
      sendJson(res, { account, rule: null, status: getXStreamStatus() });
      return;
    }

    if (req.method === 'DELETE' && watchDeleteMatch) {
      const handle = decodeURIComponent(watchDeleteMatch[1]);
      removeXWatchAccount(db, dbPath, handle);
      if (listXWatchAccounts(db).length === 0) stopXBrowserPoller();
      sendJson(res, { success: true, rule: null, status: getXStreamStatus() });
      return;
    }

    const watchBackfillMatch = pathname.match(/^\/api\/x\/watchlist\/([^/]+)\/backfill$/);
    if (req.method === 'POST' && watchBackfillMatch) {
      const handle = decodeURIComponent(watchBackfillMatch[1]);
      try {
        sendJson(res, await pollXWatchAccountViaBrowser(db, dbPath, handle));
      } catch (err) {
        if (sendXApiError(res, err)) return;
        throw err;
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/x/watchlist/backfill') {
      try {
        const fast = url.searchParams.get('fast') === 'true';
        const asyncRun = url.searchParams.get('async') === 'true';
        const pollOptions = fast ? manualXBrowserPollOptions() : {};
        const before = getXStreamStatus();
        if (asyncRun) {
          const status = runXBrowserPollInBackground(xBrowserPollOptions(dbPath, state, false, pollOptions));
          sendJson(res, {
            started: !before.pollerInFlight,
            alreadyRunning: before.pollerInFlight,
            status,
          });
        } else {
          sendJson(res, await runXBrowserPollOnce(xBrowserPollOptions(dbPath, state, true, pollOptions)));
        }
      } catch (err) {
        if (sendXApiError(res, err)) return;
        throw err;
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/x/feed') {
      const rawLimit = Number(url.searchParams.get('limit') || 50);
      const typeParam = url.searchParams.get('type');
      const type = typeParam === 'post' || typeParam === 'reply' ? typeParam : 'all';
      const account = url.searchParams.get('account') || undefined;
      sendJson(res, { items: listXStreamItems(db, rawLimit, type, account) });
      return;
    }

    if (req.method === 'DELETE' && pathname === '/api/x/feed') {
      const account = url.searchParams.get('account') || undefined;
      const freshDb = await openDb(dbPath);
      let removed = 0;
      try {
        removed = await removeXStreamItemsAndSave(freshDb, dbPath, account ? { sourceAccount: account } : {});
      } finally {
        freshDb.close();
      }
      await reloadStateDb(dbPath, state);
      sendJson(res, { success: true, removed, account: account ?? null });
      return;
    }

    const feedBookmarkMatch = pathname.match(/^\/api\/x\/feed\/([^/]+)\/bookmark$/);
    if (req.method === 'POST' && feedBookmarkMatch) {
      const result = await saveXStreamItemToBookmarks(db, decodeURIComponent(feedBookmarkMatch[1]));
      await rebuildIndexAndReload(dbPath, state);
      sendJson(res, { ...result, bookmarkId: result.record.id });
      return;
    }

    const feedItemMatch = pathname.match(/^\/api\/x\/feed\/([^/]+)$/);
    if (req.method === 'DELETE' && feedItemMatch) {
      const freshDb = await openDb(dbPath);
      let removed = false;
      try {
        removed = await removeXStreamItemAndSave(freshDb, dbPath, decodeURIComponent(feedItemMatch[1]));
      } finally {
        freshDb.close();
      }
      await reloadStateDb(dbPath, state);
      sendJson(res, { success: true, removed });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/x/stream/status') {
      sendJson(res, getXStreamStatus());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/x/stream/rules/sync') {
      try {
        const rule = await syncXStreamRule(db, dbPath);
        sendJson(res, { rule, status: getXStreamStatus() });
      } catch (err) {
        if (sendXApiError(res, err)) return;
        throw err;
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/x/stream/start') {
      try {
        sendJson(res, await startXBrowserPoller(xBrowserPollOptions(dbPath, state)));
      } catch (err) {
        if (sendXApiError(res, err)) return;
        throw err;
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/x/stream/stop') {
      stopXBrowserPoller();
      sendJson(res, stopXFilteredStream());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/brain/spaces') {
      sendJson(res, { spaces: await listBrainSpaces() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/brain/spaces') {
      const body = JSON.parse(await parseBody(req)) as {
        name?: string;
        description?: string;
        keywords?: string[] | string;
        category?: string | null;
        domain?: string | null;
        collection?: string | null;
        repos?: string[];
      };
      const keywords = Array.isArray(body.keywords)
        ? body.keywords
        : typeof body.keywords === 'string'
          ? body.keywords.split(',')
          : [];
      const space = await createBrainSpace({
        name: body.name || '',
        description: body.description,
        keywords,
        category: body.category,
        domain: body.domain,
        collection: body.collection,
      });
      for (const repo of body.repos ?? []) {
        await addBrainRepo(space.id, { repo, source: 'create' });
      }
      sendJson(res, { space });
      return;
    }

    const brainSpaceMatch = pathname.match(/^\/api\/brain\/spaces\/([^/]+)$/);
    if (brainSpaceMatch && req.method === 'PATCH') {
      const id = decodeURIComponent(brainSpaceMatch[1]);
      const body = JSON.parse(await parseBody(req)) as Record<string, unknown>;
      const keywords = Array.isArray(body.keywords)
        ? body.keywords.filter((v): v is string => typeof v === 'string')
        : typeof body.keywords === 'string'
          ? body.keywords.split(',')
          : undefined;
      const space = await updateBrainSpace(id, {
        name: typeof body.name === 'string' ? body.name : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        keywords,
        category: typeof body.category === 'string' || body.category === null ? body.category : undefined,
        domain: typeof body.domain === 'string' || body.domain === null ? body.domain : undefined,
        collection: typeof body.collection === 'string' || body.collection === null ? body.collection : undefined,
      });
      sendJson(res, { space });
      return;
    }
    if (brainSpaceMatch && req.method === 'DELETE') {
      await deleteBrainSpace(decodeURIComponent(brainSpaceMatch[1]));
      sendJson(res, { success: true });
      return;
    }

    const brainSeedMatch = pathname.match(/^\/api\/brain\/spaces\/([^/]+)\/seed$/);
    if (brainSeedMatch && req.method === 'POST') {
      sendJson(res, await seedBrainSpace(decodeURIComponent(brainSeedMatch[1])));
      return;
    }

    const brainBookmarksMatch = pathname.match(/^\/api\/brain\/spaces\/([^/]+)\/bookmarks$/);
    if (brainBookmarksMatch && req.method === 'GET') {
      sendJson(res, { bookmarks: await listBrainBookmarks(decodeURIComponent(brainBookmarksMatch[1])) });
      return;
    }
    if (brainBookmarksMatch && req.method === 'POST') {
      const body = JSON.parse(await parseBody(req)) as { bookmarkId?: string };
      if (!body.bookmarkId) { sendError(res, 'bookmarkId is required', 400); return; }
      await addBrainBookmark(decodeURIComponent(brainBookmarksMatch[1]), body.bookmarkId);
      sendJson(res, { success: true });
      return;
    }

    const brainBookmarkDeleteMatch = pathname.match(/^\/api\/brain\/spaces\/([^/]+)\/bookmarks\/([^/]+)$/);
    if (brainBookmarkDeleteMatch && req.method === 'DELETE') {
      await removeBrainBookmark(decodeURIComponent(brainBookmarkDeleteMatch[1]), decodeURIComponent(brainBookmarkDeleteMatch[2]));
      sendJson(res, { success: true });
      return;
    }

    const brainReposMatch = pathname.match(/^\/api\/brain\/spaces\/([^/]+)\/repos$/);
    if (brainReposMatch && req.method === 'GET') {
      sendJson(res, { repos: await listBrainRepos(decodeURIComponent(brainReposMatch[1])) });
      return;
    }
    if (brainReposMatch && req.method === 'POST') {
      const body = JSON.parse(await parseBody(req)) as { repo?: string; source?: string };
      if (!body.repo) { sendError(res, 'repo is required', 400); return; }
      const repo = await addBrainRepo(decodeURIComponent(brainReposMatch[1]), { repo: body.repo, source: body.source });
      sendJson(res, { repo });
      return;
    }

    const brainRunMatch = pathname.match(/^\/api\/brain\/spaces\/([^/]+)\/run-agents$/);
    if (brainRunMatch && req.method === 'POST') {
      sendJson(res, await runBrainAgents(decodeURIComponent(brainRunMatch[1])));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/brain/agents/runs') {
      sendJson(res, { runs: await listBrainRuns(Number(url.searchParams.get('limit')) || 20) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/brain/agents/findings') {
      sendJson(res, {
        findings: await listBrainFindings(
          Number(url.searchParams.get('limit')) || 50,
          url.searchParams.get('open') === 'true',
        ),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/brain/workflows') {
      sendJson(res, {
        workflows: await listBrainWorkflows(),
        runs: await listBrainWorkflowRuns(Number(url.searchParams.get('limit')) || 12),
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/brain/workflows/run') {
      const bodyText = await parseBody(req);
      const body = bodyText.trim() ? JSON.parse(bodyText) as { workflow?: string; target?: string } : {};
      if (!body.workflow) { sendError(res, 'workflow is required', 400); return; }
      sendJson(res, await runBrainWorkflow(body.workflow as BrainWorkflowId, body.target || 'all'));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/brain/sync-memory') {
      sendJson(res, await syncBrainMemory());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/brain/notes') {
      const body = JSON.parse(await parseBody(req)) as { title?: string; text?: string; tags?: string[]; spaceId?: string | null };
      if (!body.text) { sendError(res, 'text is required', 400); return; }
      sendJson(res, { artifact: await createBrainNote({ title: body.title, text: body.text, tags: body.tags, spaceId: body.spaceId }) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/brain/run-agents') {
      const bodyText = await parseBody(req);
      let target = 'all';
      try {
        const body = bodyText.trim() ? JSON.parse(bodyText) as { target?: string } : {};
        target = body.target || 'all';
      } catch {}
      sendJson(res, await runBrainAgents(target));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/brain/memory') {
      try {
        const [tiers, memory] = await Promise.all([getMemoryTierStats(), brainMemoryOverview(12)]);
        sendJson(res, { tiers, memory });
      } catch {
        sendJson(res, {
          tiers: { working: 0, episodic: 0, semantic: 0, procedural: 0 },
          memory: await brainMemoryOverview(12).catch(() => ({
            artifactCount: 0,
            entityCount: 0,
            edgeCount: 0,
            claimCount: 0,
            timelineCount: 0,
            recentArtifacts: [],
            topEntities: [],
          })),
        });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/brain/consolidate') {
      try { const logs: string[] = []; const result = await consolidateMemoryTiers(undefined, (msg) => logs.push(msg)); const tiers = await getMemoryTierStats(); sendJson(res, { result, tiers, logs }); } catch (err) { sendError(res, (err as Error).message); }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/brain/graph') {
      try { const stats = await getGraphStats(); sendJson(res, stats); } catch { sendJson(res, { totalNodes: 0, totalEdges: 0, contradictions: 0, clusters: 0, topConnected: [] }); }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/brain/graph/mermaid') {
      try { const mermaid = await exportGraphAsMermaid(); sendJson(res, { mermaid }); } catch { sendJson(res, { mermaid: 'graph LR\n  empty["No graph data yet"]' }); }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/brain/graph/data') {
      try {
        const graph = await loadGraph();
        sendJson(res, { nodes: graph.nodes, edges: graph.edges });
      } catch {
        sendJson(res, { nodes: [], edges: [] });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/brain/health') {
      try { const logs: string[] = []; const report = await runMaintenanceAgent((msg) => logs.push(msg), { useLlm: false }); sendJson(res, { report, logs }); } catch (err) { sendError(res, (err as Error).message); }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/pages') {
      const root = mdDir();
      if (!fs.existsSync(root)) { sendJson(res, { pages: [] }); return; }

      const pages: { path: string; type: string; title: string; size: number; updatedAt: string }[] = [];
      const stack: { abs: string; rel: string }[] = [{ abs: root, rel: '' }];
      while (stack.length) {
        const { abs, rel } = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          const childAbs = path.join(abs, entry.name);
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            stack.push({ abs: childAbs, rel: childRel });
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            try {
              const st = fs.statSync(childAbs);
              const type = rel.split('/')[0] || 'root';
              const title = entry.name.replace(/\.md$/, '').replace(/-/g, ' ');
              pages.push({ path: childRel, type, title, size: st.size, updatedAt: st.mtime.toISOString() });
            } catch { /* skip */ }
          }
        }
      }
      pages.sort((a, b) => a.path.localeCompare(b.path));
      sendJson(res, { pages });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/pages/')) {
      const raw = decodeURIComponent(pathname.slice('/api/pages/'.length));
      // Reject traversal
      if (!raw || raw.includes('\0') || raw.split('/').some((seg) => seg === '..' || seg === '.')) {
        sendError(res, 'Invalid path', 400);
        return;
      }
      const root = mdDir();
      const abs = path.resolve(root, raw.endsWith('.md') ? raw : raw + '.md');
      const normRoot = path.resolve(root) + path.sep;
      if (!abs.startsWith(normRoot) && abs !== path.resolve(root)) {
        sendError(res, 'Invalid path', 400);
        return;
      }
      if (!fs.existsSync(abs)) { sendJson(res, { path: raw, content: '', exists: false }); return; }
      try {
        const content = fs.readFileSync(abs, 'utf-8');
        sendJson(res, { path: raw, content, exists: true });
      } catch (err) {
        sendError(res, (err as Error).message);
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ask') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      try {
        const body = JSON.parse(await parseBody(req)) as { question?: string; save?: boolean };
        const question = (body.question || '').trim();
        if (!question) { send('error', { message: 'Question is required' }); res.end(); return; }

        send('status', { message: 'Thinking…' });
        const result = await askMd(question, {
          save: Boolean(body.save),
          nonInteractive: true,
          onProgress: (msg) => send('status', { message: msg }),
        });
        send('done', result);
      } catch (err) {
        send('error', { message: (err as Error).message });
      } finally {
        res.end();
      }
      return;
    }

    sendError(res, 'Not found', 404);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('fts5') || msg.includes('MATCH')) { sendError(res, 'Invalid search query.', 400); } else { console.error('API error:', err); sendError(res, msg, 500); }
  }
}

// ── Browser ─────────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  if (process.env.XTREME_BOOKMARKS_NO_OPEN === '1') return;
  const platform = os.platform();
  const cmd = platform === 'win32' ? `start "" "${url}"` : platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// ── Server ──────────────────────────────────────────────────────────────────

async function autoGrab(state: { db: Database }, dbPath: string): Promise<void> {
  const ts = new Date().toLocaleTimeString();
  try {
    const syncResult = await syncBookmarksGraphQL({ incremental: true, maxPages: 50, delayMs: 600, maxMinutes: 5 });
    if (syncResult.added > 0) {
      await buildIndex(); state.db.close(); state.db = await openDb(dbPath);
    }
  } catch (err) { console.error(`  [${ts}] Auto-grab failed:`, (err as Error).message); }
}

async function autoUpdateXWatchlist(state: { db: Database }, dbPath: string): Promise<void> {
  if (listXWatchAccounts(state.db).length === 0) return;
  await startXBrowserPoller(xBrowserPollOptions(dbPath, state));
}

export async function startWebServer(port: number = 3848): Promise<void> {
  loadEnv();
  const auth = getWebAuthConfig();
  const dbPath = twitterBookmarksIndexPath();
  if (!fs.existsSync(dbPath)) { console.error('  Database not found. Run: ft sync && ft index'); process.exitCode = 1; return; }
  const state = { db: await openDb(dbPath) };
  ensureMigrations(state.db);
  initBrainSchema(state.db);
  initXStreamSchema(state.db);

  // Tables
  state.db.run(`CREATE TABLE IF NOT EXISTS bookmark_notes (bookmark_id TEXT PRIMARY KEY, note TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  state.db.run(`CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, color TEXT, created_at TEXT NOT NULL, keywords TEXT)`);
  state.db.run(`CREATE TABLE IF NOT EXISTS bookmark_collections (bookmark_id TEXT NOT NULL, collection_name TEXT NOT NULL REFERENCES collections(name) ON DELETE CASCADE, added_at TEXT NOT NULL, PRIMARY KEY (bookmark_id, collection_name))`);
  state.db.run(`CREATE TABLE IF NOT EXISTS bookmark_read_status (bookmark_id TEXT PRIMARY KEY, is_read INTEGER NOT NULL DEFAULT 0, read_at TEXT)`);
  state.db.run(`CREATE TABLE IF NOT EXISTS saved_searches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, query TEXT NOT NULL, created_at TEXT NOT NULL)`);
  state.db.run(`CREATE TABLE IF NOT EXISTS bookmark_highlights (id INTEGER PRIMARY KEY AUTOINCREMENT, bookmark_id TEXT NOT NULL, text_fragment TEXT NOT NULL, color TEXT NOT NULL DEFAULT 'yellow', created_at TEXT NOT NULL)`);
  state.db.run(`CREATE TABLE IF NOT EXISTS dead_links (bookmark_id TEXT PRIMARY KEY, status INTEGER, checked_at TEXT NOT NULL)`);
  state.db.run(`CREATE TABLE IF NOT EXISTS x_webhook_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, signature TEXT, received_at TEXT NOT NULL)`);
  saveDb(state.db, dbPath);

  autoUpdateXWatchlist(state, dbPath).catch((err) => {
    console.error('  X Feed auto-update failed:', (err as Error).message);
  });

  const webDir = resolveWebDir();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;
    
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/api/healthz')) {
      sendJson(res, { ok: true, app: 'xtreme-bookmarks' });
      return;
    }

    if (req.method === 'GET' && (pathname === '/auth/callback' || pathname === '/callback')) {
      try {
        await handleOAuthCallback(url, res);
      } catch (err) {
        console.error('OAuth callback error:', err);
        sendError(res, 'OAuth callback failed', 500);
      }
      return;
    }

    if (!isRequestAuthorized(req, auth)) {
      requestWebAuth(res);
      return;
    }

    try {
      if (pathname.startsWith('/api/')) { await handleApi(state.db, dbPath, req, res, url, pathname, state); return; }

      // Static
      const filePath = pathname === '/' ? path.join(webDir, 'index.html') : path.join(webDir, pathname);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const headers: Record<string, string> = { 'Content-Type': getMimeType(ext) };
        if (['.html', '.js', '.css'].includes(ext)) headers['Cache-Control'] = 'no-store';
        res.writeHead(200, headers);
        res.end(fs.readFileSync(filePath));
      } else {
        const indexPath = path.join(webDir, 'index.html');
        console.log(`[Static] Not found: ${filePath}. Trying fallback: ${indexPath}`);
        if (fs.existsSync(indexPath)) {
          console.log(`[Static] Serving fallback index.html`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(fs.readFileSync(indexPath));
        } else {
          console.error(`[Static] CRITICAL: index.html not found! WebDir resolved to: ${webDir}`);
          sendError(res, 'Not found', 404);
        }
      }
    } catch (err) { console.error('Request error:', err); sendError(res, 'Internal server error', 500); }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  Xtreme Bookmarks 2nd Brain Web UI running at ${url}`);
    if (auth.enabled) console.log(`  Web access is password protected for user "${auth.username}".`);
    openBrowser(url);
  });

  const grabInterval = setInterval(() => { autoGrab(state, dbPath); }, 30 * 60 * 1000);
  const xFeedInterval: ReturnType<typeof setInterval> | null = null;
  const brainInterval = setInterval(() => {
    runDueBrainAgents().catch((err) => console.error('  Brain agent watch failed:', (err as Error).message));
  }, 60 * 60 * 1000);
  process.on('SIGINT', () => { clearInterval(grabInterval); if (xFeedInterval) clearInterval(xFeedInterval); clearInterval(brainInterval); stopXBrowserPoller(); state.db.close(); server.close(); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(grabInterval); if (xFeedInterval) clearInterval(xFeedInterval); clearInterval(brainInterval); state.db.close(); server.close(); process.exit(0); });
  return new Promise(() => {});
}
