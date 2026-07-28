import crypto from 'node:crypto';
import type { Database } from 'sql.js';

const ACTIVATION_MIGRATION = 'activation-v1';
const DAY_MS = 86_400_000;
const activationSchemaReady = new WeakSet<object>();

export const BOOKMARK_INTENTS = [
  'learn',
  'build',
  'try',
  'research',
  'contact',
  'buy',
  'inspiration',
  'reference',
] as const;

export type BookmarkIntent = typeof BOOKMARK_INTENTS[number];
export type ActivationStatus = 'active' | 'done' | 'archived';
export type TodayQueueStatus = 'pending' | 'done' | 'dismissed' | 'snoozed';
export type ProjectItemRole = 'evidence' | 'inspiration' | 'task' | 'decision' | 'reference';

export interface ActivationProfile {
  bookmarkId: string;
  intent: BookmarkIntent | null;
  whySaved: string;
  importance: number;
  status: ActivationStatus;
  nextReviewAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActivationProfileInput {
  intent?: BookmarkIntent | null;
  whySaved?: string;
  importance?: number;
  status?: ActivationStatus;
  nextReviewAt?: string | null;
}

export interface BookmarkEnrichment {
  bookmarkId: string;
  sourceHash: string;
  version: number;
  status: 'ready' | 'error';
  summary: string;
  keyClaim: string;
  whyItMatters: string;
  suggestedAction: string;
  entities: string[];
  claims: string[];
  freshnessDays: number;
  freshUntil: string | null;
  engine: string;
  enrichedAt: string;
  error: string | null;
}

export interface ScoreComponent {
  key: string;
  label: string;
  points: number;
}

export interface TodayQueueItem {
  id: number;
  queueDate: string;
  bookmarkId: string;
  reason: string;
  score: number;
  scoreBreakdown: ScoreComponent[];
  status: TodayQueueStatus;
  snoozedUntil: string | null;
  createdAt: string;
  actedAt: string | null;
}

export interface BrainCycleResult {
  id: number;
  status: 'success' | 'error';
  startedAt: string;
  finishedAt: string;
  processed: number;
  enriched: number;
  claimsCreated: number;
  relationsCreated: number;
  pendingAfter: number;
  summary: string;
  error: string | null;
}

export interface AuthorDossier {
  author: {
    handle: string;
    name: string;
    profileImageUrl: string | null;
  };
  totals: {
    bookmarks: number;
    unread: number;
    notes: number;
    enriched: number;
  };
  categories: Array<{ name: string; count: number }>;
  domains: Array<{ name: string; count: number }>;
  timeline: Array<{ month: string; count: number }>;
  projects: Array<{ id: string; name: string; kind: string; count: number }>;
  claims: Array<{
    id: number;
    bookmarkId: string;
    text: string;
    type: string;
    capturedAt: string;
    freshUntil: string | null;
    sourceUrl: string;
  }>;
  recentSignals: Array<Record<string, unknown>>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function todayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function tableExists(db: Database, name: string): boolean {
  const rows = db.exec(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    [name],
  );
  return Boolean(rows[0]?.values.length);
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseScoreBreakdown(value: unknown): ScoreComponent[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const candidate = entry as Record<string, unknown>;
      if (
        typeof candidate.key !== 'string'
        || typeof candidate.label !== 'string'
        || typeof candidate.points !== 'number'
      ) return [];
      return [{
        key: candidate.key,
        label: candidate.label,
        points: candidate.points,
      }];
    });
  } catch {
    return [];
  }
}

function clampImportance(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(5, Math.round(parsed)));
}

function isIntent(value: unknown): value is BookmarkIntent {
  return typeof value === 'string' && BOOKMARK_INTENTS.includes(value as BookmarkIntent);
}

function rowToProfile(row: unknown[]): ActivationProfile {
  return {
    bookmarkId: String(row[0]),
    intent: isIntent(row[1]) ? row[1] : null,
    whySaved: String(row[2] ?? ''),
    importance: clampImportance(row[3]),
    status: row[4] === 'done' || row[4] === 'archived' ? row[4] : 'active',
    nextReviewAt: typeof row[5] === 'string' ? row[5] : null,
    lastUsedAt: typeof row[6] === 'string' ? row[6] : null,
    createdAt: String(row[7] ?? ''),
    updatedAt: String(row[8] ?? ''),
  };
}

function rowToEnrichment(row: unknown[]): BookmarkEnrichment {
  return {
    bookmarkId: String(row[0]),
    sourceHash: String(row[1] ?? ''),
    version: Number(row[2] ?? 1),
    status: row[3] === 'error' ? 'error' : 'ready',
    summary: String(row[4] ?? ''),
    keyClaim: String(row[5] ?? ''),
    whyItMatters: String(row[6] ?? ''),
    suggestedAction: String(row[7] ?? ''),
    entities: parseJsonArray(row[8]),
    claims: parseJsonArray(row[9]),
    freshnessDays: Number(row[10] ?? 0),
    freshUntil: typeof row[11] === 'string' ? row[11] : null,
    engine: String(row[12] ?? 'local-rules'),
    enrichedAt: String(row[13] ?? ''),
    error: typeof row[14] === 'string' ? row[14] : null,
  };
}

function rowToTodayItem(row: unknown[]): TodayQueueItem {
  const rawStatus = String(row[6] ?? 'pending');
  const status: TodayQueueStatus = rawStatus === 'done'
    || rawStatus === 'dismissed'
    || rawStatus === 'snoozed'
    ? rawStatus
    : 'pending';
  return {
    id: Number(row[0]),
    queueDate: String(row[1]),
    bookmarkId: String(row[2]),
    reason: String(row[3] ?? 'worth_revisiting'),
    score: Number(row[4] ?? 0),
    scoreBreakdown: parseScoreBreakdown(row[5]),
    status,
    snoozedUntil: typeof row[7] === 'string' ? row[7] : null,
    createdAt: String(row[8] ?? ''),
    actedAt: typeof row[9] === 'string' ? row[9] : null,
  };
}

export function activationSchemaPending(db: Database): boolean {
  if (!tableExists(db, 'activation_schema_migrations')) return true;
  const rows = db.exec(
    'SELECT 1 FROM activation_schema_migrations WHERE id = ? LIMIT 1',
    [ACTIVATION_MIGRATION],
  );
  return !rows[0]?.values.length;
}

export function ensureActivationSchema(db: Database): void {
  if (activationSchemaReady.has(db as object)) return;
  db.run(`CREATE TABLE IF NOT EXISTS activation_schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS bookmark_activation_profiles (
    bookmark_id TEXT PRIMARY KEY,
    intent TEXT,
    why_saved TEXT NOT NULL DEFAULT '',
    importance INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    next_review_at TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS activation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bookmark_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS bookmark_enrichment (
    bookmark_id TEXT PRIMARY KEY,
    source_hash TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'ready',
    summary TEXT NOT NULL DEFAULT '',
    key_claim TEXT NOT NULL DEFAULT '',
    why_it_matters TEXT NOT NULL DEFAULT '',
    suggested_action TEXT NOT NULL DEFAULT '',
    entities_json TEXT NOT NULL DEFAULT '[]',
    claims_json TEXT NOT NULL DEFAULT '[]',
    freshness_days INTEGER NOT NULL DEFAULT 0,
    fresh_until TEXT,
    engine TEXT NOT NULL DEFAULT 'local-rules',
    enriched_at TEXT NOT NULL,
    error TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS today_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_date TEXT NOT NULL,
    bookmark_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    score REAL NOT NULL,
    score_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    snoozed_until TEXT,
    created_at TEXT NOT NULL,
    acted_at TEXT,
    UNIQUE(queue_date, bookmark_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS activation_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bookmark_id TEXT NOT NULL,
    claim_text TEXT NOT NULL,
    entity_key TEXT,
    polarity TEXT NOT NULL DEFAULT 'neutral',
    claim_type TEXT NOT NULL DEFAULT 'observation',
    source_url TEXT NOT NULL DEFAULT '',
    captured_at TEXT NOT NULL,
    fresh_until TEXT,
    review_status TEXT NOT NULL DEFAULT 'unreviewed',
    created_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS activation_claim_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    left_claim_id INTEGER NOT NULL,
    right_claim_id INTEGER NOT NULL,
    relation TEXT NOT NULL,
    confidence REAL NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate',
    created_at TEXT NOT NULL,
    UNIQUE(left_claim_id, right_claim_id, relation)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS activation_cycle_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    processed INTEGER NOT NULL DEFAULT 0,
    enriched INTEGER NOT NULL DEFAULT 0,
    claims_created INTEGER NOT NULL DEFAULT 0,
    relations_created INTEGER NOT NULL DEFAULT 0,
    pending_after INTEGER,
    summary TEXT NOT NULL DEFAULT '',
    error TEXT
  )`);
  try { db.run('ALTER TABLE activation_cycle_runs ADD COLUMN pending_after INTEGER'); } catch { /* already exists */ }
  db.run(`CREATE TABLE IF NOT EXISTS project_item_roles (
    space_id TEXT NOT NULL REFERENCES brain_spaces(id) ON DELETE CASCADE,
    bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'evidence',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (space_id, bookmark_id)
  )`);

  db.run('CREATE INDEX IF NOT EXISTS idx_activation_events_bookmark ON activation_events(bookmark_id, occurred_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_activation_events_type ON activation_events(event_type, occurred_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_activation_profiles_review ON bookmark_activation_profiles(status, next_review_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_today_queue_date ON today_queue(queue_date, status, score)');
  db.run('CREATE INDEX IF NOT EXISTS idx_today_queue_bookmark ON today_queue(bookmark_id, created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_activation_claims_entity ON activation_claims(entity_key, captured_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_activation_claims_bookmark ON activation_claims(bookmark_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_project_item_roles_bookmark ON project_item_roles(bookmark_id)');
  db.run(
    'INSERT OR IGNORE INTO activation_schema_migrations (id, applied_at) VALUES (?, ?)',
    [ACTIVATION_MIGRATION, nowIso()],
  );
  activationSchemaReady.add(db as object);
}

export function getActivationProfileFromDb(db: Database, bookmarkId: string): ActivationProfile | null {
  ensureActivationSchema(db);
  const rows = db.exec(
    `SELECT bookmark_id, intent, why_saved, importance, status, next_review_at,
            last_used_at, created_at, updated_at
     FROM bookmark_activation_profiles WHERE bookmark_id = ? LIMIT 1`,
    [bookmarkId],
  );
  const row = rows[0]?.values[0];
  return row ? rowToProfile(row) : null;
}

export function upsertActivationProfileFromDb(
  db: Database,
  bookmarkId: string,
  input: ActivationProfileInput,
): ActivationProfile {
  ensureActivationSchema(db);
  if (input.intent !== undefined && input.intent !== null && !isIntent(input.intent)) {
    throw new Error('Invalid bookmark intent.');
  }
  const existing = getActivationProfileFromDb(db, bookmarkId);
  const now = nowIso();
  const intent = input.intent === undefined ? existing?.intent ?? null : input.intent;
  const whySaved = input.whySaved === undefined ? existing?.whySaved ?? '' : input.whySaved.trim();
  const importance = input.importance === undefined
    ? existing?.importance ?? 0
    : clampImportance(input.importance);
  const status = input.status ?? existing?.status ?? 'active';
  const nextReviewAt = input.nextReviewAt === undefined
    ? existing?.nextReviewAt ?? null
    : input.nextReviewAt;
  const createdAt = existing?.createdAt || now;

  db.run(
    `INSERT INTO bookmark_activation_profiles (
       bookmark_id, intent, why_saved, importance, status, next_review_at,
       last_used_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(bookmark_id) DO UPDATE SET
       intent = excluded.intent,
       why_saved = excluded.why_saved,
       importance = excluded.importance,
       status = excluded.status,
       next_review_at = excluded.next_review_at,
       updated_at = excluded.updated_at`,
    [
      bookmarkId,
      intent,
      whySaved,
      importance,
      status,
      nextReviewAt,
      existing?.lastUsedAt ?? null,
      createdAt,
      now,
    ],
  );
  return getActivationProfileFromDb(db, bookmarkId)!;
}

export function recordActivationEventFromDb(
  db: Database,
  bookmarkId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
): number {
  ensureActivationSchema(db);
  const occurredAt = nowIso();
  db.run(
    `INSERT INTO activation_events (bookmark_id, event_type, metadata_json, occurred_at)
     VALUES (?, ?, ?, ?)`,
    [bookmarkId, eventType.trim() || 'used', JSON.stringify(metadata), occurredAt],
  );
  if (['opened', 'asked', 'made', 'project_added', 'reviewed', 'copied'].includes(eventType)) {
    const existing = getActivationProfileFromDb(db, bookmarkId);
    if (existing) {
      db.run(
        `UPDATE bookmark_activation_profiles
         SET last_used_at = ?, updated_at = ? WHERE bookmark_id = ?`,
        [occurredAt, occurredAt, bookmarkId],
      );
    }
  }
  const idRows = db.exec('SELECT last_insert_rowid()');
  return Number(idRows[0]?.values[0]?.[0] ?? 0);
}

export function getBookmarkEnrichmentFromDb(
  db: Database,
  bookmarkId: string,
): BookmarkEnrichment | null {
  ensureActivationSchema(db);
  const rows = db.exec(
    `SELECT bookmark_id, source_hash, version, status, summary, key_claim,
            why_it_matters, suggested_action, entities_json, claims_json,
            freshness_days, fresh_until, engine, enriched_at, error
     FROM bookmark_enrichment WHERE bookmark_id = ? LIMIT 1`,
    [bookmarkId],
  );
  const row = rows[0]?.values[0];
  return row ? rowToEnrichment(row) : null;
}

export function getBookmarkActivationDetailsFromDb(
  db: Database,
  bookmarkId: string,
): Record<string, unknown> {
  ensureActivationSchema(db);
  const projectRows = tableExists(db, 'brain_spaces')
    ? db.exec(
      `SELECT s.id, s.name, COALESCE(s.kind, 'project'), r.role
       FROM project_item_roles r
       JOIN brain_spaces s ON s.id = r.space_id
       WHERE r.bookmark_id = ?
         AND COALESCE(s.status, 'active') != 'archived'
       ORDER BY s.updated_at DESC, s.name COLLATE NOCASE`,
      [bookmarkId],
    )[0]?.values ?? []
    : [];
  const eventRows = db.exec(
    `SELECT id, event_type, metadata_json, occurred_at
     FROM activation_events WHERE bookmark_id = ?
     ORDER BY occurred_at DESC LIMIT 20`,
    [bookmarkId],
  )[0]?.values ?? [];
  return {
    profile: getActivationProfileFromDb(db, bookmarkId),
    enrichment: getBookmarkEnrichmentFromDb(db, bookmarkId),
    projects: projectRows.map((row) => ({
      id: String(row[0]),
      name: String(row[1]),
      kind: String(row[2] ?? 'project'),
      role: String(row[3] ?? 'evidence'),
    })),
    recentEvents: eventRows.map((row) => ({
      id: Number(row[0]),
      type: String(row[1]),
      metadata: (() => {
        try { return JSON.parse(String(row[2] ?? '{}')) as Record<string, unknown>; }
        catch { return {}; }
      })(),
      occurredAt: String(row[3]),
    })),
  };
}

export function attachActivationMetadataFromDb(
  db: Database,
  bookmarks: Array<Record<string, unknown>>,
): void {
  ensureActivationSchema(db);
  if (!bookmarks.length) return;
  const ids = bookmarks.map((bookmark) => String(bookmark.id));
  const placeholders = ids.map(() => '?').join(',');
  const profiles = db.exec(
    `SELECT bookmark_id, intent, why_saved, importance, status, next_review_at,
            last_used_at, created_at, updated_at
     FROM bookmark_activation_profiles WHERE bookmark_id IN (${placeholders})`,
    ids,
  )[0]?.values ?? [];
  const enrichments = db.exec(
    `SELECT bookmark_id, source_hash, version, status, summary, key_claim,
            why_it_matters, suggested_action, entities_json, claims_json,
            freshness_days, fresh_until, engine, enriched_at, error
     FROM bookmark_enrichment WHERE bookmark_id IN (${placeholders})`,
    ids,
  )[0]?.values ?? [];
  const projectCounts = tableExists(db, 'brain_spaces')
    ? db.exec(
      `SELECT r.bookmark_id, COUNT(*)
       FROM project_item_roles r
       JOIN brain_spaces s ON s.id = r.space_id
       WHERE r.bookmark_id IN (${placeholders})
         AND COALESCE(s.status, 'active') = 'active'
       GROUP BY r.bookmark_id`,
      ids,
    )[0]?.values ?? []
    : [];
  const profileMap = new Map(profiles.map((row) => [String(row[0]), rowToProfile(row)]));
  const enrichmentMap = new Map(enrichments.map((row) => [String(row[0]), rowToEnrichment(row)]));
  const projectMap = new Map(projectCounts.map((row) => [String(row[0]), Number(row[1] ?? 0)]));
  for (const bookmark of bookmarks) {
    const id = String(bookmark.id);
    bookmark.activation = {
      profile: profileMap.get(id) ?? null,
      enrichment: enrichmentMap.get(id) ?? null,
      projectCount: projectMap.get(id) ?? 0,
    };
  }
}

interface TodayCandidate {
  id: string;
  author: string;
  category: string;
  capturedAt: string | null;
  note: string;
  intent: BookmarkIntent | null;
  whySaved: string;
  importance: number;
  nextReviewAt: string | null;
  lastUsedAt: string | null;
  status: string;
  freshUntil: string | null;
  projectCount: number;
  isRead: boolean;
  lastShownAt: string | null;
}

function rowToTodayCandidate(row: unknown[]): TodayCandidate {
  return {
    id: String(row[0]),
    author: String(row[1] ?? '').toLowerCase(),
    category: String(row[2] ?? 'unclassified').toLowerCase(),
    capturedAt: typeof row[3] === 'string' ? row[3] : null,
    note: String(row[4] ?? ''),
    intent: isIntent(row[5]) ? row[5] : null,
    whySaved: String(row[6] ?? ''),
    importance: clampImportance(row[7]),
    nextReviewAt: typeof row[8] === 'string' ? row[8] : null,
    lastUsedAt: typeof row[9] === 'string' ? row[9] : null,
    status: String(row[10] ?? 'active'),
    freshUntil: typeof row[11] === 'string' ? row[11] : null,
    projectCount: Number(row[12] ?? 0),
    isRead: Number(row[13] ?? 0) === 1,
    lastShownAt: typeof row[14] === 'string' ? row[14] : null,
  };
}

function loadTodayCandidates(db: Database): TodayCandidate[] {
  const columns = `
    b.id, b.author_handle, b.primary_category,
    COALESCE(b.bookmarked_at, b.posted_at, b.synced_at),
    COALESCE(n.note, ''), p.intent, COALESCE(p.why_saved, ''),
    COALESCE(p.importance, 0), p.next_review_at, p.last_used_at,
    COALESCE(p.status, 'active'), e.fresh_until,
    (SELECT COUNT(*)
     FROM project_item_roles r
     JOIN brain_spaces s ON s.id = r.space_id
     WHERE r.bookmark_id = b.id
       AND COALESCE(s.status, 'active') = 'active'),
    COALESCE(rs.is_read, 0),
    (SELECT MAX(created_at) FROM today_queue tq WHERE tq.bookmark_id = b.id)
  `;
  const joins = `
    LEFT JOIN bookmark_notes n ON n.bookmark_id = b.id
    LEFT JOIN bookmark_activation_profiles p ON p.bookmark_id = b.id
    LEFT JOIN bookmark_enrichment e ON e.bookmark_id = b.id
    LEFT JOIN bookmark_read_status rs ON rs.bookmark_id = b.id
  `;
  const active = db.exec(
    `WITH active_ids AS (
       SELECT bookmark_id AS id FROM bookmark_activation_profiles
       UNION SELECT bookmark_id FROM bookmark_notes
       UNION SELECT bookmark_id FROM project_item_roles
     )
     SELECT ${columns}
     FROM active_ids a
     JOIN bookmarks b ON b.id = a.id
     ${joins}
     ORDER BY COALESCE(p.importance, 0) DESC,
              COALESCE(p.updated_at, n.updated_at, b.synced_at) DESC
     LIMIT 600`,
  )[0]?.values ?? [];
  const recent = db.exec(
    `SELECT ${columns} FROM bookmarks b ${joins}
     ORDER BY b.rowid DESC
     LIMIT 600`,
  )[0]?.values ?? [];
  const forgotten = db.exec(
    `SELECT ${columns} FROM bookmarks b ${joins}
     WHERE LENGTH(COALESCE(b.text, '')) > 80
     ORDER BY b.rowid ASC
     LIMIT 300`,
  )[0]?.values ?? [];
  const unique = new Map<string, TodayCandidate>();
  for (const row of [...active, ...recent, ...forgotten]) {
    const candidate = rowToTodayCandidate(row);
    if (!unique.has(candidate.id)) unique.set(candidate.id, candidate);
  }
  return [...unique.values()];
}

function daysSince(value: string | null, now: number): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, (now - parsed) / DAY_MS) : null;
}

function scoreTodayCandidate(
  candidate: TodayCandidate,
  now: number,
): { score: number; reason: string; breakdown: ScoreComponent[] } | null {
  if (candidate.status === 'done' || candidate.status === 'archived') return null;
  const breakdown: ScoreComponent[] = [];
  const add = (key: string, label: string, points: number) => {
    if (points) breakdown.push({ key, label, points });
  };
  const capturedDays = daysSince(candidate.capturedAt, now);
  const usedDays = daysSince(candidate.lastUsedAt, now);
  const shownDays = daysSince(candidate.lastShownAt, now);
  const reviewDue = candidate.nextReviewAt ? Date.parse(candidate.nextReviewAt) <= now : false;
  const staleClaim = candidate.freshUntil ? Date.parse(candidate.freshUntil) <= now : false;

  if (candidate.intent) add('intent', `Saved to ${candidate.intent}`, 12);
  if (candidate.whySaved) add('why', 'Has your reason for saving', 14);
  add('importance', `Importance ${candidate.importance}/5`, candidate.importance * 4);
  if (candidate.note) add('note', 'Has a personal note', 10);
  if (candidate.projectCount) add('project', 'Supports active work', 14 + Math.min(4, candidate.projectCount));
  if (reviewDue) add('review_due', 'Review is due', 18);
  if (staleClaim) add('stale', 'Claim may need rechecking', 12);
  if (usedDays == null) add('unused', 'Not used since capture', 10);
  else if (usedDays >= 90) add('forgotten', 'Not used in 90+ days', 9);
  else if (usedDays >= 30) add('rested', 'Ready to revisit', 5);
  if (capturedDays != null && capturedDays <= 7) add('new', 'Recently captured', 8);
  else if (capturedDays != null && capturedDays >= 365) add('archive', 'A forgotten archive signal', 6);
  else if (capturedDays != null && capturedDays >= 90) add('older', 'Older signal with new context', 4);
  if (!candidate.isRead) add('unread', 'Still unread', 3);

  if (shownDays != null && shownDays < 7 && !reviewDue && !staleClaim) return null;
  const score = breakdown.reduce((sum, component) => sum + component.points, 0);
  const reason = reviewDue
    ? 'overdue_review'
    : staleClaim
      ? 'stale_claim'
      : candidate.projectCount > 1
        ? 'surprising_connection'
        : candidate.projectCount
          ? 'active_project'
          : capturedDays != null && capturedDays <= 7
            ? 'new_capture'
            : usedDays == null || usedDays >= 90
              ? 'forgotten_gem'
              : 'worth_revisiting';
  return { score, reason, breakdown };
}

export function listTodayQueueFromDb(
  db: Database,
  date = todayKey(),
): TodayQueueItem[] {
  ensureActivationSchema(db);
  const rows = db.exec(
    `SELECT id, queue_date, bookmark_id, reason, score, score_json, status,
            snoozed_until, created_at, acted_at
     FROM today_queue
     WHERE queue_date = ?
       AND (status = 'pending' OR (status = 'snoozed' AND snoozed_until <= ?))
     ORDER BY score DESC, id`,
    [date, nowIso()],
  );
  return (rows[0]?.values ?? []).map(rowToTodayItem);
}

export function generateTodayQueueFromDb(
  db: Database,
  options: { limit?: number; force?: boolean; date?: string } = {},
): TodayQueueItem[] {
  ensureActivationSchema(db);
  const limit = Math.max(1, Math.min(options.limit ?? 7, 20));
  const date = options.date || todayKey();
  if (options.force) {
    db.run(`DELETE FROM today_queue WHERE queue_date = ? AND status = 'pending'`, [date]);
  }
  let existing = listTodayQueueFromDb(db, date);
  if (existing.length >= limit) return existing.slice(0, limit);
  const existingIds = new Set(
    (db.exec('SELECT bookmark_id FROM today_queue WHERE queue_date = ?', [date])[0]?.values ?? [])
      .map((row) => String(row[0])),
  );
  const now = Date.now();
  const scored = loadTodayCandidates(db)
    .filter((candidate) => !existingIds.has(candidate.id))
    .flatMap((candidate) => {
      const result = scoreTodayCandidate(candidate, now);
      return result ? [{ candidate, ...result }] : [];
    })
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
  const authorCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const reasonCounts = new Map<string, number>();
  const selected: typeof scored = [];
  const selectedIds = new Set<string>();
  const trySelect = (entry: typeof scored[number], enforceReasonDiversity: boolean): boolean => {
    const author = entry.candidate.author || 'unknown';
    const category = entry.candidate.category || 'unclassified';
    const categoryIsMeaningful = category !== 'unclassified' && category !== 'unknown';
    if (
      (authorCounts.get(author) ?? 0) >= 2
      || (categoryIsMeaningful && (categoryCounts.get(category) ?? 0) >= 3)
      || (enforceReasonDiversity && (reasonCounts.get(entry.reason) ?? 0) >= 2)
    ) return false;
    selected.push(entry);
    selectedIds.add(entry.candidate.id);
    authorCounts.set(author, (authorCounts.get(author) ?? 0) + 1);
    if (categoryIsMeaningful) {
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }
    reasonCounts.set(entry.reason, (reasonCounts.get(entry.reason) ?? 0) + 1);
    return true;
  };
  const needed = limit - existing.length;
  for (const entry of scored) {
    trySelect(entry, true);
    if (selected.length >= needed) break;
  }
  if (selected.length < needed) {
    for (const entry of scored) {
      if (selectedIds.has(entry.candidate.id)) continue;
      trySelect(entry, false);
      if (selected.length >= needed) break;
    }
  }
  const createdAt = nowIso();
  for (const entry of selected) {
    db.run(
      `INSERT OR IGNORE INTO today_queue (
         queue_date, bookmark_id, reason, score, score_json, status, created_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [
        date,
        entry.candidate.id,
        entry.reason,
        entry.score,
        JSON.stringify(entry.breakdown),
        createdAt,
      ],
    );
  }
  existing = listTodayQueueFromDb(db, date);
  return existing.slice(0, limit);
}

export function updateTodayQueueItemFromDb(
  db: Database,
  id: number,
  action: 'done' | 'dismiss' | 'snooze',
  snoozedUntil?: string | null,
): TodayQueueItem | null {
  ensureActivationSchema(db);
  const currentRows = db.exec(
    `SELECT id, queue_date, bookmark_id, reason, score, score_json, status,
            snoozed_until, created_at, acted_at
     FROM today_queue WHERE id = ? LIMIT 1`,
    [id],
  );
  const currentRow = currentRows[0]?.values[0];
  if (!currentRow) return null;
  const current = rowToTodayItem(currentRow);
  const status: TodayQueueStatus = action === 'dismiss'
    ? 'dismissed'
    : action === 'snooze'
      ? 'snoozed'
      : 'done';
  const actedAt = nowIso();
  const snooze = status === 'snoozed'
    ? snoozedUntil || new Date(Date.now() + 7 * DAY_MS).toISOString()
    : null;
  db.run(
    `UPDATE today_queue SET status = ?, snoozed_until = ?, acted_at = ? WHERE id = ?`,
    [status, snooze, actedAt, id],
  );
  recordActivationEventFromDb(db, current.bookmarkId, `today_${action}`, { queueId: id });
  const updatedRows = db.exec(
    `SELECT id, queue_date, bookmark_id, reason, score, score_json, status,
            snoozed_until, created_at, acted_at
     FROM today_queue WHERE id = ? LIMIT 1`,
    [id],
  );
  const updated = updatedRows[0]?.values[0];
  return updated ? rowToTodayItem(updated) : null;
}

function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateAtWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const slice = value.slice(0, max + 1);
  const boundary = slice.lastIndexOf(' ');
  return `${slice.slice(0, boundary > max * 0.65 ? boundary : max).trim()}...`;
}

function meaningfulSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\s+[•·]\s+|\n+/)
    .map(cleanText)
    .filter((sentence) => sentence.length >= 35 && !sentence.endsWith('?'))
    .slice(0, 5);
}

function extractEntities(text: string, author: string, domains: string[]): string[] {
  const entities = new Set<string>();
  if (author) entities.add(author.replace(/^@/, ''));
  for (const match of text.matchAll(/@([A-Za-z0-9_]{2,30})/g)) entities.add(match[1]);
  for (const match of text.matchAll(/#([A-Za-z][A-Za-z0-9_-]{2,40})/g)) entities.add(match[1]);
  for (const domain of domains) if (domain) entities.add(domain);
  return [...entities].slice(0, 12);
}

function classifyFreshness(text: string): number {
  if (/\b(today|now|new|launch(?:ed)?|release(?:d)?|breaking|price|model|version|update)\b/i.test(text)) return 30;
  if (/\b(research|paper|study|benchmark|report|forecast|prediction)\b/i.test(text)) return 180;
  if (/\b(guide|tutorial|how to|workflow|framework|playbook)\b/i.test(text)) return 365;
  return 540;
}

function suggestedAction(intent: BookmarkIntent | null, hasProject: boolean): string {
  if (hasProject) return 'Review this against the next decision or deliverable in its project.';
  switch (intent) {
    case 'build': return 'Turn the useful mechanism into a small implementation task.';
    case 'try': return 'Run a short experiment and record what happened.';
    case 'research': return 'Verify the central claim against another source.';
    case 'contact': return 'Draft a specific reason to reach out.';
    case 'buy': return 'Compare the promise, cost, and switching risk before deciding.';
    case 'learn': return 'Explain the idea in your own words, then link it to something you know.';
    case 'inspiration': return 'Extract the reusable pattern instead of saving only the example.';
    default: return 'Add a note explaining when this reference should be useful.';
  }
}

function whyItMatters(
  intent: BookmarkIntent | null,
  category: string,
  hasProject: boolean,
): string {
  if (hasProject) return 'This is connected to active work, so its value depends on whether it changes a decision or next action.';
  if (intent) return `You saved this to ${intent}; preserving the reason and a next action makes it retrievable when that intent returns.`;
  if (category && category !== 'unclassified') return `This adds a concrete signal to your ${category} knowledge, but it still needs your own interpretation.`;
  return 'This may be useful later, but it becomes durable knowledge only after you connect it to a goal, question, or decision.';
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value.toLowerCase().match(/[a-z0-9]{4,}/g)?.filter((token) =>
      !['that', 'this', 'with', 'from', 'have', 'will', 'your', 'they', 'about'].includes(token)
    ) ?? [],
  );
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let common = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) common++;
  return common / Math.min(leftTokens.size, rightTokens.size);
}

function claimPolarity(value: string): 'positive' | 'negative' | 'neutral' {
  if (/\b(no|not|never|without|cannot|can't|won't|failed|decline|drop)\b/i.test(value)) return 'negative';
  if (/\b(is|are|will|can|has|have|grew|increase|improve|launch)\b/i.test(value)) return 'positive';
  return 'neutral';
}

export function runBrainCycleFromDb(
  db: Database,
  options: { budget?: number; bookmarkIds?: string[]; force?: boolean } = {},
): BrainCycleResult {
  ensureActivationSchema(db);
  const bookmarkIds = [...new Set(
    (options.bookmarkIds ?? []).map((id) => String(id).trim()).filter(Boolean),
  )].slice(0, 5000);
  const budget = Math.max(1, Math.min(options.budget ?? (bookmarkIds.length || 75), 5000));
  const startedAt = nowIso();
  db.run(
    `INSERT INTO activation_cycle_runs (status, started_at)
     VALUES ('running', ?)`,
    [startedAt],
  );
  const runId = Number(db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] ?? 0);
  const savepoint = `brain_cycle_${runId}`;
  let processed = 0;
  let enriched = 0;
  let claimsCreated = 0;
  let relationsCreated = 0;

  db.run(`SAVEPOINT ${savepoint}`);
  try {
    const freshnessClause = options.force
      ? '1 = 1'
      : `(e.bookmark_id IS NULL OR (b.source_hash IS NOT NULL AND e.source_hash != b.source_hash))`;
    const targetClause = bookmarkIds.length
      ? `b.id IN (${bookmarkIds.map(() => '?').join(',')}) AND`
      : '';
    const rows = db.exec(
      `SELECT
         b.id, b.text, b.author_handle, b.primary_category, b.domains,
         b.url, COALESCE(b.bookmarked_at, b.posted_at, b.synced_at),
         COALESCE(b.source_hash, ''), p.intent,
         EXISTS (
           SELECT 1
           FROM project_item_roles r
           JOIN brain_spaces s ON s.id = r.space_id
           WHERE r.bookmark_id = b.id
             AND COALESCE(s.status, 'active') = 'active'
         )
       FROM bookmarks b
       LEFT JOIN bookmark_enrichment e ON e.bookmark_id = b.id
       LEFT JOIN bookmark_activation_profiles p ON p.bookmark_id = b.id
       WHERE ${targetClause} ${freshnessClause}
       ORDER BY b.rowid DESC
       LIMIT ?`,
      [...bookmarkIds, budget],
    )[0]?.values ?? [];

    for (const row of rows) {
      processed++;
      const bookmarkId = String(row[0]);
      const text = cleanText(row[1]);
      const author = String(row[2] ?? '');
      const category = String(row[3] ?? 'unclassified');
      const domains = typeof row[4] === 'string'
        ? row[4].split(',').map((entry) => entry.trim()).filter(Boolean)
        : [];
      const sourceUrl = String(row[5] ?? '');
      const capturedAt = String(row[6] ?? startedAt);
      const storedHash = String(row[7] ?? '');
      const sourceHash = storedHash || crypto
        .createHash('sha256')
        .update(`${text}\n${sourceUrl}`)
        .digest('hex');
      const intent = isIntent(row[8]) ? row[8] : null;
      const hasProject = Number(row[9] ?? 0) === 1;
      const sentences = meaningfulSentences(text);
      const summary = truncateAtWord(sentences.slice(0, 2).join(' ') || text || sourceUrl, 320);
      const keyClaim = truncateAtWord(sentences[0] || text || 'This source has no extractable text yet.', 220);
      const entities = extractEntities(text, author, domains);
      const claims = sentences.slice(0, 3).map((sentence) => truncateAtWord(sentence, 280));
      const freshnessDays = classifyFreshness(text);
      const capturedMs = Date.parse(capturedAt);
      const freshUntil = new Date(
        (Number.isFinite(capturedMs) ? capturedMs : Date.now()) + freshnessDays * DAY_MS,
      ).toISOString();
      const enrichedAt = nowIso();

      db.run(
        `INSERT INTO bookmark_enrichment (
           bookmark_id, source_hash, version, status, summary, key_claim,
           why_it_matters, suggested_action, entities_json, claims_json,
           freshness_days, fresh_until, engine, enriched_at, error
         ) VALUES (?, ?, 1, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, 'local-rules', ?, NULL)
         ON CONFLICT(bookmark_id) DO UPDATE SET
           source_hash = excluded.source_hash,
           version = bookmark_enrichment.version + 1,
           status = excluded.status,
           summary = excluded.summary,
           key_claim = excluded.key_claim,
           why_it_matters = excluded.why_it_matters,
           suggested_action = excluded.suggested_action,
           entities_json = excluded.entities_json,
           claims_json = excluded.claims_json,
           freshness_days = excluded.freshness_days,
           fresh_until = excluded.fresh_until,
           engine = excluded.engine,
           enriched_at = excluded.enriched_at,
           error = NULL`,
        [
          bookmarkId,
          sourceHash,
          summary,
          keyClaim,
          whyItMatters(intent, category, hasProject),
          suggestedAction(intent, hasProject),
          JSON.stringify(entities),
          JSON.stringify(claims),
          freshnessDays,
          freshUntil,
          enrichedAt,
        ],
      );
      db.run(
        `DELETE FROM activation_claim_relations
         WHERE left_claim_id IN (
             SELECT id FROM activation_claims WHERE bookmark_id = ?
           )
            OR right_claim_id IN (
             SELECT id FROM activation_claims WHERE bookmark_id = ?
           )`,
        [bookmarkId, bookmarkId],
      );
      db.run('DELETE FROM activation_claims WHERE bookmark_id = ?', [bookmarkId]);
      for (const claim of claims) {
        const entityKey = (entities[0] || author || category || '').toLowerCase() || null;
        const polarity = claimPolarity(claim);
        db.run(
          `INSERT INTO activation_claims (
             bookmark_id, claim_text, entity_key, polarity, claim_type,
             source_url, captured_at, fresh_until, created_at
           ) VALUES (?, ?, ?, ?, 'observation', ?, ?, ?, ?)`,
          [bookmarkId, claim, entityKey, polarity, sourceUrl, capturedAt, freshUntil, enrichedAt],
        );
        const claimId = Number(db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] ?? 0);
        claimsCreated++;
        if (entityKey) {
          const related = db.exec(
            `SELECT id, claim_text, polarity
             FROM activation_claims
             WHERE entity_key = ? AND bookmark_id != ? AND id != ?
             ORDER BY captured_at DESC LIMIT 40`,
            [entityKey, bookmarkId, claimId],
          )[0]?.values ?? [];
          for (const prior of related) {
            const priorPolarity = String(prior[2] ?? 'neutral');
            if (
              polarity === 'neutral'
              || priorPolarity === 'neutral'
              || polarity === priorPolarity
              || tokenOverlap(claim, String(prior[1] ?? '')) < 0.55
            ) continue;
            const left = Math.min(claimId, Number(prior[0]));
            const right = Math.max(claimId, Number(prior[0]));
            db.run(
              `INSERT OR IGNORE INTO activation_claim_relations (
                 left_claim_id, right_claim_id, relation, confidence, reason, created_at
               ) VALUES (?, ?, 'contradiction', 0.72, ?, ?)`,
              [left, right, `Opposing statements about ${entityKey}`, enrichedAt],
            );
            const changed = Number(db.exec('SELECT changes()')[0]?.values[0]?.[0] ?? 0);
            relationsCreated += changed;
          }
        }
      }
      enriched++;
    }

    const finishedAt = nowIso();
    const pendingAfter = brainCyclePendingCountFromDb(db);
    const summary = processed
      ? `Enriched ${enriched} bookmarks and extracted ${claimsCreated} claims. ${pendingAfter} pending.`
      : 'Knowledge enrichment is already current.';
    db.run(
      `UPDATE activation_cycle_runs
       SET status = 'success', finished_at = ?, processed = ?, enriched = ?,
           claims_created = ?, relations_created = ?, pending_after = ?, summary = ?
       WHERE id = ?`,
      [finishedAt, processed, enriched, claimsCreated, relationsCreated, pendingAfter, summary, runId],
    );
    db.run(`RELEASE SAVEPOINT ${savepoint}`);
    return {
      id: runId,
      status: 'success',
      startedAt,
      finishedAt,
      processed,
      enriched,
      claimsCreated,
      relationsCreated,
      pendingAfter,
      summary,
      error: null,
    };
  } catch (error) {
    db.run(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.run(`RELEASE SAVEPOINT ${savepoint}`);
    const finishedAt = nowIso();
    const message = error instanceof Error ? error.message : String(error);
    db.run(
      `UPDATE activation_cycle_runs
       SET status = 'error', finished_at = ?, processed = ?, enriched = ?,
           claims_created = ?, relations_created = ?, error = ?
       WHERE id = ?`,
      [finishedAt, processed, 0, 0, 0, message, runId],
    );
    throw error;
  }
}

export function getBrainCycleStatusFromDb(db: Database): Record<string, unknown> {
  ensureActivationSchema(db);
  const latestRows = db.exec(
    `SELECT id, status, started_at, finished_at, processed, enriched,
            claims_created, relations_created, pending_after, summary, error
     FROM activation_cycle_runs ORDER BY id DESC LIMIT 1`,
  );
  const latest = latestRows[0]?.values[0];
  const count = (sql: string, params: Array<string | number | null> = []) =>
    Number(db.exec(sql, params)[0]?.values[0]?.[0] ?? 0);
  return {
    latest: latest ? {
      id: Number(latest[0]),
      status: String(latest[1]),
      startedAt: String(latest[2]),
      finishedAt: typeof latest[3] === 'string' ? latest[3] : null,
      processed: Number(latest[4] ?? 0),
      enriched: Number(latest[5] ?? 0),
      claimsCreated: Number(latest[6] ?? 0),
      relationsCreated: Number(latest[7] ?? 0),
      pendingAfter: typeof latest[8] === 'number' ? Number(latest[8]) : null,
      summary: String(latest[9] ?? ''),
      error: typeof latest[10] === 'string' ? latest[10] : null,
    } : null,
    enriched: count('SELECT COUNT(*) FROM bookmark_enrichment WHERE status = ?', ['ready']),
    pending: brainCyclePendingCountFromDb(db),
    staleClaims: count(
      `SELECT COUNT(*) FROM activation_claims
       WHERE fresh_until IS NOT NULL AND fresh_until <= ?`,
      [nowIso()],
    ),
    candidateContradictions: count(
      `SELECT COUNT(*) FROM activation_claim_relations WHERE status = 'candidate'`,
    ),
  };
}

export function brainCyclePendingCountFromDb(db: Database): number {
  ensureActivationSchema(db);
  return Number(db.exec(
    `SELECT COUNT(*) FROM bookmarks b
     LEFT JOIN bookmark_enrichment e ON e.bookmark_id = b.id
     WHERE e.bookmark_id IS NULL
        OR (b.source_hash IS NOT NULL AND e.source_hash != b.source_hash)`,
  )[0]?.values[0]?.[0] ?? 0);
}

export function brainCycleBacklogPendingFromDb(db: Database): boolean {
  ensureActivationSchema(db);
  const rows = db.exec(
    `SELECT pending_after FROM activation_cycle_runs
     WHERE status = 'success' ORDER BY id DESC LIMIT 1`,
  );
  const pendingAfter = rows[0]?.values[0]?.[0];
  if (typeof pendingAfter === 'number') return pendingAfter > 0;
  return Boolean(rows[0]?.values.length) && brainCyclePendingCountFromDb(db) > 0;
}

export function brainCycleDueFromDb(db: Database, hours = 20): boolean {
  ensureActivationSchema(db);
  const rows = db.exec(
    `SELECT finished_at FROM activation_cycle_runs
     WHERE status = 'success' ORDER BY id DESC LIMIT 1`,
  );
  const finishedAt = rows[0]?.values[0]?.[0];
  if (typeof finishedAt !== 'string') return true;
  const parsed = Date.parse(finishedAt);
  return !Number.isFinite(parsed) || Date.now() - parsed >= hours * 60 * 60 * 1000;
}

export function addBookmarkToProjectFromDb(
  db: Database,
  bookmarkId: string,
  spaceId: string,
  role: ProjectItemRole = 'evidence',
): void {
  ensureActivationSchema(db);
  if (!tableExists(db, 'brain_space_bookmarks') || !tableExists(db, 'brain_spaces')) {
    throw new Error('Project workspace tables are unavailable.');
  }
  const bookmarkExists = db.exec('SELECT 1 FROM bookmarks WHERE id = ? LIMIT 1', [bookmarkId]);
  if (!bookmarkExists[0]?.values.length) throw new Error(`Bookmark not found: ${bookmarkId}`);
  const spaceExists = db.exec('SELECT 1 FROM brain_spaces WHERE id = ? LIMIT 1', [spaceId]);
  if (!spaceExists[0]?.values.length) throw new Error(`Project not found: ${spaceId}`);
  const now = nowIso();
  db.run(
    `INSERT OR IGNORE INTO brain_space_bookmarks
       (space_id, bookmark_id, source, score, added_at)
     VALUES (?, ?, 'manual', 1, ?)`,
    [spaceId, bookmarkId, now],
  );
  db.run(
    `INSERT INTO project_item_roles (space_id, bookmark_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(space_id, bookmark_id) DO UPDATE SET
       role = excluded.role, updated_at = excluded.updated_at`,
    [spaceId, bookmarkId, role, now, now],
  );
  recordActivationEventFromDb(db, bookmarkId, 'project_added', { spaceId, role });
}

export function removeBookmarkFromProjectFromDb(
  db: Database,
  bookmarkId: string,
  spaceId: string,
): void {
  ensureActivationSchema(db);
  db.run('DELETE FROM project_item_roles WHERE space_id = ? AND bookmark_id = ?', [spaceId, bookmarkId]);
  if (tableExists(db, 'brain_space_bookmarks')) {
    db.run('DELETE FROM brain_space_bookmarks WHERE space_id = ? AND bookmark_id = ?', [spaceId, bookmarkId]);
  }
  recordActivationEventFromDb(db, bookmarkId, 'project_removed', { spaceId });
}

function topCountRows(
  db: Database,
  sql: string,
  params: Array<string | number | null>,
): Array<{ name: string; count: number }> {
  return (db.exec(sql, params)[0]?.values ?? []).map((row) => ({
    name: String(row[0]),
    count: Number(row[1] ?? 0),
  }));
}

export function getAuthorDossierFromDb(db: Database, rawHandle: string): AuthorDossier | null {
  ensureActivationSchema(db);
  const handle = rawHandle.trim().replace(/^@/, '');
  if (!handle) return null;
  const authorRows = db.exec(
    `SELECT author_handle, MAX(author_name), MAX(author_profile_image_url), COUNT(*)
     FROM bookmarks
     WHERE lower(author_handle) = lower(?)
     GROUP BY author_handle LIMIT 1`,
    [handle],
  );
  const author = authorRows[0]?.values[0];
  if (!author) return null;
  const canonicalHandle = String(author[0]);
  const baseParams = [canonicalHandle];
  const scalar = (sql: string) => Number(db.exec(sql, baseParams)[0]?.values[0]?.[0] ?? 0);
  const categories = topCountRows(
    db,
    `SELECT COALESCE(primary_category, 'unclassified'), COUNT(*)
     FROM bookmarks WHERE author_handle = ?
     GROUP BY COALESCE(primary_category, 'unclassified')
     ORDER BY COUNT(*) DESC LIMIT 8`,
    baseParams,
  );
  const domains = topCountRows(
    db,
    `SELECT primary_domain, COUNT(*)
     FROM bookmarks WHERE author_handle = ? AND primary_domain IS NOT NULL
     GROUP BY primary_domain ORDER BY COUNT(*) DESC LIMIT 8`,
    baseParams,
  );
  const timeline = (db.exec(
    `SELECT substr(COALESCE(bookmarked_at, posted_at, synced_at), 1, 7), COUNT(*)
     FROM bookmarks WHERE author_handle = ?
     GROUP BY 1 ORDER BY 1 DESC LIMIT 18`,
    baseParams,
  )[0]?.values ?? []).map((row) => ({
    month: String(row[0] ?? 'unknown'),
    count: Number(row[1] ?? 0),
  })).reverse();
  const projects = tableExists(db, 'brain_spaces')
    ? (db.exec(
      `SELECT s.id, s.name, COALESCE(s.kind, 'project'), COUNT(*)
       FROM project_item_roles r
       JOIN bookmarks b ON b.id = r.bookmark_id
       JOIN brain_spaces s ON s.id = r.space_id
       WHERE b.author_handle = ?
         AND COALESCE(s.status, 'active') != 'archived'
       GROUP BY s.id, s.name, s.kind
       ORDER BY COUNT(*) DESC, s.name LIMIT 12`,
      baseParams,
    )[0]?.values ?? []).map((row) => ({
      id: String(row[0]),
      name: String(row[1]),
      kind: String(row[2] ?? 'project'),
      count: Number(row[3] ?? 0),
    }))
    : [];
  const claims = (db.exec(
    `SELECT c.id, c.bookmark_id, c.claim_text, c.claim_type, c.captured_at,
            c.fresh_until, c.source_url
     FROM activation_claims c
     JOIN bookmarks b ON b.id = c.bookmark_id
     WHERE b.author_handle = ?
     ORDER BY c.captured_at DESC LIMIT 24`,
    baseParams,
  )[0]?.values ?? []).map((row) => ({
    id: Number(row[0]),
    bookmarkId: String(row[1]),
    text: String(row[2]),
    type: String(row[3]),
    capturedAt: String(row[4]),
    freshUntil: typeof row[5] === 'string' ? row[5] : null,
    sourceUrl: String(row[6] ?? ''),
  }));
  const recentSignals = (db.exec(
    `SELECT b.id, b.url, b.text, b.posted_at, b.bookmarked_at,
            b.primary_category, e.summary, e.key_claim, e.why_it_matters
     FROM bookmarks b
     LEFT JOIN bookmark_enrichment e ON e.bookmark_id = b.id
     WHERE b.author_handle = ?
     ORDER BY COALESCE(b.bookmarked_at, b.posted_at, b.synced_at) DESC
     LIMIT 20`,
    baseParams,
  )[0]?.values ?? []).map((row) => ({
    id: String(row[0]),
    url: String(row[1] ?? ''),
    text: String(row[2] ?? ''),
    postedAt: typeof row[3] === 'string' ? row[3] : null,
    bookmarkedAt: typeof row[4] === 'string' ? row[4] : null,
    category: String(row[5] ?? 'unclassified'),
    summary: String(row[6] ?? ''),
    keyClaim: String(row[7] ?? ''),
    whyItMatters: String(row[8] ?? ''),
  }));

  return {
    author: {
      handle: canonicalHandle,
      name: String(author[1] ?? canonicalHandle),
      profileImageUrl: typeof author[2] === 'string' ? author[2] : null,
    },
    totals: {
      bookmarks: Number(author[3] ?? 0),
      unread: scalar(
        `SELECT COUNT(*) FROM bookmarks b
         WHERE b.author_handle = ?
           AND b.id NOT IN (
             SELECT bookmark_id FROM bookmark_read_status WHERE is_read = 1
           )`,
      ),
      notes: scalar(
        `SELECT COUNT(*) FROM bookmark_notes n
         JOIN bookmarks b ON b.id = n.bookmark_id
         WHERE b.author_handle = ? AND LENGTH(trim(n.note)) > 0`,
      ),
      enriched: scalar(
        `SELECT COUNT(*) FROM bookmark_enrichment e
         JOIN bookmarks b ON b.id = e.bookmark_id
         WHERE b.author_handle = ? AND e.status = 'ready'`,
      ),
    },
    categories,
    domains,
    timeline,
    projects,
    claims,
    recentSignals,
  };
}

export function deleteBookmarkActivationFromDb(db: Database, bookmarkId: string): void {
  ensureActivationSchema(db);
  db.run(
    `DELETE FROM activation_claim_relations
     WHERE left_claim_id IN (SELECT id FROM activation_claims WHERE bookmark_id = ?)
        OR right_claim_id IN (SELECT id FROM activation_claims WHERE bookmark_id = ?)`,
    [bookmarkId, bookmarkId],
  );
  db.run('DELETE FROM activation_claims WHERE bookmark_id = ?', [bookmarkId]);
  db.run('DELETE FROM bookmark_enrichment WHERE bookmark_id = ?', [bookmarkId]);
  db.run('DELETE FROM activation_events WHERE bookmark_id = ?', [bookmarkId]);
  db.run('DELETE FROM bookmark_activation_profiles WHERE bookmark_id = ?', [bookmarkId]);
  db.run('DELETE FROM today_queue WHERE bookmark_id = ?', [bookmarkId]);
  db.run('DELETE FROM project_item_roles WHERE bookmark_id = ?', [bookmarkId]);
}
