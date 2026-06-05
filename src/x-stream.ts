import type { Database } from 'sql.js';
import { openDb, saveDb } from './db.js';
import { buildXGraphQLHeaders, loadXGraphQLSession } from './graphql-bookmarks.js';
import { readJsonLines, writeJsonLines } from './fs.js';
import { twitterBookmarksCachePath } from './paths.js';
import type { BookmarkRecord } from './types.js';

const X_API_BASE = 'https://api.x.com';
const STREAM_RULE_TAG = 'xtreme-bookmarks-watchlist';
const TWEET_FIELDS = 'created_at,author_id,conversation_id,in_reply_to_user_id,referenced_tweets,public_metrics,attachments';
const EXPANSIONS = 'author_id,referenced_tweets.id,attachments.media_keys';
const USER_FIELDS = 'username,name,profile_image_url,verified';
const MEDIA_FIELDS = 'media_key,type,url,preview_image_url,width,height,alt_text,public_metrics,variants';
const X_WEB_BASE = 'https://x.com';
const WEB_USER_BY_SCREEN_NAME_QUERY_ID = 'IGgvgiOx4QZndDHuD3x9TQ';
const WEB_USER_TWEETS_QUERY_ID = '3AS73VJOTCg8ePuvJndFew';
const WEB_USER_TWEETS_AND_REPLIES_QUERY_ID = 'Yhdsu6wWbof5lwXjYqxXEg';
const WEB_POLL_INTERVAL_MS = 15 * 60 * 1000;
const WEB_POLL_ACCOUNT_DELAY_MS = 2500;
const WEB_MANUAL_POLL_ACCOUNT_DELAY_MS = 2500;
const WEB_RATE_LIMIT_RETRY_MS = 10 * 60 * 1000;
const WEB_MANUAL_RATE_LIMIT_RETRY_MS = 10 * 60 * 1000;
const X_WEB_REQUEST_TIMEOUT_MS = 25_000;

type XPollQueueState = 'idle' | 'waiting' | 'checking' | 'checked' | 'delayed' | 'failed';

export interface XWatchAccount {
  id: number;
  handle: string;
  userId: string;
  username: string;
  name: string;
  profileImageUrl: string | null;
  verified: boolean;
  includeReplies: boolean;
  createdAt: string;
  updatedAt: string;
  lastBackfilledAt: string | null;
}

export interface XStreamItem {
  tweetId: string;
  authorId: string;
  username: string;
  text: string;
  createdAt: string;
  itemType: 'post' | 'reply';
  conversationId: string | null;
  sourceAccount: string;
  rawJson: unknown;
  receivedAt: string;
}

export interface XStreamStatus {
  running: boolean;
  connecting: boolean;
  pollerRunning: boolean;
  pollerInFlight: boolean;
  hasBearerToken: boolean;
  hasBrowserSession: boolean;
  sourceMode: 'browser' | 'api';
  activeRule: string | null;
  activeRuleId: string | null;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  lastPollAt: string | null;
  nextPollAt: string | null;
  lastPollSaved: number;
  lastPollChecked: number;
  lastPollFailed: number;
  pollRunId: string | null;
  pollRunStartedAt: string | null;
  pollRunCompletedAt: string | null;
  pollTotal: number;
  pollChecked: number;
  pollWaiting: number;
  pollDelayed: number;
  pollFailed: number;
  pollSaved: number;
  pollCurrentHandle: string | null;
  pollCooldownUntil: string | null;
  pollDelayedAccounts: Array<{ handle: string; retryAfter: string | null; error: string | null }>;
  pollFailedAccounts: Array<{ handle: string; error: string | null }>;
  lastPollWarning: string | null;
  lastPollFailures: Array<{ handle: string; error: string }>;
  lastError: string | null;
  lastPollError: string | null;
  nextRetryAt: string | null;
  reconnects: number;
}

interface XUser {
  id?: string;
  username?: string;
  name?: string;
  profile_image_url?: string;
  verified?: boolean;
}

interface XTweet {
  id?: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{ type?: string; id?: string }>;
  attachments?: {
    media_keys?: string[];
  };
  public_metrics?: {
    reply_count?: number;
    retweet_count?: number;
    like_count?: number;
    quote_count?: number;
    impression_count?: number;
  };
}

interface XApiPayload {
  data?: XTweet | XTweet[] | XUser | Array<XUser>;
  includes?: {
    users?: XUser[];
    tweets?: XTweet[];
    media?: Array<Record<string, unknown>>;
  };
  meta?: Record<string, unknown>;
}

interface Runtime {
  running: boolean;
  connecting: boolean;
  stopRequested: boolean;
  abort?: AbortController;
  activeRule: string | null;
  activeRuleId: string | null;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  reconnects: number;
}

export class XApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'XApiError';
  }
}

const runtime: Runtime = {
  running: false,
  connecting: false,
  stopRequested: false,
  activeRule: null,
  activeRuleId: null,
  lastConnectedAt: null,
  lastEventAt: null,
  lastError: null,
  nextRetryAt: null,
  reconnects: 0,
};

type XBrowserPollOptions = {
  getDb: () => Database | Promise<Database>;
  dbPath: string;
  waitForCurrent?: boolean;
  forceNew?: boolean;
  accountDelayMs?: number;
  rateLimitRetryMs?: number;
  releaseDb?: (db: Database) => void | Promise<void>;
  afterPoll?: (result: { accounts: number; checked: number; saved: number; source: 'browser'; errors: Array<{ handle: string; error: string }> }) => void | Promise<void>;
};

interface XPollQueueSummary {
  runId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  total: number;
  checked: number;
  waiting: number;
  delayed: number;
  failed: number;
  saved: number;
  currentHandle: string | null;
  cooldownUntil: string | null;
  delayedAccounts: Array<{ handle: string; retryAfter: string | null; error: string | null }>;
  failedAccounts: Array<{ handle: string; error: string | null }>;
}

const pollRuntime: {
  running: boolean;
  inFlight: boolean;
  timer?: ReturnType<typeof setInterval>;
  lastPollAt: string | null;
  nextPollAt: string | null;
  lastSaved: number;
  lastChecked: number;
  lastFailed: number;
  lastWarning: string | null;
  lastFailures: Array<{ handle: string; error: string }>;
  lastError: string | null;
  nextAccountIndex: number;
  runId: string | null;
  runStartedAt: string | null;
  runCompletedAt: string | null;
  total: number;
  waiting: number;
  delayed: number;
  currentHandle: string | null;
  cooldownUntil: string | null;
  delayedAccounts: Array<{ handle: string; retryAfter: string | null; error: string | null }>;
  failedAccounts: Array<{ handle: string; error: string | null }>;
} = {
  running: false,
  inFlight: false,
  lastPollAt: null,
  nextPollAt: null,
  lastSaved: 0,
  lastChecked: 0,
  lastFailed: 0,
  lastWarning: null,
  lastFailures: [],
  lastError: null,
  nextAccountIndex: 0,
  runId: null,
  runStartedAt: null,
  runCompletedAt: null,
  total: 0,
  waiting: 0,
  delayed: 0,
  currentHandle: null,
  cooldownUntil: null,
  delayedAccounts: [],
  failedAccounts: [],
};

const X_WEB_TIMELINE_FEATURES = {
  rweb_video_screen_enabled: false,
  rweb_cashtags_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

const X_WEB_TIMELINE_FIELD_TOGGLES = {
  withArticleRichContentState: true,
  withArticlePlainText: false,
  withGrokAnalyze: false,
  withDisallowedReplyControls: false,
};

const X_WEB_PROFILE_FIELD_TOGGLES = {
  withAuxiliaryUserLabels: true,
};

function nowIso(): string {
  return new Date().toISOString();
}

function getBearerToken(): string {
  const token = process.env.X_BEARER_TOKEN?.trim();
  if (!token) throw new Error('X_BEARER_TOKEN is not set.');
  return token;
}

export function normalizeXHandle(input: string): string {
  const handle = input.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/i.test(handle)) {
    throw new Error('Enter a valid X handle, like @karpathy.');
  }
  return handle;
}

export function buildXWatchRule(
  accounts: Array<string | Pick<XWatchAccount, 'handle' | 'includeReplies'>>,
): string {
  const normalized = new Map<string, boolean>();
  for (const account of accounts) {
    const handle = typeof account === 'string' ? normalizeXHandle(account) : normalizeXHandle(account.handle);
    const includeReplies = typeof account === 'string' ? true : account.includeReplies !== false;
    normalized.set(handle, includeReplies);
  }
  const parts = [...normalized.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([handle, includeReplies]) => includeReplies ? `from:${handle}` : `(from:${handle} -is:reply)`);
  if (!parts.length) return '';
  const rule = `(${parts.join(' OR ')})`;
  if (rule.length > 1024) {
    throw new Error('The X Filtered Stream rule is too long. Remove a few accounts or split this feature into multiple rules.');
  }
  return rule;
}

export function initXStreamSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS x_watch_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    handle TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    profile_image_url TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    include_replies INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_backfilled_at TEXT
  )`);
  try { db.run(`ALTER TABLE x_watch_accounts ADD COLUMN include_replies INTEGER NOT NULL DEFAULT 1`); } catch {}
  db.run(`CREATE TABLE IF NOT EXISTS x_stream_items (
    tweet_id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    item_type TEXT NOT NULL,
    conversation_id TEXT,
    source_account TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    received_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS x_stream_removed_items (
    tweet_id TEXT PRIMARY KEY,
    removed_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS x_watch_poll_state (
    handle TEXT PRIMARY KEY,
    run_id TEXT,
    state TEXT NOT NULL DEFAULT 'idle',
    last_checked_at TEXT,
    last_success_at TEXT,
    last_error TEXT,
    retry_after TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_saved INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS x_stream_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_x_stream_items_created ON x_stream_items(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_x_stream_items_author ON x_stream_items(author_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_x_watch_poll_state_state ON x_watch_poll_state(state, retry_after)`);
}

function setState(db: Database, key: string, value: string): void {
  db.run(
    `INSERT OR REPLACE INTO x_stream_state (key, value, updated_at) VALUES (?, ?, ?)`,
    [key, value, nowIso()],
  );
}

function getState(db: Database, key: string): string | null {
  initXStreamSchema(db);
  const rows = db.exec(`SELECT value FROM x_stream_state WHERE key = ?`, [key]);
  const value = rows[0]?.values?.[0]?.[0];
  return value === undefined || value === null ? null : String(value);
}

export async function mergeXStreamRemovedItemsFromDisk(db: Database, dbPath: string): Promise<number> {
  initXStreamSchema(db);
  if (dbPath === ':memory:') return 0;
  let diskDb: Database | null = null;
  let merged = 0;
  try {
    diskDb = await openDb(dbPath);
    const rows = diskDb.exec(`SELECT tweet_id, removed_at FROM x_stream_removed_items`)[0]?.values ?? [];
    for (const row of rows) {
      const tweetId = String(row[0] ?? '');
      if (!tweetId) continue;
      const removedAt = row[1] ? String(row[1]) : nowIso();
      db.run(
        `INSERT OR REPLACE INTO x_stream_removed_items (tweet_id, removed_at) VALUES (?, ?)`,
        [tweetId, removedAt],
      );
      merged += 1;
    }
  } catch {
    // Older database snapshots may not have the tombstone table yet.
  } finally {
    diskDb?.close();
  }
  db.run(`DELETE FROM x_stream_items WHERE tweet_id IN (SELECT tweet_id FROM x_stream_removed_items)`);
  return merged;
}

async function saveDbPreservingXRemovals(db: Database, dbPath: string): Promise<void> {
  await mergeXStreamRemovedItemsFromDisk(db, dbPath);
  saveDb(db, dbPath);
}

function tombstoneXStreamItem(db: Database, tweetId: string): boolean {
  db.run(
    `INSERT OR REPLACE INTO x_stream_removed_items (tweet_id, removed_at) VALUES (?, ?)`,
    [tweetId, nowIso()],
  );
  db.run(`DELETE FROM x_stream_items WHERE tweet_id = ?`, [tweetId]);
  return db.getRowsModified() > 0;
}

function rowToWatchAccount(row: unknown[]): XWatchAccount {
  return {
    id: Number(row[0]),
    handle: String(row[1] ?? ''),
    userId: String(row[2] ?? ''),
    username: String(row[3] ?? ''),
    name: String(row[4] ?? ''),
    profileImageUrl: row[5] ? String(row[5]) : null,
    verified: Number(row[6] ?? 0) === 1,
    includeReplies: Number(row[7] ?? 1) === 1,
    createdAt: String(row[8] ?? ''),
    updatedAt: String(row[9] ?? ''),
    lastBackfilledAt: row[10] ? String(row[10]) : null,
  };
}

export function listXWatchAccounts(db: Database): XWatchAccount[] {
  initXStreamSchema(db);
  const rows = db.exec(`
    SELECT id, handle, user_id, username, name, profile_image_url, verified, include_replies, created_at, updated_at, last_backfilled_at
    FROM x_watch_accounts
    ORDER BY handle
  `);
  return (rows[0]?.values ?? []).map(rowToWatchAccount);
}

function activePollStateCount(db: Database): number {
  initXStreamSchema(db);
  return Number(db.exec(`
    SELECT COUNT(*) FROM x_watch_poll_state
    WHERE state IN ('waiting', 'checking', 'delayed')
  `)[0]?.values?.[0]?.[0] ?? 0);
}

function pollRunId(): string {
  return `xpoll-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function syncPollQueueAccounts(db: Database, accounts = listXWatchAccounts(db)): void {
  initXStreamSchema(db);
  const handles = new Set(accounts.map((account) => account.handle));
  const rows = db.exec(`SELECT handle FROM x_watch_poll_state`)[0]?.values ?? [];
  for (const row of rows) {
    const handle = String(row[0] ?? '');
    if (!handles.has(handle)) db.run(`DELETE FROM x_watch_poll_state WHERE handle = ?`, [handle]);
  }
}

export function startXWatchPollQueue(db: Database, runId = pollRunId(), startedAt = nowIso()): XPollQueueSummary {
  initXStreamSchema(db);
  const accounts = listXWatchAccounts(db);
  syncPollQueueAccounts(db, accounts);
  for (const account of accounts) {
    db.run(
      `INSERT OR REPLACE INTO x_watch_poll_state (
        handle, run_id, state, last_checked_at, last_success_at, last_error, retry_after,
        consecutive_failures, last_saved, updated_at
      ) VALUES (
        ?, ?, 'waiting',
        (SELECT last_checked_at FROM x_watch_poll_state WHERE handle = ?),
        (SELECT last_success_at FROM x_watch_poll_state WHERE handle = ?),
        NULL, NULL, 0, 0, ?
      )`,
      [account.handle, runId, account.handle, account.handle, startedAt],
    );
  }
  setState(db, 'x_poll_run_id', runId);
  setState(db, 'x_poll_run_started_at', startedAt);
  setState(db, 'x_poll_run_completed_at', '');
  return getXPollQueueSummary(db);
}

export function getXPollQueueSummary(db: Database): XPollQueueSummary {
  initXStreamSchema(db);
  syncPollQueueAccounts(db);
  const rows = db.exec(`
    SELECT handle, run_id, state, last_error, retry_after, last_saved, updated_at
    FROM x_watch_poll_state
    ORDER BY handle
  `)[0]?.values ?? [];
  const total = listXWatchAccounts(db).length;
  let checked = 0;
  let waiting = 0;
  let delayed = 0;
  let failed = 0;
  let saved = 0;
  let currentHandle: string | null = null;
  let cooldownUntil: string | null = null;
  const delayedAccounts: XPollQueueSummary['delayedAccounts'] = [];
  const failedAccounts: XPollQueueSummary['failedAccounts'] = [];
  for (const row of rows) {
    const handle = String(row[0] ?? '');
    const state = String(row[2] ?? 'idle') as XPollQueueState;
    const error = row[3] ? String(row[3]) : null;
    const retryAfter = row[4] ? String(row[4]) : null;
    saved += Number(row[5] ?? 0);
    if (state === 'checked') checked += 1;
    else if (state === 'waiting' || state === 'checking') {
      waiting += 1;
      if (state === 'checking') currentHandle = handle;
    } else if (state === 'delayed') {
      delayed += 1;
      delayedAccounts.push({ handle, retryAfter, error });
      if (retryAfter && (!cooldownUntil || Date.parse(retryAfter) < Date.parse(cooldownUntil))) {
        cooldownUntil = retryAfter;
      }
    } else if (state === 'failed') {
      failed += 1;
      failedAccounts.push({ handle, error });
    }
  }
  return {
    runId: getState(db, 'x_poll_run_id'),
    startedAt: getState(db, 'x_poll_run_started_at'),
    completedAt: getState(db, 'x_poll_run_completed_at'),
    total,
    checked,
    waiting,
    delayed,
    failed,
    saved,
    currentHandle,
    cooldownUntil,
    delayedAccounts,
    failedAccounts,
  };
}

function setPollAccountState(
  db: Database,
  handle: string,
  state: XPollQueueState,
  fields: {
    runId?: string | null;
    lastCheckedAt?: string | null;
    lastSuccessAt?: string | null;
    lastError?: string | null;
    retryAfter?: string | null;
    consecutiveFailures?: number;
    lastSaved?: number;
  } = {},
): void {
  const existing = db.exec(
    `SELECT run_id, last_checked_at, last_success_at, last_error, retry_after, consecutive_failures, last_saved
     FROM x_watch_poll_state WHERE handle = ?`,
    [handle],
  )[0]?.values?.[0];
  const ts = nowIso();
  db.run(
    `INSERT OR REPLACE INTO x_watch_poll_state (
      handle, run_id, state, last_checked_at, last_success_at, last_error, retry_after,
      consecutive_failures, last_saved, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      handle,
      fields.runId ?? (existing?.[0] ? String(existing[0]) : getState(db, 'x_poll_run_id')),
      state,
      fields.lastCheckedAt ?? (existing?.[1] ? String(existing[1]) : null),
      fields.lastSuccessAt ?? (existing?.[2] ? String(existing[2]) : null),
      fields.lastError ?? null,
      fields.retryAfter ?? null,
      fields.consecutiveFailures ?? Number(existing?.[5] ?? 0),
      fields.lastSaved ?? Number(existing?.[6] ?? 0),
      ts,
    ],
  );
}

function nextQueuedPollAccount(db: Database): XWatchAccount | null {
  initXStreamSchema(db);
  const now = nowIso();
  db.run(`UPDATE x_watch_poll_state SET state = 'waiting', retry_after = NULL, updated_at = ? WHERE state = 'delayed' AND retry_after <= ?`, [now, now]);
  const rows = db.exec(`
    SELECT a.id, a.handle, a.user_id, a.username, a.name, a.profile_image_url, a.verified, a.include_replies, a.created_at, a.updated_at, a.last_backfilled_at
    FROM x_watch_accounts a
    JOIN x_watch_poll_state s ON s.handle = a.handle
    WHERE s.state = 'waiting'
    ORDER BY a.handle
    LIMIT 1
  `);
  const row = rows[0]?.values?.[0];
  return row ? rowToWatchAccount(row) : null;
}

function hardPollFailuresFromSummary(summary: XPollQueueSummary): Array<{ handle: string; error: string }> {
  return summary.failedAccounts.map((item) => ({
    handle: item.handle,
    error: item.error || 'Could not check this account.',
  }));
}

function applyQueueSummaryToRuntime(summary: XPollQueueSummary): void {
  pollRuntime.runId = summary.runId;
  pollRuntime.runStartedAt = summary.startedAt;
  pollRuntime.runCompletedAt = summary.completedAt;
  pollRuntime.total = summary.total;
  pollRuntime.lastChecked = summary.checked;
  pollRuntime.waiting = summary.waiting;
  pollRuntime.delayed = summary.delayed;
  pollRuntime.lastFailed = summary.failed;
  pollRuntime.lastSaved = summary.saved;
  pollRuntime.currentHandle = summary.currentHandle;
  pollRuntime.cooldownUntil = summary.cooldownUntil;
  pollRuntime.delayedAccounts = summary.delayedAccounts;
  pollRuntime.failedAccounts = summary.failedAccounts;
  pollRuntime.lastFailures = hardPollFailuresFromSummary(summary);
  pollRuntime.lastWarning = browserPollWarning({
    checked: summary.checked,
    errors: pollRuntime.lastFailures,
  });
}

function getWatchByUserId(db: Database): Map<string, XWatchAccount> {
  return new Map(listXWatchAccounts(db).map((account) => [account.userId, account]));
}

function getUserById(includes: XApiPayload['includes'] | undefined): Map<string, XUser> {
  return new Map((includes?.users ?? []).filter((user) => user.id).map((user) => [String(user.id), user]));
}

async function xFetchJson(pathname: string, params?: Record<string, string>, init: RequestInit = {}): Promise<XApiPayload> {
  const url = new URL(pathname, X_API_BASE);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${getBearerToken()}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: XApiPayload & { title?: string; detail?: string; errors?: Array<{ title?: string; detail?: string }> } = {};
  try { json = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) {
    const message = json.title || json.detail || json.errors?.[0]?.detail || json.errors?.[0]?.title || text || res.statusText;
    throw new XApiError(res.status, `X API ${res.status}: ${message}`);
  }
  return json;
}

async function xWebGraphQL(
  queryId: string,
  operation: string,
  variables: Record<string, unknown>,
  options: { fieldToggles?: Record<string, unknown> } = {},
): Promise<any> {
  const session = await loadXGraphQLSession();
  const url = new URL(`/i/api/graphql/${queryId}/${operation}`, X_WEB_BASE);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), X_WEB_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        ...buildXGraphQLHeaders(session.csrfToken, session.cookieHeader),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        variables,
        features: X_WEB_TIMELINE_FEATURES,
        fieldToggles: options.fieldToggles ?? {},
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`X browser session timed out after ${Math.round(X_WEB_REQUEST_TIMEOUT_MS / 1000)}s.`);
    }
    const cause = (err as Error & { cause?: { message?: string } }).cause?.message;
    if (cause && (err as Error).message === 'fetch failed') {
      throw new Error(`X browser fetch failed: ${cause}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) {
    throw new Error(
      `X browser session ${res.status}: ${text.slice(0, 240) || res.statusText}. Open x.com in your browser if your session expired.`,
    );
  }
  if (Array.isArray(json.errors) && json.errors.length) {
    const message = json.errors.map((err: any) => err.message || err.code || 'unknown').join('; ');
    throw new Error(`X browser session error: ${message}`);
  }
  return json;
}

function unwrapXWebUser(result: any): Required<Pick<XUser, 'id' | 'username'>> & XUser {
  const user = result?.data?.user?.result;
  const id = user?.rest_id;
  const username = user?.core?.screen_name ?? user?.legacy?.screen_name;
  if (!id || !username) throw new Error('X account not found in browser session response.');
  return {
    id: String(id),
    username: String(username),
    name: String(user?.core?.name ?? user?.legacy?.name ?? username),
    profile_image_url: user?.avatar?.image_url ?? user?.legacy?.profile_image_url_https ?? user?.legacy?.profile_image_url,
    verified: Boolean(user?.is_blue_verified ?? user?.legacy?.verified),
  };
}

async function resolveXUserViaBrowser(handle: string): Promise<Required<Pick<XUser, 'id' | 'username'>> & XUser> {
  const username = normalizeXHandle(handle);
  const json = await xWebGraphQL(
    WEB_USER_BY_SCREEN_NAME_QUERY_ID,
    'UserByScreenName',
    { screen_name: username, withSafetyModeUserFields: true },
    { fieldToggles: X_WEB_PROFILE_FIELD_TOGGLES },
  );
  return unwrapXWebUser(json);
}

async function resolveXUser(handle: string): Promise<Required<Pick<XUser, 'id' | 'username'>> & XUser> {
  const username = normalizeXHandle(handle);
  if (!process.env.X_BEARER_TOKEN?.trim()) return resolveXUserViaBrowser(username);
  const payload = await xFetchJson(`/2/users/by/username/${encodeURIComponent(username)}`, { 'user.fields': USER_FIELDS });
  const user = payload.data as XUser | undefined;
  if (!user?.id || !user.username) throw new Error(`X account not found: @${username}`);
  return user as Required<Pick<XUser, 'id' | 'username'>> & XUser;
}

export async function addXWatchAccount(db: Database, dbPath: string, handle: string): Promise<XWatchAccount> {
  initXStreamSchema(db);
  let user: Required<Pick<XUser, 'id' | 'username'>> & XUser;
  try {
    user = await resolveXUser(handle);
  } catch (err) {
    if (err instanceof XApiError || /X_BEARER_TOKEN|Unauthorized|Forbidden|401|403/i.test((err as Error).message)) {
      user = await resolveXUserViaBrowser(handle);
    } else {
      throw err;
    }
  }
  const normalized = normalizeXHandle(user.username);
  const ts = nowIso();
  db.run(
    `INSERT INTO x_watch_accounts (handle, user_id, username, name, profile_image_url, verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(handle) DO UPDATE SET
       user_id = excluded.user_id,
       username = excluded.username,
       name = excluded.name,
       profile_image_url = excluded.profile_image_url,
       verified = excluded.verified,
       updated_at = excluded.updated_at`,
    [normalized, user.id, normalized, user.name ?? '', user.profile_image_url ?? null, user.verified ? 1 : 0, ts, ts],
  );
  await saveDbPreservingXRemovals(db, dbPath);
  const account = listXWatchAccounts(db).find((item) => item.handle === normalized);
  if (!account) throw new Error(`Could not save @${normalized}.`);
  return account;
}

export function removeXWatchAccount(db: Database, dbPath: string, handle: string): void {
  initXStreamSchema(db);
  db.run(`DELETE FROM x_watch_accounts WHERE handle = ?`, [normalizeXHandle(handle)]);
  saveDb(db, dbPath);
}

export function updateXWatchAccount(
  db: Database,
  dbPath: string,
  handle: string,
  input: { includeReplies?: boolean },
): XWatchAccount {
  initXStreamSchema(db);
  const normalized = normalizeXHandle(handle);
  if (typeof input.includeReplies === 'boolean') {
    db.run(
      `UPDATE x_watch_accounts SET include_replies = ?, updated_at = ? WHERE handle = ?`,
      [input.includeReplies ? 1 : 0, nowIso(), normalized],
    );
  }
  saveDb(db, dbPath);
  const account = listXWatchAccounts(db).find((item) => item.handle === normalized);
  if (!account) throw new Error(`Watch account not found: @${normalized}`);
  return account;
}

export function saveXStreamTweet(
  db: Database,
  tweet: XTweet,
  includes: XApiPayload['includes'] | undefined,
  rawJson: unknown,
): boolean {
  initXStreamSchema(db);
  if (!tweet.id || !tweet.author_id) return false;
  const removed = db.exec(`SELECT tweet_id FROM x_stream_removed_items WHERE tweet_id = ? LIMIT 1`, [tweet.id]);
  if (removed[0]?.values?.length) return false;
  const watch = getWatchByUserId(db).get(tweet.author_id);
  if (!watch) return false;
  const users = getUserById(includes);
  const user = users.get(tweet.author_id);
  const username = normalizeXHandle(user?.username || watch?.handle || tweet.author_id);
  const itemType: 'post' | 'reply' = tweet.in_reply_to_user_id || tweet.referenced_tweets?.some((ref) => ref.type === 'replied_to')
    ? 'reply'
    : 'post';
  const receivedAt = nowIso();
  const compactRawJson = compactXStreamRawJson(tweet, includes, rawJson);
  db.run(
    `INSERT OR IGNORE INTO x_stream_items
     (tweet_id, author_id, username, text, created_at, item_type, conversation_id, source_account, raw_json, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tweet.id,
      tweet.author_id,
      username,
      tweet.text ?? '',
      tweet.created_at ?? receivedAt,
      itemType,
      tweet.conversation_id ?? null,
      watch?.handle ?? username,
      JSON.stringify(compactRawJson),
      receivedAt,
    ],
  );
  runtime.lastEventAt = receivedAt;
  const inserted = db.getRowsModified() > 0;
  if (!inserted && hasPayloadMedia(compactRawJson)) {
    db.run(
      `UPDATE x_stream_items
       SET raw_json = ?, text = ?, received_at = ?
       WHERE tweet_id = ?`,
      [JSON.stringify(compactRawJson), tweet.text ?? '', receivedAt, tweet.id],
    );
  }
  return inserted;
}

export function compactXStreamRawJson(
  tweet: XTweet,
  includes: XApiPayload['includes'] | undefined,
  rawJson: unknown,
): unknown {
  const raw = rawJson && typeof rawJson === 'object' ? rawJson as any : {};
  const rawData = raw.data;
  const payloadTweets = Array.isArray(rawData) ? rawData : rawData ? [rawData] : [];
  const tweetById = new Map<string, any>();
  for (const candidate of payloadTweets) {
    if (candidate?.id) tweetById.set(String(candidate.id), candidate);
  }

  const kept = new Map<string, any>();
  const addTweet = (candidate: any) => {
    if (candidate?.id) kept.set(String(candidate.id), candidate);
  };
  const primary = tweetById.get(String(tweet.id)) || tweet;
  addTweet(primary);
  for (const ref of primary?.referenced_tweets || tweet.referenced_tweets || []) {
    const refTweet = tweetById.get(String(ref?.id));
    if (refTweet) addTweet(refTweet);
  }

  const keptTweets = [...kept.values()];
  const authorIds = new Set(keptTweets.map((item) => String(item?.author_id || '')).filter(Boolean));
  const mediaKeys = new Set<string>();
  for (const item of keptTweets) {
    const keys = Array.isArray(item?.attachments?.media_keys) ? item.attachments.media_keys : [];
    for (const key of keys) mediaKeys.add(String(key));
  }

  const sourceIncludes = raw.includes || includes || {};
  const sourceUsers = Array.isArray(sourceIncludes.users) ? sourceIncludes.users : [];
  const sourceMedia = Array.isArray(sourceIncludes.media) ? sourceIncludes.media : [];
  const compactIncludes: Record<string, unknown[]> = {};
  const users = sourceUsers.filter((user: any) => authorIds.has(String(user?.id)));
  const media = sourceMedia.filter((entry: any) => mediaKeys.has(String(entry?.media_key)));
  if (users.length) compactIncludes.users = users;
  if (media.length) compactIncludes.media = media;

  return {
    data: keptTweets.length === 1 ? keptTweets[0] : keptTweets,
    includes: compactIncludes,
    ...(raw.meta ? { meta: raw.meta } : {}),
  };
}

function hasPayloadMedia(rawJson: unknown): boolean {
  return Array.isArray((rawJson as any)?.includes?.media) && (rawJson as any).includes.media.length > 0;
}

function savePayloadTweets(db: Database, payload: XApiPayload): number {
  const tweets = Array.isArray(payload.data) ? payload.data as XTweet[] : payload.data ? [payload.data as XTweet] : [];
  let saved = 0;
  for (const tweet of tweets) {
    if (saveXStreamTweet(db, tweet, payload.includes, payload)) saved += 1;
  }
  return saved;
}

function walkXWebTweetResults(value: any, out: any[] = []): any[] {
  if (!value || typeof value !== 'object') return out;
  const tweetResult = value?.itemContent?.tweet_results?.result ?? value?.tweet_results?.result;
  if (tweetResult?.legacy || tweetResult?.tweet?.legacy) out.push(tweetResult);
  if (Array.isArray(value)) {
    for (const item of value) walkXWebTweetResults(item, out);
  } else {
    for (const item of Object.values(value)) walkXWebTweetResults(item, out);
  }
  return out;
}

function xWebUserFromTweet(tweet: any): XUser | undefined {
  const user = tweet?.core?.user_results?.result;
  if (!user) return undefined;
  const id = user?.rest_id;
  const username = user?.core?.screen_name ?? user?.legacy?.screen_name;
  if (!id || !username) return undefined;
  return {
    id: String(id),
    username: String(username),
    name: user?.core?.name ?? user?.legacy?.name ?? username,
    profile_image_url: user?.avatar?.image_url ?? user?.legacy?.profile_image_url_https ?? user?.legacy?.profile_image_url,
    verified: Boolean(user?.is_blue_verified ?? user?.legacy?.verified),
  };
}

function xWebTweetToApiTweet(tweetResult: any): { tweet: XTweet; user?: XUser } | null {
  const tweet = tweetResult?.tweet ?? tweetResult;
  const legacy = tweet?.legacy;
  if (!legacy) return null;
  const id = String(legacy.id_str ?? tweet?.rest_id ?? '');
  const user = xWebUserFromTweet(tweet);
  const authorId = String(user?.id ?? '');
  if (!id || !authorId) return null;
  const retweetedResult = legacy.retweeted_status_result?.result;
  const retweetedTweet = retweetedResult?.tweet ?? retweetedResult;
  const retweetedLegacy = retweetedTweet?.legacy;
  const mediaEntities = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
  const fallbackMediaEntities = retweetedLegacy?.extended_entities?.media ?? retweetedLegacy?.entities?.media ?? [];
  const mediaKeys = mediaEntities
    .map((media: any, index: number) => String(media.media_key ?? media.id_str ?? `${id}-${index}`))
    .filter(Boolean);
  const fallbackMediaKeys = fallbackMediaEntities
    .map((media: any, index: number) => String(media.media_key ?? media.id_str ?? `${retweetedTweet?.rest_id ?? id}-rt-${index}`))
    .filter(Boolean);
  return {
    tweet: {
      id,
      text: tweet?.note_tweet?.note_tweet_results?.result?.text ?? legacy.full_text ?? legacy.text ?? '',
      author_id: authorId,
      created_at: legacy.created_at ? new Date(legacy.created_at).toISOString() : undefined,
      conversation_id: legacy.conversation_id_str,
      in_reply_to_user_id: legacy.in_reply_to_user_id_str,
      referenced_tweets: legacy.in_reply_to_status_id_str
        ? [{ type: 'replied_to', id: legacy.in_reply_to_status_id_str }]
        : legacy.retweeted_status_result
          ? [{ type: 'retweeted', id: legacy.retweeted_status_result?.result?.rest_id }]
          : undefined,
      attachments: mediaKeys.length ? { media_keys: mediaKeys } : fallbackMediaKeys.length ? { media_keys: fallbackMediaKeys } : undefined,
      public_metrics: {
        reply_count: legacy.reply_count,
        retweet_count: legacy.retweet_count,
        like_count: legacy.favorite_count,
        quote_count: legacy.quote_count,
        impression_count: tweet?.views?.count ? Number(tweet.views.count) : undefined,
      },
    },
    user,
  };
}

function xWebMediaFromTweet(tweetResult: any): Array<Record<string, unknown>> {
  const tweet = tweetResult?.tweet ?? tweetResult;
  const legacy = tweet?.legacy;
  const id = String(legacy?.id_str ?? tweet?.rest_id ?? '');
  const retweetedResult = legacy?.retweeted_status_result?.result;
  const retweetedTweet = retweetedResult?.tweet ?? retweetedResult;
  const retweetedLegacy = retweetedTweet?.legacy;
  const mediaGroups = [
    {
      id,
      media: legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [],
    },
    {
      id: String(retweetedLegacy?.id_str ?? retweetedTweet?.rest_id ?? `${id}-rt`),
      media: retweetedLegacy?.extended_entities?.media ?? retweetedLegacy?.entities?.media ?? [],
    },
  ];
  return mediaGroups.flatMap((group) => group.media.map((media: any, index: number) => {
    const variants = Array.isArray(media?.video_info?.variants)
      ? media.video_info.variants.filter((variant: any) => variant?.content_type === 'video/mp4')
      : [];
    const bestVideo = variants
      .sort((a: any, b: any) => Number(b?.bitrate ?? 0) - Number(a?.bitrate ?? 0))[0]?.url;
    return {
      media_key: String(media.media_key ?? media.id_str ?? `${group.id}-${index}`),
      type: media.type,
      url: media.media_url_https ?? media.media_url ?? bestVideo,
      preview_image_url: media.media_url_https ?? media.media_url,
      width: media.original_info?.width,
      height: media.original_info?.height,
      alt_text: media.ext_alt_text,
    };
  })).filter((media: any) => media.media_key && (media.url || media.preview_image_url));
}

async function fetchXWebTimeline(account: XWatchAccount, maxResults = 20): Promise<XApiPayload> {
  const json = await xWebGraphQL(
    account.includeReplies ? WEB_USER_TWEETS_AND_REPLIES_QUERY_ID : WEB_USER_TWEETS_QUERY_ID,
    account.includeReplies ? 'UserTweetsAndReplies' : 'UserTweets',
    {
      userId: account.userId,
      count: Math.min(Math.max(maxResults, 5), 40),
      includePromotedContent: false,
      withQuickPromoteEligibility: false,
      withVoice: true,
      withV2Timeline: true,
    },
    { fieldToggles: X_WEB_TIMELINE_FIELD_TOGGLES },
  );
  const users = new Map<string, XUser>();
  const media = new Map<string, Record<string, unknown>>();
  const tweets: XTweet[] = [];
  for (const result of walkXWebTweetResults(json)) {
    const converted = xWebTweetToApiTweet(result);
    if (!converted) continue;
    if (!account.includeReplies && converted.tweet.in_reply_to_user_id) continue;
    tweets.push(converted.tweet);
    if (converted.user?.id) users.set(String(converted.user.id), converted.user);
    for (const item of xWebMediaFromTweet(result)) {
      if (item.media_key) media.set(String(item.media_key), item);
    }
  }
  return { data: tweets, includes: { users: [...users.values()], media: [...media.values()] }, meta: { source: 'browser-session' } };
}

export async function pollXWatchAccountViaBrowser(
  db: Database,
  dbPath: string,
  handle: string,
  maxResults = 20,
): Promise<{ saved: number; handle: string; source: 'browser' }> {
  initXStreamSchema(db);
  const normalized = normalizeXHandle(handle);
  const account = listXWatchAccounts(db).find((item) => item.handle === normalized);
  if (!account) throw new Error(`Watch account not found: @${normalized}`);
  const payload = await fetchXWebTimeline(account, maxResults);
  const saved = savePayloadTweets(db, payload);
  const ts = nowIso();
  db.run(`UPDATE x_watch_accounts SET last_backfilled_at = ?, updated_at = ? WHERE handle = ?`, [ts, ts, normalized]);
  await saveDbPreservingXRemovals(db, dbPath);
  return { saved, handle: normalized, source: 'browser' };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  try {
    const serialized = JSON.stringify(err);
    if (serialized && serialized !== '{}') return serialized;
  } catch {}
  return 'Unknown X browser-session error. Open x.com in your browser, then try Check now.';
}

function isTransientBrowserPollError(message: string): boolean {
  return /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timed out/i.test(message);
}

export function isRateLimitedBrowserPollError(message: string): boolean {
  return /429|rate limit/i.test(message);
}

export async function pollAllXWatchAccountsViaBrowser(
  db: Database,
  dbPath: string,
  options: {
    limit?: number;
    startIndex?: number;
    accountDelayMs?: number;
    rateLimitRetryMs?: number;
    onProgress?: (progress: { accounts: number; checked: number; saved: number; errors: Array<{ handle: string; error: string }> }) => void;
  } = {},
): Promise<{ accounts: number; checked: number; saved: number; source: 'browser'; errors: Array<{ handle: string; error: string }>; nextIndex: number }> {
  const accounts = listXWatchAccounts(db);
  const start = accounts.length ? Math.max(0, options.startIndex ?? 0) % accounts.length : 0;
  const limit = Math.min(Math.max(options.limit ?? accounts.length, 1), accounts.length || 1);
  const selected = accounts.length
    ? Array.from({ length: limit }, (_, index) => accounts[(start + index) % accounts.length])
    : [];
  let saved = 0;
  const errors: Array<{ handle: string; error: string }> = [];
  let checked = 0;
  const accountDelayMs = Math.max(0, options.accountDelayMs ?? WEB_POLL_ACCOUNT_DELAY_MS);
  const rateLimitRetryMs = Math.max(0, options.rateLimitRetryMs ?? WEB_RATE_LIMIT_RETRY_MS);
  for (const [index, account] of selected.entries()) {
    if (index > 0 && accountDelayMs > 0) await delay(accountDelayMs);
    try {
      const result = await withTimeout(
        pollXWatchAccountViaBrowser(db, dbPath, account.handle),
        X_WEB_REQUEST_TIMEOUT_MS + 5_000,
        `X browser session timed out while checking @${account.handle}.`,
      );
      saved += result.saved;
      checked += 1;
      options.onProgress?.({ accounts: accounts.length, checked, saved, errors: [...errors] });
    } catch (err) {
      let message = errorMessage(err);
      const retryDelayMs = /429|rate limit/i.test(message)
        ? rateLimitRetryMs
        : isTransientBrowserPollError(message)
          ? Math.max(4_000, Math.min(rateLimitRetryMs, 15_000))
          : 0;
      if (retryDelayMs > 0) {
        await delay(retryDelayMs);
        try {
          const retryResult = await withTimeout(
            pollXWatchAccountViaBrowser(db, dbPath, account.handle),
            X_WEB_REQUEST_TIMEOUT_MS + 5_000,
            `X browser session timed out while retrying @${account.handle}.`,
          );
          saved += retryResult.saved;
          checked += 1;
          options.onProgress?.({ accounts: accounts.length, checked, saved, errors: [...errors] });
          continue;
        } catch (retryErr) {
          message = `${errorMessage(retryErr)} Retried after ${Math.round(retryDelayMs / 1000)}s and still could not check this account.`;
        }
      }
      errors.push({ handle: account.handle, error: message });
      options.onProgress?.({ accounts: accounts.length, checked, saved, errors: [...errors] });
    }
  }
  const nextIndex = accounts.length ? (start + Math.max(selected.length, 1)) % accounts.length : 0;
  return { accounts: accounts.length, checked, saved, source: 'browser', errors, nextIndex };
}

function browserPollStatusError(result: {
  checked: number;
  errors: Array<{ handle: string; error: string }>;
}): string | null {
  if (!result.errors.length) return null;
  if (result.errors.some((item) => /429|rate limit/i.test(item.error))) return null;
  if (result.checked > 0) return null;
  const firstError = result.errors[0];
  const detail = firstError?.error ? ` First error: @${firstError.handle} ${firstError.error}` : '';
  return `X Feed could not check this batch. Make sure x.com is open and signed in, then use Check now.${detail}`;
}

function browserPollWarning(result: {
  checked: number;
  errors: Array<{ handle: string; error: string }>;
}): string | null {
  if (!result.errors.length) return null;
  const handles = result.errors.slice(0, 5).map((item) => `@${item.handle}`).join(', ');
  const more = result.errors.length > 5 ? ` and ${result.errors.length - 5} more` : '';
  return `${result.errors.length} account(s) could not be checked after retry: ${handles}${more}. Checked ${result.checked} account(s) successfully.`;
}

export async function backfillXWatchAccount(db: Database, dbPath: string, handle: string, maxResults = 20): Promise<{ saved: number; handle: string }> {
  initXStreamSchema(db);
  const normalized = normalizeXHandle(handle);
  const account = listXWatchAccounts(db).find((item) => item.handle === normalized);
  if (!account) throw new Error(`Watch account not found: @${normalized}`);
  const payload = await xFetchJson(`/2/users/${encodeURIComponent(account.userId)}/tweets`, {
    max_results: String(Math.min(Math.max(maxResults, 5), 100)),
    ...(account.includeReplies ? {} : { exclude: 'replies' }),
    'tweet.fields': TWEET_FIELDS,
    expansions: EXPANSIONS,
    'user.fields': USER_FIELDS,
    'media.fields': MEDIA_FIELDS,
  });
  const saved = savePayloadTweets(db, payload);
  db.run(`UPDATE x_watch_accounts SET last_backfilled_at = ?, updated_at = ? WHERE handle = ?`, [nowIso(), nowIso(), normalized]);
  await saveDbPreservingXRemovals(db, dbPath);
  return { saved, handle: normalized };
}

export async function backfillAllXWatchAccounts(db: Database, dbPath: string): Promise<{ accounts: number; saved: number }> {
  const accounts = listXWatchAccounts(db);
  let saved = 0;
  for (const account of accounts) {
    const result = await backfillXWatchAccount(db, dbPath, account.handle);
    saved += result.saved;
  }
  return { accounts: accounts.length, saved };
}

export async function syncXStreamRule(db: Database, dbPath: string): Promise<{ rule: string | null; ruleId: string | null }> {
  initXStreamSchema(db);
  const accounts = listXWatchAccounts(db);
  const nextRule = buildXWatchRule(accounts);
  const existing = await xFetchJson('/2/tweets/search/stream/rules');
  const rules = Array.isArray(existing.data) ? existing.data as Array<{ id?: string; tag?: string; value?: string }> : [];
  const managedIds = rules.filter((rule) => rule.tag === STREAM_RULE_TAG && rule.id).map((rule) => String(rule.id));
  if (managedIds.length) {
    await xFetchJson('/2/tweets/search/stream/rules', undefined, {
      method: 'POST',
      body: JSON.stringify({ delete: { ids: managedIds } }),
    });
  }

  let ruleId: string | null = null;
  if (nextRule) {
    const added = await xFetchJson('/2/tweets/search/stream/rules', undefined, {
      method: 'POST',
      body: JSON.stringify({ add: [{ value: nextRule, tag: STREAM_RULE_TAG }] }),
    });
    const addedRules = Array.isArray(added.data) ? added.data as Array<{ id?: string }> : [];
    ruleId = addedRules[0]?.id ?? null;
  }

  runtime.activeRule = nextRule || null;
  runtime.activeRuleId = ruleId;
  setState(db, 'filtered_stream_rule', nextRule || '');
  setState(db, 'filtered_stream_rule_id', ruleId || '');
  await saveDbPreservingXRemovals(db, dbPath);
  return { rule: runtime.activeRule, ruleId };
}

function rowToStreamItem(row: unknown[]): XStreamItem {
  let rawJson: unknown = {};
  try { rawJson = JSON.parse(String(row[8] ?? '{}')); } catch {}
  return {
    tweetId: String(row[0] ?? ''),
    authorId: String(row[1] ?? ''),
    username: String(row[2] ?? ''),
    text: String(row[3] ?? ''),
    createdAt: String(row[4] ?? ''),
    itemType: String(row[5] ?? 'post') === 'reply' ? 'reply' : 'post',
    conversationId: row[6] ? String(row[6]) : null,
    sourceAccount: String(row[7] ?? ''),
    rawJson,
    receivedAt: String(row[9] ?? ''),
  };
}

export function listXStreamItems(
  db: Database,
  limit = 50,
  type: 'all' | 'post' | 'reply' = 'all',
  sourceAccount?: string,
): XStreamItem[] {
  initXStreamSchema(db);
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const params: Array<string | number> = [];
  const whereParts: string[] = [];
  if (type !== 'all') {
    whereParts.push('item_type = ?');
    params.push(type);
  }
  if (sourceAccount) {
    whereParts.push('(source_account = ? COLLATE NOCASE OR username = ? COLLATE NOCASE)');
    params.push(normalizeXHandle(sourceAccount), normalizeXHandle(sourceAccount));
  }
  params.push(safeLimit);
  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const rows = db.exec(
    `SELECT tweet_id, author_id, username, text, created_at, item_type, conversation_id, source_account, raw_json, received_at
     FROM x_stream_items
     ${where}
     ORDER BY datetime(created_at) DESC, datetime(received_at) DESC
     LIMIT ?`,
    params,
  );
  return (rows[0]?.values ?? []).map(rowToStreamItem);
}

export function getXStreamItem(db: Database, tweetId: string): XStreamItem | null {
  initXStreamSchema(db);
  const rows = db.exec(
    `SELECT tweet_id, author_id, username, text, created_at, item_type, conversation_id, source_account, raw_json, received_at
     FROM x_stream_items
     WHERE tweet_id = ?
     LIMIT 1`,
    [tweetId],
  );
  const row = rows[0]?.values?.[0];
  return row ? rowToStreamItem(row) : null;
}

export function removeXStreamItem(db: Database, dbPath: string, tweetId: string): boolean {
  initXStreamSchema(db);
  const removed = tombstoneXStreamItem(db, tweetId);
  if (dbPath !== ':memory:') saveDb(db, dbPath);
  return removed;
}

export async function removeXStreamItemAndSave(db: Database, dbPath: string, tweetId: string): Promise<boolean> {
  initXStreamSchema(db);
  await mergeXStreamRemovedItemsFromDisk(db, dbPath);
  const removed = tombstoneXStreamItem(db, tweetId);
  await saveDbPreservingXRemovals(db, dbPath);
  return removed;
}

export function removeXStreamItems(
  db: Database,
  dbPath: string,
  options: { sourceAccount?: string } = {},
): number {
  initXStreamSchema(db);
  const params: string[] = [];
  let where = '';
  if (options.sourceAccount) {
    where = 'WHERE source_account = ? COLLATE NOCASE OR username = ? COLLATE NOCASE';
    const handle = normalizeXHandle(options.sourceAccount);
    params.push(handle, handle);
  }

  const rows = db.exec(`SELECT tweet_id FROM x_stream_items ${where}`, params);
  const tweetIds = (rows[0]?.values ?? []).map((row) => String(row[0] ?? '')).filter(Boolean);
  if (!tweetIds.length) return 0;

  const removedAt = nowIso();
  db.run('BEGIN TRANSACTION');
  try {
    for (const tweetId of tweetIds) {
      db.run(
        `INSERT OR REPLACE INTO x_stream_removed_items (tweet_id, removed_at) VALUES (?, ?)`,
        [tweetId, removedAt],
      );
    }
    db.run(`DELETE FROM x_stream_items ${where}`, params);
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
  if (dbPath !== ':memory:') saveDb(db, dbPath);
  return tweetIds.length;
}

export async function removeXStreamItemsAndSave(
  db: Database,
  dbPath: string,
  options: { sourceAccount?: string } = {},
): Promise<number> {
  initXStreamSchema(db);
  await mergeXStreamRemovedItemsFromDisk(db, dbPath);
  const removed = removeXStreamItems(db, ':memory:', options);
  await saveDbPreservingXRemovals(db, dbPath);
  return removed;
}

function xStreamItemToBookmarkRecord(item: XStreamItem): BookmarkRecord {
  const tweet = rawTweetFromStreamItem(item);
  const author = rawAuthorFromStreamItem(item);
  const metrics = tweet?.public_metrics ?? {};
  const mediaObjects = rawMediaFromStreamItem(item);
  return {
    id: item.tweetId,
    tweetId: item.tweetId,
    url: `https://x.com/${item.username}/status/${item.tweetId}`,
    text: item.text,
    authorHandle: item.username,
    authorName: author?.name ?? item.username,
    authorProfileImageUrl: author?.profile_image_url,
    author: {
      id: item.authorId,
      handle: item.username,
      name: author?.name ?? item.username,
      profileImageUrl: author?.profile_image_url,
      verified: Boolean(author?.verified),
    } as BookmarkRecord['author'],
    postedAt: item.createdAt,
    bookmarkedAt: nowIso(),
    syncedAt: nowIso(),
    conversationId: item.conversationId ?? undefined,
    inReplyToStatusId: tweet?.referenced_tweets?.find((ref: any) => ref?.type === 'replied_to')?.id,
    inReplyToUserId: tweet?.in_reply_to_user_id,
    engagement: {
      likeCount: metrics.like_count,
      repostCount: metrics.retweet_count,
      replyCount: metrics.reply_count,
      quoteCount: metrics.quote_count,
      bookmarkCount: metrics.bookmark_count,
      viewCount: metrics.impression_count,
    },
    media: mediaObjects.map((media) => media.url ?? media.previewUrl ?? '').filter(Boolean),
    mediaObjects,
    links: extractExpandedUrls(item.text, tweet),
    tags: ['x-feed'],
    ingestedVia: 'browser',
  };
}

function rawTweetFromStreamItem(item: XStreamItem): any {
  const data = (item.rawJson as any)?.data;
  return Array.isArray(data) ? data.find((tweet: any) => String(tweet?.id) === item.tweetId) ?? data[0] : data ?? {};
}

function rawAuthorFromStreamItem(item: XStreamItem): any {
  const tweet = rawTweetFromStreamItem(item);
  return ((item.rawJson as any)?.includes?.users ?? []).find((user: any) => String(user?.id) === String(tweet?.author_id ?? item.authorId)) ?? {};
}

function rawMediaFromStreamItem(item: XStreamItem): NonNullable<BookmarkRecord['mediaObjects']> {
  const tweet = rawTweetFromStreamItem(item);
  const mediaKeys = mediaKeysForTweet(item, tweet);
  if (!mediaKeys.length) return [];
  const allMedia = Array.isArray((item.rawJson as any)?.includes?.media) ? (item.rawJson as any).includes.media : [];
  return allMedia
    .filter((media: any) => mediaKeys.includes(String(media?.media_key)))
    .map((media: any) => ({
      type: media.type,
      url: media.url,
      previewUrl: media.preview_image_url,
      altText: media.alt_text,
      width: media.width,
      height: media.height,
    }))
    .filter((media: any) => media.url || media.previewUrl);
}

function mediaKeysForTweet(item: XStreamItem, tweet: any): string[] {
  const direct = Array.isArray(tweet?.attachments?.media_keys) ? tweet.attachments.media_keys.map(String) : [];
  if (direct.length) return direct;
  const retweetedId = (tweet?.referenced_tweets ?? []).find((ref: any) => ref?.type === 'retweeted')?.id;
  if (!retweetedId) return [];
  const data = (item.rawJson as any)?.data;
  const tweets = Array.isArray(data) ? data : data ? [data] : [];
  const original = tweets.find((candidate: any) => String(candidate?.id) === String(retweetedId));
  return Array.isArray(original?.attachments?.media_keys) ? original.attachments.media_keys.map(String) : [];
}

function extractExpandedUrls(text: string, tweet: any): string[] {
  const entityUrls = Array.isArray(tweet?.entities?.urls)
    ? tweet.entities.urls.map((url: any) => url.expanded_url).filter(Boolean)
    : [];
  const plainUrls = text.match(/https?:\/\/[^\s]+/g) ?? [];
  return [...new Set([...entityUrls, ...plainUrls].filter((url) => !String(url).includes('t.co')))];
}

export async function saveXStreamItemToBookmarks(db: Database, tweetId: string): Promise<{ saved: boolean; record: BookmarkRecord }> {
  const item = getXStreamItem(db, tweetId);
  if (!item) throw new Error(`X Feed item not found: ${tweetId}`);
  const record = xStreamItemToBookmarkRecord(item);
  const cachePath = twitterBookmarksCachePath();
  const records = await readJsonLines<BookmarkRecord>(cachePath);
  const index = records.findIndex((existing) => existing.id === record.id || existing.tweetId === record.tweetId);
  const saved = index < 0;
  if (index >= 0) records[index] = { ...records[index], ...record, bookmarkedAt: records[index].bookmarkedAt ?? record.bookmarkedAt };
  else records.unshift(record);
  await writeJsonLines(cachePath, records);
  return { saved, record };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForCurrentBrowserPoll(timeoutMs = 180_000): Promise<void> {
  const startedAt = Date.now();
  while (pollRuntime.inFlight) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('X Feed is still checking accounts. Try Fresh update again in a minute.');
    }
    await delay(500);
  }
}

function pollAccountFailureCount(db: Database, handle: string): number {
  const row = db.exec(`SELECT consecutive_failures FROM x_watch_poll_state WHERE handle = ?`, [handle])[0]?.values?.[0];
  return Number(row?.[0] ?? 0);
}

function rateLimitRetryDelayMs(db: Database, handle: string, baseDelayMs: number): number {
  const failures = Math.max(0, pollAccountFailureCount(db, handle));
  return Math.min(Math.max(baseDelayMs, 60_000) * Math.pow(2, Math.min(failures, 2)), 30 * 60 * 1000);
}

async function pollQueuedAccount(
  db: Database,
  dbPath: string,
  account: XWatchAccount,
  options: Required<Pick<XBrowserPollOptions, 'rateLimitRetryMs'>>,
): Promise<{ status: 'checked' | 'delayed' | 'failed'; saved: number; error?: string; retryAfter?: string }> {
  const checkedAt = nowIso();
  try {
    const result = await withTimeout(
      pollXWatchAccountViaBrowser(db, dbPath, account.handle),
      X_WEB_REQUEST_TIMEOUT_MS + 5_000,
      `X browser session timed out while checking @${account.handle}.`,
    );
    setPollAccountState(db, account.handle, 'checked', {
      lastCheckedAt: checkedAt,
      lastSuccessAt: checkedAt,
      lastError: null,
      retryAfter: null,
      consecutiveFailures: 0,
      lastSaved: result.saved,
    });
    await saveDbPreservingXRemovals(db, dbPath);
    return { status: 'checked', saved: result.saved };
  } catch (err) {
    let message = errorMessage(err);
    if (isRateLimitedBrowserPollError(message)) {
      const failures = pollAccountFailureCount(db, account.handle) + 1;
      const delayMs = rateLimitRetryDelayMs(db, account.handle, options.rateLimitRetryMs);
      const retryAfter = new Date(Date.now() + delayMs).toISOString();
      setPollAccountState(db, account.handle, 'delayed', {
        lastCheckedAt: checkedAt,
        lastError: message,
        retryAfter,
        consecutiveFailures: failures,
        lastSaved: 0,
      });
      await saveDbPreservingXRemovals(db, dbPath);
      return { status: 'delayed', saved: 0, error: message, retryAfter };
    }

    if (isTransientBrowserPollError(message)) {
      await delay(8_000);
      try {
        const retryResult = await withTimeout(
          pollXWatchAccountViaBrowser(db, dbPath, account.handle),
          X_WEB_REQUEST_TIMEOUT_MS + 5_000,
          `X browser session timed out while retrying @${account.handle}.`,
        );
        const retryCheckedAt = nowIso();
        setPollAccountState(db, account.handle, 'checked', {
          lastCheckedAt: retryCheckedAt,
          lastSuccessAt: retryCheckedAt,
          lastError: null,
          retryAfter: null,
          consecutiveFailures: 0,
          lastSaved: retryResult.saved,
        });
        await saveDbPreservingXRemovals(db, dbPath);
        return { status: 'checked', saved: retryResult.saved };
      } catch (retryErr) {
        message = `${errorMessage(retryErr)} Retried after 8s and still could not check this account.`;
      }
    }

    const failures = pollAccountFailureCount(db, account.handle) + 1;
    setPollAccountState(db, account.handle, 'failed', {
      lastCheckedAt: checkedAt,
      lastError: message,
      retryAfter: null,
      consecutiveFailures: failures,
      lastSaved: 0,
    });
    await saveDbPreservingXRemovals(db, dbPath);
    return { status: 'failed', saved: 0, error: message };
  }
}

function streamRetryDelayMs(err: unknown, attempt: number): number {
  const message = (err as Error).message || '';
  if (err instanceof XApiError && err.status === 429) return 5 * 60 * 1000;
  if (message.includes('X stream 429')) return 5 * 60 * 1000;
  if (message.includes('TooManyConnections') || message.includes('maximum allowed connection limit')) return 5 * 60 * 1000;
  return Math.min(30_000, 1_000 * Math.pow(2, Math.min(attempt, 5)));
}

async function connectOnce(db: Database, dbPath: string, signal: AbortSignal): Promise<void> {
  const url = new URL('/2/tweets/search/stream', X_API_BASE);
  url.searchParams.set('tweet.fields', TWEET_FIELDS);
  url.searchParams.set('expansions', EXPANSIONS);
  url.searchParams.set('user.fields', USER_FIELDS);
  url.searchParams.set('media.fields', MEDIA_FIELDS);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getBearerToken()}` },
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`X stream ${res.status}: ${text || res.statusText}`);
  }
  runtime.connecting = false;
  runtime.running = true;
  runtime.lastError = null;
  runtime.nextRetryAt = null;
  runtime.lastConnectedAt = nowIso();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!runtime.stopRequested) {
    const { done, value } = await reader.read();
    if (done) throw new Error('X stream ended.');
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const payload = JSON.parse(trimmed) as XApiPayload;
      const saved = savePayloadTweets(db, payload);
      if (saved > 0) await saveDbPreservingXRemovals(db, dbPath);
    }
  }
}

export async function startXFilteredStream(options: { getDb: () => Database; dbPath: string }): Promise<XStreamStatus> {
  if (runtime.running || runtime.connecting) return getXStreamStatus();
  if (runtime.nextRetryAt && Date.parse(runtime.nextRetryAt) > Date.now() && !runtime.stopRequested) return getXStreamStatus();
  runtime.stopRequested = false;
  runtime.lastError = null;
  const initialDb = options.getDb();
  const rule = await syncXStreamRule(initialDb, options.dbPath);
  if (!rule.rule) {
    runtime.running = false;
    runtime.connecting = false;
    return getXStreamStatus();
  }

  void (async () => {
    let attempt = 0;
    while (!runtime.stopRequested) {
      runtime.connecting = true;
      runtime.nextRetryAt = null;
      runtime.abort = new AbortController();
      try {
        await connectOnce(options.getDb(), options.dbPath, runtime.abort.signal);
        attempt = 0;
      } catch (err) {
        if (runtime.stopRequested) break;
        runtime.running = false;
        runtime.connecting = false;
        runtime.lastError = (err as Error).message;
        runtime.reconnects += 1;
        attempt += 1;
        const retryDelay = streamRetryDelayMs(err, attempt);
        runtime.nextRetryAt = new Date(Date.now() + retryDelay).toISOString();
        await delay(retryDelay);
      }
    }
    runtime.running = false;
    runtime.connecting = false;
    runtime.abort = undefined;
  })();

  return getXStreamStatus();
}

export async function runXBrowserPollOnce(options: XBrowserPollOptions): Promise<{ accounts: number; checked: number; saved: number; source: 'browser'; errors: Array<{ handle: string; error: string }>; delayed?: number; waiting?: number }> {
  if (pollRuntime.inFlight) {
    if (options.waitForCurrent) {
      await waitForCurrentBrowserPoll();
    } else {
      pollRuntime.lastError = null;
      const db = await options.getDb();
      try {
        return { accounts: listXWatchAccounts(db).length, checked: 0, saved: 0, source: 'browser', errors: [] };
      } finally {
        await options.releaseDb?.(db);
      }
    }
  }
  pollRuntime.inFlight = true;
  pollRuntime.lastError = null;
  pollRuntime.lastSaved = 0;
  pollRuntime.lastChecked = 0;
  pollRuntime.lastFailed = 0;
  pollRuntime.lastFailures = [];
  pollRuntime.lastWarning = null;
  pollRuntime.currentHandle = null;
  const db = await options.getDb();
  try {
    initXStreamSchema(db);
    if (options.forceNew || activePollStateCount(db) === 0) {
      startXWatchPollQueue(db);
      await saveDbPreservingXRemovals(db, options.dbPath);
    } else {
      db.run(`UPDATE x_watch_poll_state SET state = 'waiting', updated_at = ? WHERE state = 'checking'`, [nowIso()]);
      syncPollQueueAccounts(db);
      await saveDbPreservingXRemovals(db, options.dbPath);
    }

    let summary = getXPollQueueSummary(db);
    applyQueueSummaryToRuntime(summary);
    const accountDelayMs = Math.max(0, options.accountDelayMs ?? WEB_POLL_ACCOUNT_DELAY_MS);
    const rateLimitRetryMs = Math.max(0, options.rateLimitRetryMs ?? WEB_RATE_LIMIT_RETRY_MS);
    let processed = 0;
    while (true) {
      summary = getXPollQueueSummary(db);
      applyQueueSummaryToRuntime(summary);
      if (summary.waiting === 0) {
        if (summary.delayed > 0) {
          pollRuntime.nextPollAt = summary.cooldownUntil;
          pollRuntime.lastError = null;
          break;
        }
        const completedAt = nowIso();
        setState(db, 'x_poll_run_completed_at', completedAt);
        summary = getXPollQueueSummary(db);
        summary.completedAt = completedAt;
        applyQueueSummaryToRuntime(summary);
        pollRuntime.lastPollAt = completedAt;
        pollRuntime.lastError = browserPollStatusError({
          checked: summary.checked,
          errors: pollRuntime.lastFailures,
        });
        pollRuntime.nextPollAt = pollRuntime.running
          ? new Date(Date.now() + WEB_POLL_INTERVAL_MS).toISOString()
          : null;
        await saveDbPreservingXRemovals(db, options.dbPath);
        break;
      }

      const account = nextQueuedPollAccount(db);
      if (!account) {
        pollRuntime.nextPollAt = summary.cooldownUntil;
        break;
      }
      if (processed > 0 && accountDelayMs > 0) await delay(accountDelayMs);
      setPollAccountState(db, account.handle, 'checking', { lastError: null, retryAfter: null });
      applyQueueSummaryToRuntime(getXPollQueueSummary(db));
      await saveDbPreservingXRemovals(db, options.dbPath);
      const accountResult = await pollQueuedAccount(db, options.dbPath, account, { rateLimitRetryMs });
      processed += 1;
      summary = getXPollQueueSummary(db);
      applyQueueSummaryToRuntime(summary);
      await options.afterPoll?.({
        accounts: summary.total,
        checked: summary.checked,
        saved: summary.saved,
        source: 'browser',
        errors: hardPollFailuresFromSummary(summary),
      });
      if (accountResult.status === 'delayed') {
        pollRuntime.nextPollAt = accountResult.retryAfter ?? summary.cooldownUntil;
        break;
      }
    }

    summary = getXPollQueueSummary(db);
    applyQueueSummaryToRuntime(summary);
    const result = {
      accounts: summary.total,
      checked: summary.checked,
      saved: summary.saved,
      source: 'browser' as const,
      errors: hardPollFailuresFromSummary(summary),
      delayed: summary.delayed,
      waiting: summary.waiting,
    };
    await options.afterPoll?.(result);
    return result;
  } catch (err) {
    pollRuntime.lastError = errorMessage(err);
    throw err;
  } finally {
    await options.releaseDb?.(db);
    pollRuntime.inFlight = false;
  }
}

export function runXBrowserPollInBackground(options: XBrowserPollOptions): XStreamStatus {
  if (!pollRuntime.inFlight) {
    void runXBrowserPollOnce(options).catch(() => {});
  }
  return getXStreamStatus();
}

function nextBrowserPollDelayMs(): number {
  const target = pollRuntime.nextPollAt ? Date.parse(pollRuntime.nextPollAt) : NaN;
  if (Number.isFinite(target)) return Math.max(5_000, target - Date.now());
  return WEB_POLL_INTERVAL_MS;
}

function scheduleNextBrowserPoll(options: XBrowserPollOptions): void {
  if (!pollRuntime.running) return;
  if (pollRuntime.timer) clearTimeout(pollRuntime.timer);
  const delayMs = nextBrowserPollDelayMs();
  pollRuntime.nextPollAt = new Date(Date.now() + delayMs).toISOString();
  pollRuntime.timer = setTimeout(() => {
    pollRuntime.timer = undefined;
    void runXBrowserPollOnce(options)
      .catch(() => {})
      .finally(() => scheduleNextBrowserPoll(options));
  }, delayMs);
}

export function manualXBrowserPollOptions(): Pick<XBrowserPollOptions, 'accountDelayMs' | 'rateLimitRetryMs'> {
  return {
    accountDelayMs: WEB_MANUAL_POLL_ACCOUNT_DELAY_MS,
    rateLimitRetryMs: WEB_MANUAL_RATE_LIMIT_RETRY_MS,
  };
}

export async function startXBrowserPoller(options: XBrowserPollOptions): Promise<XStreamStatus> {
  if (pollRuntime.running) return getXStreamStatus();
  pollRuntime.running = true;
  pollRuntime.nextPollAt = new Date(Date.now() + WEB_POLL_INTERVAL_MS).toISOString();
  void runXBrowserPollOnce(options)
    .catch(() => {})
    .finally(() => scheduleNextBrowserPoll(options));
  return getXStreamStatus();
}

export function stopXBrowserPoller(): XStreamStatus {
  pollRuntime.running = false;
  pollRuntime.nextPollAt = null;
  if (pollRuntime.timer) clearInterval(pollRuntime.timer);
  pollRuntime.timer = undefined;
  return getXStreamStatus();
}

export function stopXFilteredStream(): XStreamStatus {
  runtime.stopRequested = true;
  runtime.abort?.abort();
  runtime.running = false;
  runtime.connecting = false;
  runtime.nextRetryAt = null;
  return getXStreamStatus();
}

export function getXStreamStatus(): XStreamStatus {
  return {
    running: runtime.running,
    connecting: runtime.connecting,
    pollerRunning: pollRuntime.running,
    pollerInFlight: pollRuntime.inFlight,
    hasBearerToken: Boolean(process.env.X_BEARER_TOKEN?.trim()),
    hasBrowserSession: true,
    sourceMode: pollRuntime.running || pollRuntime.inFlight || pollRuntime.lastPollAt ? 'browser' : 'api',
    activeRule: runtime.activeRule,
    activeRuleId: runtime.activeRuleId,
    lastConnectedAt: runtime.lastConnectedAt,
    lastEventAt: runtime.lastEventAt,
    lastPollAt: pollRuntime.lastPollAt,
    nextPollAt: pollRuntime.nextPollAt,
    lastPollSaved: pollRuntime.lastSaved,
    lastPollChecked: pollRuntime.lastChecked,
    lastPollFailed: pollRuntime.lastFailed,
    pollRunId: pollRuntime.runId,
    pollRunStartedAt: pollRuntime.runStartedAt,
    pollRunCompletedAt: pollRuntime.runCompletedAt,
    pollTotal: pollRuntime.total,
    pollChecked: pollRuntime.lastChecked,
    pollWaiting: pollRuntime.waiting,
    pollDelayed: pollRuntime.delayed,
    pollFailed: pollRuntime.lastFailed,
    pollSaved: pollRuntime.lastSaved,
    pollCurrentHandle: pollRuntime.currentHandle,
    pollCooldownUntil: pollRuntime.cooldownUntil,
    pollDelayedAccounts: pollRuntime.delayedAccounts,
    pollFailedAccounts: pollRuntime.failedAccounts,
    lastPollWarning: pollRuntime.lastWarning,
    lastPollFailures: pollRuntime.lastFailures,
    lastError: runtime.lastError,
    lastPollError: pollRuntime.lastError,
    nextRetryAt: runtime.nextRetryAt,
    reconnects: runtime.reconnects,
  };
}
