import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, saveDb } from './db.js';
import { ensureDir, pathExists, readMd, writeMd } from './fs.js';
import { mdDir, twitterBookmarksIndexPath } from './paths.js';
import type { Database } from 'sql.js';
import type { KnowledgeItem, KnowledgeItemKind, KnowledgeTopic } from './types.js';

export type BrainAgentType = 'repo_watcher' | 'research_scout' | 'memory_curator';
export type BrainWorkflowId = 'capture' | 'distill' | 'connect' | 'watch' | 'review' | 'repair' | 'publish';
export type BrainSpaceKind = 'project' | 'question' | 'dossier' | 'topic';
export type BrainSpaceStatus = 'active' | 'incubating' | 'complete' | 'archived';

export interface BrainSpaceInput {
  name: string;
  description?: string;
  keywords?: string[];
  category?: string | null;
  domain?: string | null;
  collection?: string | null;
  kind?: BrainSpaceKind;
  status?: BrainSpaceStatus;
  focusQuestion?: string;
}

export interface BrainSpace {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  category: string | null;
  domain: string | null;
  collection: string | null;
  kind: BrainSpaceKind;
  status: BrainSpaceStatus;
  focusQuestion: string;
  createdAt: string;
  updatedAt: string;
  lastSeededAt: string | null;
  lastAgentRunAt: string | null;
  pagePath: string;
  bookmarkCount: number;
  repoCount: number;
  openFindings: number;
}

export interface BrainRepoInput {
  repo: string;
  source?: string;
}

export interface BrainRepo {
  spaceId: string;
  repo: string;
  owner: string;
  name: string;
  source: string;
  createdAt: string;
  lastCheckedAt: string | null;
  lastReleaseId: string | null;
  lastCommitSha: string | null;
  description: string;
  htmlUrl: string;
  homepage: string;
  stars: number;
  openIssues: number;
  defaultBranch: string;
  topics: string[];
  readmeExcerpt: string;
  latestReleaseName: string;
  latestReleaseUrl: string;
  latestCommitTitle: string;
  latestCommitUrl: string;
  latestCommitAuthor: string;
  latestCommitAt: string | null;
  recommendedAction: string;
}

export interface BrainRepoIntelligence {
  description: string;
  htmlUrl: string;
  homepage: string;
  stars: number;
  openIssues: number;
  defaultBranch: string;
  topics: string[];
  readmeExcerpt: string;
  latestReleaseName: string;
  latestReleaseUrl: string;
  latestCommitTitle: string;
  latestCommitUrl: string;
  latestCommitAuthor: string;
  latestCommitAt: string | null;
  recommendedAction: string;
}

export interface BrainFinding {
  id: number;
  runId: number;
  spaceId: string;
  spaceName?: string;
  agentType: BrainAgentType;
  findingType: string;
  title: string;
  url: string | null;
  detail: string;
  severity: 'info' | 'warning' | 'error';
  createdAt: string;
  resolved: boolean;
  decision: 'open' | 'accepted' | 'dismissed';
  decisionNote: string;
  decidedAt: string | null;
}

export interface BrainFindingDecisionInput {
  decision: 'accepted' | 'dismissed';
  title?: string;
  detail?: string;
  note?: string;
}

export interface BrainRun {
  id: number;
  spaceId: string | null;
  spaceName?: string;
  agentType: BrainAgentType | 'all';
  status: 'running' | 'success' | 'error';
  startedAt: string;
  finishedAt: string | null;
  summary: string;
  error: string | null;
}

export interface BrainSeedResult {
  space: BrainSpace;
  matched: number;
  added: number;
}

export interface BrainSpaceDuplicateGroup {
  canonicalId: string;
  duplicateIds: string[];
}

export interface BrainDashboard {
  spaces: BrainSpace[];
  recentRuns: BrainRun[];
  findings: BrainFinding[];
  staleSpaces: BrainSpace[];
  repoCount: number;
  memory: BrainMemoryOverview;
  workflows: BrainWorkflow[];
}

export interface BrainArtifact {
  id: string;
  sourceType: string;
  sourceId: string;
  spaceId: string | null;
  spaceName?: string;
  title: string;
  url: string | null;
  body: string;
  author: string;
  sourceLabel: string;
  capturedAt: string;
  updatedAt: string;
  confidence: number;
}

export interface BrainMemoryOverview {
  artifactCount: number;
  entityCount: number;
  edgeCount: number;
  claimCount: number;
  timelineCount: number;
  recentArtifacts: BrainArtifact[];
  topEntities: Array<{ name: string; kind: string; mentions: number }>;
}

export interface BrainWorkspaceBrief {
  understanding: WorkingUnderstanding[];
  overview: string;
  keyIdeas: Array<{
    bookmarkId: string;
    title: string;
    detail: string;
    whyItMatters: string;
    author: string;
    url: string | null;
  }>;
  nextActions: Array<{
    action: string;
    bookmarkId: string;
    sourceTitle: string;
    url: string | null;
  }>;
  openQuestions: Array<{
    title: string;
    detail: string;
    severity: BrainFinding['severity'];
    url: string | null;
  }>;
  practice: {
    bookmarkId: string;
    cue: string;
    answer: string;
    applicationPrompt: string;
    whyItMatters: string;
    author: string;
    url: string | null;
  } | null;
  recentEvidence: BrainArtifact[];
}

export function diversifyBrainIdeas<T extends { author: string }>(
  ideas: T[],
  limit = 6,
  maxPerAuthor = 2,
): T[] {
  const counts = new Map<string, number>();
  const selected: T[] = [];
  for (const idea of ideas) {
    const author = idea.author.trim().toLowerCase().replace(/^@/, '') || 'unknown';
    if ((counts.get(author) ?? 0) >= maxPerAuthor) continue;
    selected.push(idea);
    counts.set(author, (counts.get(author) ?? 0) + 1);
    if (selected.length >= limit) break;
  }
  if (selected.length < limit) {
    for (const idea of ideas) {
      if (selected.includes(idea)) continue;
      selected.push(idea);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

function displayBrainTerm(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'gbrain') return 'GBrain';
  if (normalized === 'gstack') return 'GStack';
  if (normalized === 'autoresearch') return 'Autoresearch';
  return value.trim().replace(/\b\w/g, (character) => character.toUpperCase());
}

export interface BrainWorkflow {
  id: BrainWorkflowId;
  name: string;
  description: string;
  buttonLabel: string;
  icon: string;
  lastRunAt: string | null;
}

export interface BrainWorkflowRun {
  id: number;
  workflowId: BrainWorkflowId;
  spaceId: string | null;
  status: 'running' | 'success' | 'error';
  startedAt: string;
  finishedAt: string | null;
  summary: string;
  changedCount: number;
  error: string | null;
}

interface BookmarkSeedCandidate {
  id: string;
  text: string;
  url: string;
  authorHandle: string;
  authorName: string;
  categories: string[];
  domains: string[];
  links: string[];
  githubUrls: string[];
  collections: string[];
}

const MANAGED_START = '<!-- xb:managed:start brain-summary -->';
const MANAGED_END = '<!-- xb:managed:end brain-summary -->';

const BRAIN_WORKFLOWS: Array<Omit<BrainWorkflow, 'lastRunAt'>> = [
  {
    id: 'capture',
    name: 'Capture',
    description: 'Turn new bookmarks, X Feed items, and notes into memory cards.',
    buttonLabel: 'Clean up new saves',
    icon: 'inbox',
  },
  {
    id: 'distill',
    name: 'Distill',
    description: 'Pull out summaries, claims, and useful source snippets.',
    buttonLabel: 'Distill sources',
    icon: 'sparkles',
  },
  {
    id: 'connect',
    name: 'Connect',
    description: 'Find people, repos, topics, and related items across your Brain.',
    buttonLabel: 'Find connections',
    icon: 'network',
  },
  {
    id: 'watch',
    name: 'Watch',
    description: 'Check watched GitHub projects and discovery sources.',
    buttonLabel: 'Update watchlists',
    icon: 'radar',
  },
  {
    id: 'review',
    name: 'Review',
    description: 'Find stale topics, empty spaces, and open questions.',
    buttonLabel: 'Review weak spots',
    icon: 'clock-3',
  },
  {
    id: 'repair',
    name: 'Repair',
    description: 'Surface missing media, thin cards, and sources that need attention.',
    buttonLabel: 'Repair memory',
    icon: 'wrench',
  },
  {
    id: 'publish',
    name: 'Publish',
    description: 'Refresh generated markdown pages without touching manual notes.',
    buttonLabel: 'Update pages',
    icon: 'folder',
  },
];

function nowIso(): string {
  return new Date().toISOString();
}

function stableId(...parts: Array<string | number | null | undefined>): string {
  return crypto.createHash('sha1').update(parts.map((part) => String(part ?? '')).join('\u001f')).digest('hex').slice(0, 24);
}

function tableExists(db: Database, table: string): boolean {
  const rows = db.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`, [table]);
  return Boolean(rows[0]?.values?.length);
}

function firstSentence(text: string, fallback = 'Memory card'): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  const sentence = cleaned.match(/^(.{24,180}?[.!?])\s/)?.[1] ?? cleaned.slice(0, 120);
  return sentence.length < cleaned.length ? `${sentence.replace(/[.!?]$/, '')}...` : sentence;
}

function splitClaims(text: string): string[] {
  return [...new Set(
    text
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((claim) => claim.trim())
      .filter((claim) => claim.length >= 48 && claim.length <= 260)
      .slice(0, 4),
  )];
}

function extractEntities(text: string, url?: string | null, domains: string[] = [], githubUrls: string[] = []): Array<{ name: string; kind: string }> {
  const found = new Map<string, { name: string; kind: string }>();
  const add = (name: string, kind: string) => {
    const clean = name.trim().replace(/^@/, '');
    if (!clean || clean.length < 2) return;
    found.set(`${kind}:${clean.toLowerCase()}`, { name: clean, kind });
  };

  for (const match of text.matchAll(/@([A-Za-z0-9_]{2,20})/g)) add(match[1], 'person');
  for (const link of githubUrls) {
    const repo = parseGitHubRepo(link);
    if (repo) add(repo.repo, 'repo');
  }
  for (const match of text.matchAll(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gi)) add(match[1].toLowerCase(), 'repo');
  for (const domain of domains) add(domain.replace(/^www\./, ''), 'domain');
  if (url) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      if (hostname && !hostname.includes('x.com') && !hostname.includes('twitter.com')) add(hostname, 'domain');
    } catch {}
  }
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){1,3})\b/g)) {
    const value = match[1].trim();
    if (!/^(RT|HTTP|HTTPS|The|This|That)\b/.test(value)) add(value, 'topic');
  }
  return [...found.values()].slice(0, 12);
}

export function brainSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || `brain-${Date.now()}`;
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function parseCsv(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function normalizeKeywords(keywords?: string[] | string): string[] {
  const source = Array.isArray(keywords)
    ? keywords
    : typeof keywords === 'string'
      ? keywords.split(',')
      : [];
  return [...new Set(source.map((k) => k.trim().toLowerCase()).filter(Boolean))];
}

function spacePagePath(spaceId: string): string {
  return path.join(mdDir(), 'brain', `${spaceId}.md`);
}

function mainBrainPath(): string {
  return path.join(mdDir(), 'brain', 'index.md');
}

export function parseGitHubRepo(input: string): { repo: string; owner: string; name: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/(?:github\.com[/:])?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (!match) return null;
  const owner = match[1].replace(/\.git$/, '');
  const name = match[2].replace(/\.git$/, '');
  if (!owner || !name) return null;
  return { owner, name, repo: `${owner}/${name}`.toLowerCase() };
}

export function replaceManagedSection(existing: string, generated: string): string {
  const section = `${MANAGED_START}\n${generated.trim()}\n${MANAGED_END}`;
  const pattern = new RegExp(`${MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (pattern.test(existing)) return existing.replace(pattern, section);
  const base = existing.trim();
  return `${base ? `${base}\n\n` : ''}${section}\n`;
}

export function initBrainSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, color TEXT, created_at TEXT NOT NULL, keywords TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS bookmark_collections (
    bookmark_id TEXT NOT NULL,
    collection_name TEXT NOT NULL REFERENCES collections(name) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    PRIMARY KEY (bookmark_id, collection_name)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS brain_spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    keywords_json TEXT NOT NULL DEFAULT '[]',
    category TEXT,
    domain TEXT,
    collection TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seeded_at TEXT,
    last_agent_run_at TEXT,
    page_path TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'project',
    status TEXT NOT NULL DEFAULT 'active',
    focus_question TEXT NOT NULL DEFAULT ''
  )`);
  try { db.run(`ALTER TABLE brain_spaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'`); } catch {}
  try { db.run(`ALTER TABLE brain_spaces ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); } catch {}
  try { db.run(`ALTER TABLE brain_spaces ADD COLUMN focus_question TEXT NOT NULL DEFAULT ''`); } catch {}
  db.run(`CREATE TABLE IF NOT EXISTS brain_space_bookmarks (
    space_id TEXT NOT NULL REFERENCES brain_spaces(id) ON DELETE CASCADE,
    bookmark_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'seed',
    score REAL NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL,
    PRIMARY KEY (space_id, bookmark_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS brain_space_repos (
    space_id TEXT NOT NULL REFERENCES brain_spaces(id) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    last_checked_at TEXT,
    last_release_id TEXT,
    last_commit_sha TEXT,
    PRIMARY KEY (space_id, repo)
  )`);
  for (const column of [
    `description TEXT NOT NULL DEFAULT ''`,
    `html_url TEXT NOT NULL DEFAULT ''`,
    `homepage TEXT NOT NULL DEFAULT ''`,
    `stars INTEGER NOT NULL DEFAULT 0`,
    `open_issues INTEGER NOT NULL DEFAULT 0`,
    `default_branch TEXT NOT NULL DEFAULT ''`,
    `topics_json TEXT NOT NULL DEFAULT '[]'`,
    `readme_excerpt TEXT NOT NULL DEFAULT ''`,
    `latest_release_name TEXT NOT NULL DEFAULT ''`,
    `latest_release_url TEXT NOT NULL DEFAULT ''`,
    `latest_commit_title TEXT NOT NULL DEFAULT ''`,
    `latest_commit_url TEXT NOT NULL DEFAULT ''`,
    `latest_commit_author TEXT NOT NULL DEFAULT ''`,
    `latest_commit_at TEXT`,
    `recommended_action TEXT NOT NULL DEFAULT ''`,
  ]) {
    try { db.run(`ALTER TABLE brain_space_repos ADD COLUMN ${column}`); } catch {}
  }
  db.run(`CREATE TABLE IF NOT EXISTS brain_agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id TEXT,
    agent_type TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    summary TEXT NOT NULL DEFAULT '',
    error TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS brain_agent_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    space_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    finding_type TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    detail TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    created_at TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0
  )`);
  try { db.run(`ALTER TABLE brain_agent_findings ADD COLUMN decision TEXT NOT NULL DEFAULT 'open'`); } catch { /* already exists */ }
  try { db.run(`ALTER TABLE brain_agent_findings ADD COLUMN decision_note TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  try { db.run(`ALTER TABLE brain_agent_findings ADD COLUMN decided_at TEXT`); } catch { /* already exists */ }
  db.run(`UPDATE brain_agent_findings SET decision = 'dismissed' WHERE resolved = 1 AND decision = 'open'`);
  db.run(`CREATE TABLE IF NOT EXISTS brain_agent_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS brain_artifacts (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    space_id TEXT,
    title TEXT NOT NULL,
    url TEXT,
    body TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    source_label TEXT NOT NULL DEFAULT '',
    captured_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    raw_json TEXT,
    confidence REAL NOT NULL DEFAULT 1.0,
    UNIQUE(source_type, source_id, space_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS brain_entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    mentions INTEGER NOT NULL DEFAULT 0,
    UNIQUE(name, kind)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS brain_edges (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    source_artifact_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(from_id, to_id, edge_type, source_artifact_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS brain_claims (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    claim TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.75,
    created_at TEXT NOT NULL,
    UNIQUE(artifact_id, claim)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS brain_timeline_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS brain_workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    button_label TEXT NOT NULL,
    icon TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_run_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS brain_workflow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    space_id TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    summary TEXT NOT NULL DEFAULT '',
    changed_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS brain_source_permissions (
    source_type TEXT PRIMARY KEY,
    access TEXT NOT NULL DEFAULT 'read_write_drafts',
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_brain_bookmarks_space ON brain_space_bookmarks(space_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_brain_bookmarks_bookmark ON brain_space_bookmarks(bookmark_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_brain_findings_space ON brain_agent_findings(space_id, resolved)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_brain_runs_started ON brain_agent_runs(started_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_brain_artifacts_space ON brain_artifacts(space_id, updated_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_brain_artifacts_source ON brain_artifacts(source_type, source_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_brain_entities_kind ON brain_entities(kind, mentions)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_brain_edges_from ON brain_edges(from_id, edge_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_brain_claims_artifact ON brain_claims(artifact_id)`);

  const now = nowIso();
  for (const workflow of BRAIN_WORKFLOWS) {
    db.run(
      `INSERT OR IGNORE INTO brain_workflows (id, name, description, button_label, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workflow.id, workflow.name, workflow.description, workflow.buttonLabel, workflow.icon, now, now],
    );
  }
}

function rowToSpace(row: unknown[]): BrainSpace {
  return {
    id: String(row[0]),
    name: String(row[1] ?? ''),
    description: String(row[2] ?? ''),
    keywords: parseJsonArray(row[3]),
    category: (row[4] as string) ?? null,
    domain: (row[5] as string) ?? null,
    collection: (row[6] as string) ?? null,
    createdAt: String(row[7] ?? ''),
    updatedAt: String(row[8] ?? ''),
    lastSeededAt: (row[9] as string) ?? null,
    lastAgentRunAt: (row[10] as string) ?? null,
    pagePath: String(row[11] ?? ''),
    kind: row[12] === 'question' || row[12] === 'dossier' || row[12] === 'topic' ? row[12] : 'project',
    status: row[13] === 'incubating' || row[13] === 'complete' || row[13] === 'archived' ? row[13] : 'active',
    focusQuestion: String(row[14] ?? ''),
    bookmarkCount: Number(row[15] ?? 0),
    repoCount: Number(row[16] ?? 0),
    openFindings: Number(row[17] ?? 0),
  };
}

export async function openBrainDb(): Promise<{ db: Database; dbPath: string }> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  initBrainSchema(db);
  return { db, dbPath };
}

export function listBrainSpacesFromDb(db: Database): BrainSpace[] {
  initBrainSchema(db);
  const rows = db.exec(`
    SELECT
      s.id, s.name, s.description, s.keywords_json, s.category, s.domain, s.collection,
      s.created_at, s.updated_at, s.last_seeded_at, s.last_agent_run_at, s.page_path,
      s.kind, s.status, s.focus_question,
      (SELECT COUNT(*) FROM brain_space_bookmarks sb WHERE sb.space_id = s.id) as bookmark_count,
      (SELECT COUNT(*) FROM brain_space_repos sr WHERE sr.space_id = s.id) as repo_count,
      (SELECT COUNT(*) FROM brain_agent_findings f WHERE f.space_id = s.id AND f.resolved = 0) as open_findings
    FROM brain_spaces s
    ORDER BY s.updated_at DESC, s.name COLLATE NOCASE
  `);
  return (rows[0]?.values ?? []).map(rowToSpace);
}

function brainSpaceFingerprint(space: BrainSpace): string {
  return JSON.stringify({
    name: space.name.trim().toLowerCase(),
    description: space.description.trim(),
    keywords: [...space.keywords].map((keyword) => keyword.trim().toLowerCase()).sort(),
    category: space.category?.trim().toLowerCase() ?? null,
    domain: space.domain?.trim().toLowerCase() ?? null,
    collection: space.collection?.trim().toLowerCase() ?? null,
    kind: space.kind,
    status: space.status,
    focusQuestion: space.focusQuestion.trim(),
  });
}

function manualBrainPageContent(content: string): string {
  const managedPattern = new RegExp(
    `${MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  );
  return content.replace(managedPattern, '').trim();
}

export async function findExactDuplicateBrainSpaceGroupsFromDb(
  db: Database,
): Promise<BrainSpaceDuplicateGroup[]> {
  const spaces = listBrainSpacesFromDb(db);
  const groups = new Map<string, BrainSpace[]>();
  for (const space of spaces) {
    let pageKey = `missing:${space.id}`;
    if (space.pagePath && await pathExists(space.pagePath)) {
      pageKey = manualBrainPageContent(await readMd(space.pagePath));
    }
    const key = `${brainSpaceFingerprint(space)}\u001f${pageKey}`;
    const group = groups.get(key) ?? [];
    group.push(space);
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const sorted = [...group].sort((a, b) => {
        const aBase = a.id === brainSlug(a.name) ? 0 : 1;
        const bBase = b.id === brainSlug(b.name) ? 0 : 1;
        return aBase - bBase || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      });
      return {
        canonicalId: sorted[0].id,
        duplicateIds: sorted.slice(1).map((space) => space.id),
      };
    });
}

export function consolidateExactDuplicateBrainSpacesFromDb(
  db: Database,
  groups: BrainSpaceDuplicateGroup[],
): number {
  if (!groups.length) return 0;
  let consolidated = 0;
  db.run('BEGIN');
  try {
    for (const group of groups) {
      for (const duplicateId of group.duplicateIds) {
        db.run(
          `UPDATE brain_space_bookmarks
           SET source = CASE
                 WHEN source = 'manual'
                   OR EXISTS (
                     SELECT 1 FROM brain_space_bookmarks duplicate
                     WHERE duplicate.space_id = ?
                       AND duplicate.bookmark_id = brain_space_bookmarks.bookmark_id
                       AND duplicate.source = 'manual'
                   )
                 THEN 'manual' ELSE source END,
               score = MAX(score, COALESCE((
                 SELECT duplicate.score FROM brain_space_bookmarks duplicate
                 WHERE duplicate.space_id = ?
                   AND duplicate.bookmark_id = brain_space_bookmarks.bookmark_id
               ), score))
           WHERE space_id = ?
             AND bookmark_id IN (
               SELECT bookmark_id FROM brain_space_bookmarks WHERE space_id = ?
             )`,
          [duplicateId, duplicateId, group.canonicalId, duplicateId],
        );
        db.run(
          `INSERT OR IGNORE INTO brain_space_bookmarks
             (space_id, bookmark_id, source, score, added_at)
           SELECT ?, bookmark_id, source, score, added_at
           FROM brain_space_bookmarks WHERE space_id = ?`,
          [group.canonicalId, duplicateId],
        );
        db.run('DELETE FROM brain_space_bookmarks WHERE space_id = ?', [duplicateId]);

        db.run(
          `INSERT OR IGNORE INTO brain_space_repos (
             space_id, repo, owner, name, source, created_at, last_checked_at,
             last_release_id, last_commit_sha
           )
           SELECT ?, repo, owner, name, source, created_at, last_checked_at,
                  last_release_id, last_commit_sha
           FROM brain_space_repos WHERE space_id = ?`,
          [group.canonicalId, duplicateId],
        );
        db.run('DELETE FROM brain_space_repos WHERE space_id = ?', [duplicateId]);

        if (tableExists(db, 'project_item_roles')) {
          db.run(
            `INSERT OR IGNORE INTO project_item_roles
               (space_id, bookmark_id, role, created_at, updated_at)
             SELECT ?, bookmark_id, role, created_at, updated_at
             FROM project_item_roles WHERE space_id = ?`,
            [group.canonicalId, duplicateId],
          );
          db.run('DELETE FROM project_item_roles WHERE space_id = ?', [duplicateId]);
        }

        db.run(
          `UPDATE brain_artifacts
           SET space_id = NULL
           WHERE space_id = ?
             AND EXISTS (
               SELECT 1 FROM brain_artifacts canonical
               WHERE canonical.space_id = ?
                 AND canonical.source_type = brain_artifacts.source_type
                 AND canonical.source_id = brain_artifacts.source_id
             )`,
          [duplicateId, group.canonicalId],
        );
        db.run('UPDATE brain_artifacts SET space_id = ? WHERE space_id = ?', [group.canonicalId, duplicateId]);
        db.run('UPDATE brain_agent_runs SET space_id = ? WHERE space_id = ?', [group.canonicalId, duplicateId]);
        db.run('UPDATE brain_agent_findings SET space_id = ? WHERE space_id = ?', [group.canonicalId, duplicateId]);
        db.run('UPDATE brain_workflow_runs SET space_id = ? WHERE space_id = ?', [group.canonicalId, duplicateId]);
        db.run('DELETE FROM brain_spaces WHERE id = ?', [duplicateId]);
        consolidated += 1;
      }
      db.run(
        `DELETE FROM brain_agent_findings
         WHERE space_id = ?
           AND id NOT IN (
             SELECT MIN(id)
             FROM brain_agent_findings
             WHERE space_id = ?
             GROUP BY agent_type, finding_type, title, COALESCE(url, ''), detail, severity, resolved
           )`,
        [group.canonicalId, group.canonicalId],
      );
    }
    db.run('COMMIT');
    return consolidated;
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

export async function listBrainSpaces(): Promise<BrainSpace[]> {
  const { db } = await openBrainDb();
  try {
    return listBrainSpacesFromDb(db);
  } finally {
    db.close();
  }
}

function getSpaceFromDb(db: Database, idOrName: string): BrainSpace | null {
  const id = brainSlug(idOrName);
  const rows = db.exec(`
    SELECT
      s.id, s.name, s.description, s.keywords_json, s.category, s.domain, s.collection,
      s.created_at, s.updated_at, s.last_seeded_at, s.last_agent_run_at, s.page_path,
      s.kind, s.status, s.focus_question,
      (SELECT COUNT(*) FROM brain_space_bookmarks sb WHERE sb.space_id = s.id) as bookmark_count,
      (SELECT COUNT(*) FROM brain_space_repos sr WHERE sr.space_id = s.id) as repo_count,
      (SELECT COUNT(*) FROM brain_agent_findings f WHERE f.space_id = s.id AND f.resolved = 0) as open_findings
    FROM brain_spaces s
    WHERE s.id = ? OR s.name = ?
    LIMIT 1
  `, [id, idOrName]);
  const row = rows[0]?.values?.[0];
  return row ? rowToSpace(row) : null;
}

export async function createBrainSpace(input: BrainSpaceInput): Promise<BrainSpace> {
  const name = input.name.trim();
  if (!name) throw new Error('Sub-Brain name is required.');
  const { db, dbPath } = await openBrainDb();
  try {
    const kind = input.kind ?? 'project';
    const existingRows = db.exec(
      `SELECT id FROM brain_spaces
       WHERE lower(trim(name)) = lower(trim(?))
         AND COALESCE(kind, 'project') = ?
         AND COALESCE(status, 'active') != 'archived'
       ORDER BY created_at, id
       LIMIT 1`,
      [name, kind],
    );
    const existingId = existingRows[0]?.values[0]?.[0];
    if (typeof existingId === 'string') return getSpaceFromDb(db, existingId)!;

    let id = brainSlug(name);
    let suffix = 2;
    while (getSpaceFromDb(db, id)) id = `${brainSlug(name)}-${suffix++}`;
    const now = nowIso();
    const pagePath = spacePagePath(id);
    db.run(
      `INSERT INTO brain_spaces (
         id, name, description, keywords_json, category, domain, collection,
         created_at, updated_at, page_path, kind, status, focus_question
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        input.description?.trim() ?? '',
        JSON.stringify(normalizeKeywords(input.keywords)),
        input.category || null,
        input.domain || null,
        input.collection || null,
        now,
        now,
        pagePath,
        kind,
        input.status ?? 'active',
        input.focusQuestion?.trim() ?? '',
      ],
    );
    saveDb(db, dbPath);
    return getSpaceFromDb(db, id)!;
  } finally {
    db.close();
  }
}

export async function updateBrainSpace(id: string, input: Partial<BrainSpaceInput>): Promise<BrainSpace> {
  const { db, dbPath } = await openBrainDb();
  try {
    const current = getSpaceFromDb(db, id);
    if (!current) throw new Error(`Sub-Brain not found: ${id}`);
    const keywords = input.keywords === undefined ? current.keywords : normalizeKeywords(input.keywords);
    db.run(
      `UPDATE brain_spaces
       SET name = ?, description = ?, keywords_json = ?, category = ?, domain = ?,
           collection = ?, kind = ?, status = ?, focus_question = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.name?.trim() || current.name,
        input.description ?? current.description,
        JSON.stringify(keywords),
        input.category === undefined ? current.category : input.category,
        input.domain === undefined ? current.domain : input.domain,
        input.collection === undefined ? current.collection : input.collection,
        input.kind ?? current.kind,
        input.status ?? current.status,
        input.focusQuestion === undefined ? current.focusQuestion : input.focusQuestion,
        nowIso(),
        current.id,
      ],
    );
    saveDb(db, dbPath);
    return getSpaceFromDb(db, current.id)!;
  } finally {
    db.close();
  }
}

export async function deleteBrainSpace(id: string): Promise<void> {
  const { db, dbPath } = await openBrainDb();
  try {
    const space = getSpaceFromDb(db, id);
    if (!space) return;
    db.run(`DELETE FROM brain_agent_findings WHERE space_id = ?`, [space.id]);
    db.run(`DELETE FROM brain_agent_runs WHERE space_id = ?`, [space.id]);
    db.run(`DELETE FROM brain_space_repos WHERE space_id = ?`, [space.id]);
    db.run(`DELETE FROM brain_space_bookmarks WHERE space_id = ?`, [space.id]);
    if (tableExists(db, 'project_item_roles')) {
      db.run(`DELETE FROM project_item_roles WHERE space_id = ?`, [space.id]);
    }
    db.run(`UPDATE brain_artifacts SET space_id = NULL WHERE space_id = ?`, [space.id]);
    db.run(`UPDATE brain_workflow_runs SET space_id = NULL WHERE space_id = ?`, [space.id]);
    db.run(`DELETE FROM brain_spaces WHERE id = ?`, [space.id]);
    saveDb(db, dbPath);
  } finally {
    db.close();
  }
}

function loadBookmarkCandidates(db: Database): BookmarkSeedCandidate[] {
  const rows = db.exec(`
    SELECT
      b.id, b.text, b.url, b.author_handle, b.author_name, b.categories, b.domains,
      b.links_json, b.github_urls,
      GROUP_CONCAT(bc.collection_name)
    FROM bookmarks b
    LEFT JOIN bookmark_collections bc ON bc.bookmark_id = b.id
    GROUP BY b.id
  `);
  return (rows[0]?.values ?? []).map((row) => ({
    id: String(row[0]),
    text: String(row[1] ?? ''),
    url: String(row[2] ?? ''),
    authorHandle: String(row[3] ?? ''),
    authorName: String(row[4] ?? ''),
    categories: parseCsv(row[5]),
    domains: parseCsv(row[6]),
    links: parseJsonArray(row[7]),
    githubUrls: parseJsonArray(row[8]),
    collections: parseCsv(row[9]),
  }));
}

function scoreCandidate(space: BrainSpace, candidate: BookmarkSeedCandidate): number {
  let score = 0;
  if (space.category && candidate.categories.some((c) => c.toLowerCase() === space.category!.toLowerCase())) score += 4;
  if (space.domain && candidate.domains.some((d) => d.toLowerCase() === space.domain!.toLowerCase())) score += 4;
  if (space.collection && candidate.collections.some((c) => c.toLowerCase() === space.collection!.toLowerCase())) score += 5;

  const haystack = [
    candidate.text,
    candidate.url,
    candidate.authorHandle,
    candidate.authorName,
    ...candidate.links,
    ...candidate.githubUrls,
    ...candidate.categories,
    ...candidate.domains,
  ].join(' ').toLowerCase();
  const authorIdentities = [candidate.authorHandle, candidate.authorName]
    .map((value) => value.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, ''))
    .filter(Boolean);
  for (const keyword of space.keywords) {
    if (keyword && haystack.includes(keyword.toLowerCase())) score += 2;
    const identity = keyword.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, '');
    if (identity && authorIdentities.includes(identity)) score += 4;
  }
  return score;
}

export async function seedBrainSpace(id: string): Promise<BrainSeedResult> {
  const { db, dbPath } = await openBrainDb();
  try {
    const space = getSpaceFromDb(db, id);
    if (!space) throw new Error(`Sub-Brain not found: ${id}`);
    const candidates = loadBookmarkCandidates(db);
    const now = nowIso();
    let matched = 0;
    let added = 0;
    for (const candidate of candidates) {
      const score = scoreCandidate(space, candidate);
      if (score <= 0) continue;
      matched++;
      db.run(
        `INSERT INTO brain_space_bookmarks (space_id, bookmark_id, source, score, added_at)
         VALUES (?, ?, 'seed', ?, ?)
         ON CONFLICT(space_id, bookmark_id) DO UPDATE SET
           score = MAX(brain_space_bookmarks.score, excluded.score)`,
        [space.id, candidate.id, score, now],
      );
      added += db.getRowsModified();
    }
    db.run(`UPDATE brain_spaces SET last_seeded_at = ?, updated_at = ? WHERE id = ?`, [now, now, space.id]);
    saveDb(db, dbPath);
    const updated = getSpaceFromDb(db, space.id)!;
    await updateBrainPages(db);
    return { space: updated, matched, added };
  } finally {
    db.close();
  }
}

export async function listBrainBookmarks(id: string): Promise<Array<Record<string, unknown>>> {
  const { db } = await openBrainDb();
  try {
    const space = getSpaceFromDb(db, id);
    if (!space) throw new Error(`Sub-Brain not found: ${id}`);
    const rows = db.exec(`
      SELECT b.id, b.url, b.text, b.author_handle, b.author_name, b.posted_at, b.bookmarked_at, sb.source, sb.score, sb.added_at
      FROM brain_space_bookmarks sb
      JOIN bookmarks b ON b.id = sb.bookmark_id
      WHERE sb.space_id = ?
      ORDER BY sb.score DESC, COALESCE(b.bookmarked_at, b.posted_at) DESC
      LIMIT 200
    `, [space.id]);
    return (rows[0]?.values ?? []).map((r) => ({
      id: r[0],
      url: r[1],
      text: r[2],
      authorHandle: r[3],
      authorName: r[4],
      postedAt: r[5],
      bookmarkedAt: r[6],
      source: r[7],
      score: Number(r[8] ?? 0),
      addedAt: r[9],
    }));
  } finally {
    db.close();
  }
}

export interface WorkingUnderstanding {
  conclusion: string;
  challenge: string;
  nextStep: string;
  successMeasure: string;
  outcome: string;
  evidenceIds: string[];
  savedAt: string;
}

export function workingUnderstandingFromDb(db: Database, spaceId: string): WorkingUnderstanding[] {
  initBrainSchema(db);
  const rows = db.exec(`SELECT raw_json FROM brain_artifacts
    WHERE space_id = ? AND source_type = 'note' AND source_label = 'Working understanding'
    ORDER BY captured_at DESC, id DESC LIMIT 20`, [spaceId]);
  return (rows[0]?.values || []).flatMap(([raw]) => {
    try {
      const value = JSON.parse(String(raw));
      return value.kind === 'working_understanding' ? [value.record as WorkingUnderstanding] : [];
    } catch { return []; }
  });
}

export function saveWorkingUnderstandingFromDb(db: Database, spaceId: string, input: unknown): WorkingUnderstanding {
  initBrainSchema(db);
  const space = getSpaceFromDb(db, spaceId);
  if (!space) throw new Error('Workspace not found');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid understanding');
  const payload = input as Record<string, unknown>;
  const fields = ['conclusion', 'challenge', 'nextStep', 'successMeasure', 'outcome'] as const;
  const record: WorkingUnderstanding = { conclusion: '', challenge: '', nextStep: '', successMeasure: '', outcome: '', evidenceIds: [], savedAt: nowIso() };
  for (const field of fields) {
    if (typeof payload[field] !== 'string' || payload[field].length > 6000) throw new Error(`Invalid ${field}`);
    record[field] = payload[field].trim();
  }
  if (!record.conclusion && !record.nextStep) throw new Error('Add a conclusion or next step');
  if (record.outcome && !record.nextStep) throw new Error('An outcome needs an experiment or next step');
  if (!Array.isArray(payload.evidenceIds) || payload.evidenceIds.length > 30 || payload.evidenceIds.some(id => typeof id !== 'string')) throw new Error('Invalid evidence');
  record.evidenceIds = [...new Set(payload.evidenceIds as string[])];
  const evidence = record.evidenceIds.map(id => {
    const row = db.exec(`SELECT b.author_handle, b.url, b.text FROM bookmarks b
      JOIN brain_space_bookmarks s ON s.bookmark_id = b.id WHERE s.space_id = ? AND b.id = ?`, [spaceId, id])[0]?.values[0];
    if (!row) throw new Error('Evidence must belong to this workspace');
    return `@${row[0]}: ${row[2]}\n${row[1]}`;
  });
  const previous = workingUnderstandingFromDb(db, spaceId)[0];
  if (previous && fields.every(field => previous[field] === record[field]) && JSON.stringify(previous.evidenceIds) === JSON.stringify(record.evidenceIds)) return previous;
  if (previous) record.savedAt = new Date(Math.max(Date.now(), Date.parse(previous.savedAt) + 1)).toISOString();
  const body = `Question: ${space.focusQuestion || space.name}\n\nMy current conclusion: ${record.conclusion}\n\nWhat could change my mind: ${record.challenge}\n\nNext experiment: ${record.nextStep}\n\nSuccess measure: ${record.successMeasure}\n\nObserved outcome: ${record.outcome}\n\nEvidence:\n${evidence.join('\n\n')}`;
  upsertBrainArtifactFromDb(db, {
    sourceType: 'note', sourceId: stableId('understanding', spaceId, record.savedAt, body), spaceId,
    title: `${space.name}: working understanding`, body, author: 'You',
    sourceLabel: 'Working understanding', capturedAt: record.savedAt,
    rawJson: JSON.stringify({ kind: 'working_understanding', record }), confidence: 1,
  });
  db.run('UPDATE brain_spaces SET updated_at = ? WHERE id = ?', [record.savedAt, spaceId]);
  return record;
}

export async function saveWorkingUnderstanding(spaceId: string, input: unknown): Promise<WorkingUnderstanding> {
  const { db, dbPath } = await openBrainDb();
  try {
    const record = saveWorkingUnderstandingFromDb(db, spaceId, input);
    saveDb(db, dbPath);
    return record;
  } finally { db.close(); }
}

export function brainWorkspaceBriefFromDb(db: Database, id: string): BrainWorkspaceBrief {
  initBrainSchema(db);
  const space = getSpaceFromDb(db, id);
  if (!space) throw new Error(`Sub-Brain not found: ${id}`);

  const enrichmentJoin = tableExists(db, 'bookmark_enrichment')
    ? 'LEFT JOIN bookmark_enrichment e ON e.bookmark_id = b.id'
    : '';
  const keyClaim = tableExists(db, 'bookmark_enrichment')
    ? "COALESCE(NULLIF(e.key_claim, ''), NULLIF(e.summary, ''), b.text)"
    : 'b.text';
  const whyItMatters = tableExists(db, 'bookmark_enrichment')
    ? "COALESCE(NULLIF(e.why_it_matters, ''), '')"
    : "''";
  const keyRows = db.exec(`
    SELECT b.id, ${keyClaim}, ${whyItMatters}, b.author_handle, b.author_name, b.url, b.text
    FROM brain_space_bookmarks sb
    JOIN bookmarks b ON b.id = sb.bookmark_id
    ${enrichmentJoin}
    WHERE sb.space_id = ?
    ORDER BY
      sb.score DESC,
      CASE WHEN ${keyClaim} <> '' THEN 0 ELSE 1 END,
      ${tableExists(db, 'bookmark_enrichment') ? 'COALESCE(e.enriched_at, b.posted_at, sb.added_at)' : 'COALESCE(b.posted_at, sb.added_at)'} DESC,
      b.id
    LIMIT 30
  `, [space.id]);
  const rankedIdeas = (keyRows[0]?.values ?? []).map((row) => {
    const claim = String(row[1] ?? '').replace(/\s+/g, ' ').trim();
    const sourceText = String(row[6] ?? '').replace(/\s+/g, ' ').trim();
    return {
      bookmarkId: String(row[0]),
      title: firstSentence(claim || sourceText, 'Saved source'),
      detail: sourceText || claim,
      whyItMatters: /^This may be useful later,/i.test(String(row[2] ?? '')) ? '' : String(row[2] ?? ''),
      author: String(row[3] || row[4] || ''),
      url: (row[5] as string) ?? null,
    };
  });
  const keyIdeas = diversifyBrainIdeas(rankedIdeas);
  const practiceIdea = keyIdeas[0] ?? null;
  const practice = practiceIdea ? (() => {
    const ideaText = `${practiceIdea.title} ${practiceIdea.detail}`.toLowerCase();
    const topic = space.keywords.find(
      (keyword) => keyword.length >= 4 && ideaText.includes(keyword.toLowerCase()),
    ) || space.name;
    const author = practiceIdea.author.replace(/^@/, '');
    const subject = displayBrainTerm(topic);
    return {
      bookmarkId: practiceIdea.bookmarkId,
      cue: author
        ? `What did @${author} claim about ${subject}, and what evidence or implication did the source include?`
        : `What is the central idea about ${subject}, and what evidence or implication did the source include?`,
      answer: practiceIdea.detail.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 900),
      applicationPrompt: `How could this change your answer to: ${space.focusQuestion || `What should you do next with ${space.name}?`}`,
      whyItMatters: practiceIdea.whyItMatters,
      author: practiceIdea.author,
      url: practiceIdea.url,
    };
  })() : null;

  const storedActions: BrainWorkspaceBrief['nextActions'] = tableExists(db, 'bookmark_enrichment')
    ? (db.exec(`
        SELECT b.id, e.suggested_action, COALESCE(NULLIF(e.key_claim, ''), NULLIF(e.summary, ''), b.text), b.url
        FROM brain_space_bookmarks sb
        JOIN bookmarks b ON b.id = sb.bookmark_id
        JOIN bookmark_enrichment e ON e.bookmark_id = b.id
        WHERE sb.space_id = ?
          AND TRIM(e.suggested_action) <> ''
          AND e.suggested_action NOT LIKE 'Add a note explaining%'
          AND e.suggested_action NOT LIKE 'Review this bookmark%'
        GROUP BY e.suggested_action
        ORDER BY sb.score DESC, e.enriched_at DESC
        LIMIT 5
      `, [space.id])[0]?.values ?? []).map((row) => ({
        bookmarkId: String(row[0]),
        action: String(row[1] ?? ''),
        sourceTitle: firstSentence(String(row[2] ?? ''), 'Saved source'),
        url: (row[3] as string) ?? null,
      }))
    : [];
  const nextActions = storedActions.length > 0
    ? storedActions
    : keyIdeas.slice(0, 3).map((idea) => {
        const source = idea.title.replace(/[.!?]+$/, '');
        const content = `${idea.title} ${idea.detail}`.toLowerCase();
        const action = /gbrain|second.brain|agent memory|knowledge graph|persistent memory/.test(content)
          ? `Compare the system in “${source}” with Xtreme: capture one pattern to adopt, one boundary to preserve, and one result to measure.`
          : /github|repo|tool|app|plugin|launch|open.source/.test(content)
          ? `Evaluate “${source}” against this workspace: record the use case, proof it works, and a keep-or-drop decision.`
          : /research|paper|study|benchmark|model|experiment/.test(content)
            ? `Verify the main claim in “${source}”: capture one supporting fact, one assumption, and one small test.`
            : `Connect “${source}” to the workspace focus: write one implication and the next decision it should change.`;
        return {
          bookmarkId: idea.bookmarkId,
          action,
          sourceTitle: idea.title,
          url: idea.url,
        };
      });

  const findingRows = db.exec(`
    SELECT title, detail, severity, url
    FROM brain_agent_findings
    WHERE space_id = ? AND resolved = 0
    ORDER BY CASE severity WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, created_at DESC
    LIMIT 5
  `, [space.id]);
  const openQuestions: BrainWorkspaceBrief['openQuestions'] = (findingRows[0]?.values ?? []).map((row) => ({
    title: String(row[0] ?? ''),
    detail: String(row[1] ?? ''),
    severity: (row[2] as BrainFinding['severity']) ?? 'info',
    url: (row[3] as string) ?? null,
  }));
  if (space.kind === 'question' && space.focusQuestion) {
    openQuestions.unshift({ title: space.focusQuestion, detail: 'The question this workspace is organized to answer.', severity: 'info', url: null });
  }

  const artifactRows = db.exec(`
    SELECT a.id, a.source_type, a.source_id, a.space_id, s.name, a.title, a.url, a.body, a.author, a.source_label, a.captured_at, a.updated_at, a.confidence
    FROM brain_artifacts a
    LEFT JOIN brain_spaces s ON s.id = a.space_id
    WHERE a.space_id = ?
    ORDER BY a.updated_at DESC
    LIMIT 6
  `, [space.id]);
  const recentEvidence = (artifactRows[0]?.values ?? []).map(rowToBrainArtifact);
  const memoryCount = Number(db.exec(`SELECT COUNT(*) FROM brain_artifacts WHERE space_id = ?`, [space.id])[0]?.values?.[0]?.[0] ?? 0);
  const focus = space.focusQuestion || space.description || `Build useful working knowledge about ${space.name}.`;
  const overview = `${focus} This workspace currently connects ${space.bookmarkCount.toLocaleString()} saved sources, ${space.repoCount.toLocaleString()} watched projects, and ${memoryCount.toLocaleString()} memory cards.`;

  return { overview, keyIdeas, nextActions, openQuestions, practice, recentEvidence, understanding: workingUnderstandingFromDb(db, id) };
}

export async function brainWorkspaceBrief(id: string): Promise<BrainWorkspaceBrief> {
  const { db } = await openBrainDb();
  try {
    return brainWorkspaceBriefFromDb(db, id);
  } finally {
    db.close();
  }
}

export async function addBrainBookmark(spaceId: string, bookmarkId: string): Promise<void> {
  const { db, dbPath } = await openBrainDb();
  try {
    const space = getSpaceFromDb(db, spaceId);
    if (!space) throw new Error(`Sub-Brain not found: ${spaceId}`);
    db.run(
      `INSERT OR REPLACE INTO brain_space_bookmarks (space_id, bookmark_id, source, score, added_at)
       VALUES (?, ?, 'manual', 100, ?)`,
      [space.id, bookmarkId, nowIso()],
    );
    saveDb(db, dbPath);
    await updateBrainPages(db);
  } finally {
    db.close();
  }
}

export async function removeBrainBookmark(spaceId: string, bookmarkId: string): Promise<void> {
  const { db, dbPath } = await openBrainDb();
  try {
    const space = getSpaceFromDb(db, spaceId);
    if (!space) throw new Error(`Sub-Brain not found: ${spaceId}`);
    db.run(`DELETE FROM brain_space_bookmarks WHERE space_id = ? AND bookmark_id = ?`, [space.id, bookmarkId]);
    saveDb(db, dbPath);
    await updateBrainPages(db);
  } finally {
    db.close();
  }
}

function rowToRepo(row: unknown[]): BrainRepo {
  return {
    spaceId: String(row[0]),
    repo: String(row[1]),
    owner: String(row[2]),
    name: String(row[3]),
    source: String(row[4] ?? 'manual'),
    createdAt: String(row[5] ?? ''),
    lastCheckedAt: (row[6] as string) ?? null,
    lastReleaseId: (row[7] as string) ?? null,
    lastCommitSha: (row[8] as string) ?? null,
    description: String(row[9] ?? ''),
    htmlUrl: String(row[10] ?? ''),
    homepage: String(row[11] ?? ''),
    stars: Number(row[12] ?? 0),
    openIssues: Number(row[13] ?? 0),
    defaultBranch: String(row[14] ?? ''),
    topics: parseJsonArray(row[15]),
    readmeExcerpt: String(row[16] ?? ''),
    latestReleaseName: String(row[17] ?? ''),
    latestReleaseUrl: String(row[18] ?? ''),
    latestCommitTitle: String(row[19] ?? ''),
    latestCommitUrl: String(row[20] ?? ''),
    latestCommitAuthor: String(row[21] ?? ''),
    latestCommitAt: (row[22] as string) ?? null,
    recommendedAction: String(row[23] ?? ''),
  };
}

const BRAIN_REPO_COLUMNS = `space_id, repo, owner, name, source, created_at, last_checked_at,
  last_release_id, last_commit_sha, description, html_url, homepage, stars, open_issues,
  default_branch, topics_json, readme_excerpt, latest_release_name, latest_release_url,
  latest_commit_title, latest_commit_url, latest_commit_author, latest_commit_at, recommended_action`;

export async function listBrainRepos(spaceId: string): Promise<BrainRepo[]> {
  const { db } = await openBrainDb();
  try {
    const space = getSpaceFromDb(db, spaceId);
    if (!space) throw new Error(`Sub-Brain not found: ${spaceId}`);
    const rows = db.exec(
      `SELECT ${BRAIN_REPO_COLUMNS} FROM brain_space_repos WHERE space_id = ? ORDER BY repo`,
      [space.id],
    );
    return (rows[0]?.values ?? []).map(rowToRepo);
  } finally {
    db.close();
  }
}

export async function addBrainRepo(spaceId: string, input: BrainRepoInput): Promise<BrainRepo> {
  const parsed = parseGitHubRepo(input.repo);
  if (!parsed) throw new Error('Repo must look like owner/name or github.com/owner/name.');
  const { db, dbPath } = await openBrainDb();
  try {
    const space = getSpaceFromDb(db, spaceId);
    if (!space) throw new Error(`Sub-Brain not found: ${spaceId}`);
    const now = nowIso();
    db.run(
      `INSERT OR IGNORE INTO brain_space_repos (space_id, repo, owner, name, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [space.id, parsed.repo, parsed.owner, parsed.name, input.source ?? 'manual', now],
    );
    saveDb(db, dbPath);
    const repos = await listBrainRepos(space.id);
    return repos.find((r) => r.repo === parsed.repo)!;
  } finally {
    db.close();
  }
}

function rowToRun(row: unknown[]): BrainRun {
  return {
    id: Number(row[0]),
    spaceId: (row[1] as string) ?? null,
    spaceName: (row[2] as string) ?? undefined,
    agentType: row[3] as BrainRun['agentType'],
    status: row[4] as BrainRun['status'],
    startedAt: String(row[5] ?? ''),
    finishedAt: (row[6] as string) ?? null,
    summary: String(row[7] ?? ''),
    error: (row[8] as string) ?? null,
  };
}

function rowToFinding(row: unknown[]): BrainFinding {
  return {
    id: Number(row[0]),
    runId: Number(row[1]),
    spaceId: String(row[2]),
    spaceName: (row[3] as string) ?? undefined,
    agentType: row[4] as BrainAgentType,
    findingType: String(row[5] ?? ''),
    title: String(row[6] ?? ''),
    url: (row[7] as string) ?? null,
    detail: String(row[8] ?? ''),
    severity: (row[9] as BrainFinding['severity']) ?? 'info',
    createdAt: String(row[10] ?? ''),
    resolved: Number(row[11] ?? 0) === 1,
    decision: (row[12] as BrainFinding['decision']) ?? (Number(row[11] ?? 0) === 1 ? 'dismissed' : 'open'),
    decisionNote: String(row[13] ?? ''),
    decidedAt: (row[14] as string) ?? null,
  };
}

export function rowToBrainArtifact(row: unknown[]): BrainArtifact {
  return {
    id: String(row[0]),
    sourceType: String(row[1] ?? ''),
    sourceId: String(row[2] ?? ''),
    spaceId: (row[3] as string) ?? null,
    spaceName: (row[4] as string) ?? undefined,
    title: String(row[5] ?? ''),
    url: (row[6] as string) ?? null,
    body: String(row[7] ?? ''),
    author: String(row[8] ?? ''),
    sourceLabel: String(row[9] ?? ''),
    capturedAt: String(row[10] ?? ''),
    updatedAt: String(row[11] ?? ''),
    confidence: Number(row[12] ?? 1),
  };
}

/** Compatibility adapter: Brain spaces are canonical Topics at the service boundary. */
export function brainSpaceToKnowledgeTopic(space: BrainSpace): KnowledgeTopic {
  return {
    id: space.id,
    name: space.name,
    description: space.description,
    keywords: [...space.keywords],
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
    itemCount: space.bookmarkCount,
    legacy: {
      category: space.category,
      domain: space.domain,
      collection: space.collection,
      pagePath: space.pagePath,
    },
  };
}

/** Compatibility adapter: existing memory cards remain valid canonical Items. */
export function brainArtifactToKnowledgeItem(artifact: BrainArtifact): KnowledgeItem {
  const supportedKinds = new Set<KnowledgeItemKind>(['bookmark', 'note', 'x_feed', 'concept', 'synthesis', 'repo_event', 'web_source']);
  const kind = supportedKinds.has(artifact.sourceType as KnowledgeItemKind)
    ? artifact.sourceType as KnowledgeItemKind
    : 'web_source';
  return {
    id: artifact.id,
    kind,
    title: artifact.title,
    body: artifact.body,
    url: artifact.url,
    author: artifact.author,
    topicIds: artifact.spaceId ? [artifact.spaceId] : [],
    createdAt: artifact.capturedAt,
    updatedAt: artifact.updatedAt,
    confidence: artifact.confidence,
    provenance: {
      sourceType: artifact.sourceType,
      sourceId: artifact.sourceId,
      sourceUrl: artifact.url,
      sourceLabel: artifact.sourceLabel,
      capturedAt: artifact.capturedAt,
    },
  };
}

function rowToWorkflow(row: unknown[]): BrainWorkflow {
  return {
    id: row[0] as BrainWorkflowId,
    name: String(row[1] ?? ''),
    description: String(row[2] ?? ''),
    buttonLabel: String(row[3] ?? ''),
    icon: String(row[4] ?? ''),
    lastRunAt: (row[5] as string) ?? null,
  };
}

export function upsertBrainArtifactFromDb(
  db: Database,
  input: {
    sourceType: string;
    sourceId: string;
    spaceId?: string | null;
    title: string;
    url?: string | null;
    body: string;
    author?: string;
    sourceLabel?: string;
    capturedAt?: string | null;
    rawJson?: string | null;
    confidence?: number;
    domains?: string[];
    githubUrls?: string[];
  },
): { id: string; created: boolean; edges: number; claims: number } {
  const id = stableId(input.sourceType, input.sourceId, input.spaceId ?? 'global');
  const now = nowIso();
  const capturedAt = input.capturedAt || now;
  const existed = db.exec(`SELECT id FROM brain_artifacts WHERE id = ? LIMIT 1`, [id])[0]?.values?.length ?? 0;
  db.run(
    `INSERT OR REPLACE INTO brain_artifacts
     (id, source_type, source_id, space_id, title, url, body, author, source_label, captured_at, updated_at, raw_json, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.sourceType,
      input.sourceId,
      input.spaceId ?? null,
      input.title.slice(0, 220),
      input.url ?? null,
      input.body,
      input.author ?? '',
      input.sourceLabel ?? input.sourceType,
      capturedAt,
      now,
      input.rawJson ?? null,
      input.confidence ?? 0.85,
    ],
  );

  let edges = 0;
  const entities = extractEntities(input.body, input.url, input.domains ?? [], input.githubUrls ?? []);
  for (const entity of entities) {
    const entityId = stableId('entity', entity.kind, entity.name.toLowerCase());
    db.run(
      `INSERT OR IGNORE INTO brain_entities (id, name, kind, created_at, updated_at, mentions)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [entityId, entity.name, entity.kind, now, now],
    );
    const edgeId = stableId(id, entityId, 'mentions');
    db.run(
      `INSERT OR IGNORE INTO brain_edges (id, from_id, to_id, edge_type, confidence, source_artifact_id, created_at)
       VALUES (?, ?, ?, 'mentions', 0.8, ?, ?)`,
      [edgeId, id, entityId, id, now],
    );
    const edgeCreated = db.getRowsModified();
    if (edgeCreated) db.run(`UPDATE brain_entities SET updated_at = ?, mentions = mentions + 1 WHERE id = ?`, [now, entityId]);
    edges += edgeCreated;
  }

  let claims = 0;
  for (const claim of splitClaims(input.body)) {
    const claimId = stableId('claim', id, claim);
    db.run(
      `INSERT OR IGNORE INTO brain_claims (id, artifact_id, claim, confidence, created_at)
       VALUES (?, ?, ?, 0.72, ?)`,
      [claimId, id, claim, now],
    );
    claims += db.getRowsModified();
  }

  if (!existed) {
    db.run(
      `INSERT INTO brain_timeline_events (artifact_id, event_type, title, detail, created_at)
       VALUES (?, 'captured', ?, ?, ?)`,
      [id, input.title.slice(0, 220), input.sourceLabel ?? input.sourceType, now],
    );
  }

  return { id, created: !existed, edges, claims };
}

function recalculateEntityMentions(db: Database): void {
  db.run(`
    UPDATE brain_entities
    SET mentions = (
      SELECT COUNT(*)
      FROM brain_edges
      WHERE brain_edges.to_id = brain_entities.id
    )
  `);
}

export function syncBrainMemoryFromDb(db: Database): { artifacts: number; created: number; edges: number; claims: number } {
  initBrainSchema(db);
  let artifacts = 0;
  let created = 0;
  let edges = 0;
  let claims = 0;

  if (tableExists(db, 'bookmarks')) {
    const rows = db.exec(`
      SELECT
        sb.space_id, s.name, b.id, b.url, b.text, b.author_handle, b.author_name,
        b.bookmarked_at, b.posted_at, b.categories, b.domains, b.github_urls, b.links_json, sb.source
      FROM brain_space_bookmarks sb
      JOIN brain_spaces s ON s.id = sb.space_id
      JOIN bookmarks b ON b.id = sb.bookmark_id
      ORDER BY COALESCE(b.bookmarked_at, b.posted_at) DESC
      LIMIT 5000
    `);
    for (const row of rows[0]?.values ?? []) {
      const body = String(row[4] ?? '');
      const result = upsertBrainArtifactFromDb(db, {
        sourceType: 'bookmark',
        sourceId: String(row[2]),
        spaceId: String(row[0]),
        title: firstSentence(body, 'Bookmark memory'),
        url: (row[3] as string) ?? null,
        body,
        author: String(row[5] || row[6] || ''),
        sourceLabel: `Bookmark in ${String(row[1] ?? 'Brain')}`,
        capturedAt: (row[7] as string) || (row[8] as string) || null,
        rawJson: JSON.stringify({ categories: parseCsv(row[9]), domains: parseCsv(row[10]), links: parseJsonArray(row[12]), membership: row[13] }),
        confidence: row[13] === 'manual' ? 0.95 : 0.78,
        domains: parseCsv(row[10]),
        githubUrls: parseJsonArray(row[11]),
      });
      artifacts++;
      if (result.created) created++;
      edges += result.edges;
      claims += result.claims;
    }
  }

  if (tableExists(db, 'x_stream_items')) {
    const rows = db.exec(`
      SELECT tweet_id, username, text, created_at, item_type, source_account, raw_json
      FROM x_stream_items
      ORDER BY created_at DESC
      LIMIT 500
    `);
    for (const row of rows[0]?.values ?? []) {
      const body = String(row[2] ?? '');
      const username = String(row[1] ?? '');
      const result = upsertBrainArtifactFromDb(db, {
        sourceType: 'x_feed',
        sourceId: String(row[0]),
        spaceId: null,
        title: firstSentence(body, `${username || 'X'} update`),
        url: username ? `https://x.com/${username}/status/${String(row[0])}` : null,
        body,
        author: username ? `@${username}` : '',
        sourceLabel: `${String(row[4] ?? 'post')} from ${String(row[5] ?? username)}`,
        capturedAt: (row[3] as string) ?? null,
        rawJson: (row[6] as string) ?? null,
        confidence: 0.7,
      });
      artifacts++;
      if (result.created) created++;
      edges += result.edges;
      claims += result.claims;
    }
  }

  recalculateEntityMentions(db);

  return { artifacts, created, edges, claims };
}

export async function syncBrainMemory(): Promise<{ artifacts: number; created: number; edges: number; claims: number }> {
  const { db, dbPath } = await openBrainDb();
  try {
    const result = syncBrainMemoryFromDb(db);
    saveDb(db, dbPath);
    return result;
  } finally {
    db.close();
  }
}

export async function createBrainNote(input: { title?: string; text: string; tags?: string[]; spaceId?: string | null }): Promise<BrainArtifact> {
  const text = input.text.trim();
  if (!text) throw new Error('Note text is required.');
  const { db, dbPath } = await openBrainDb();
  try {
    const spaces = listBrainSpacesFromDb(db);
    const tagText = (input.tags ?? []).join(' ').toLowerCase();
    const haystack = `${input.title ?? ''} ${text} ${tagText}`.toLowerCase();
    const matchedSpace = input.spaceId
      ? getSpaceFromDb(db, input.spaceId)
      : spaces.find((space) => space.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) ?? null;
    const sourceId = stableId('note', input.title ?? '', text, Date.now());
    const result = upsertBrainArtifactFromDb(db, {
      sourceType: 'note',
      sourceId,
      spaceId: matchedSpace?.id ?? null,
      title: input.title?.trim() || firstSentence(text, 'Untitled note'),
      body: text,
      author: 'You',
      sourceLabel: matchedSpace ? `Note in ${matchedSpace.name}` : 'Quick note',
      capturedAt: nowIso(),
      rawJson: JSON.stringify({ tags: input.tags ?? [] }),
      confidence: 1,
    });
    if (matchedSpace) {
      db.run(`UPDATE brain_spaces SET updated_at = ? WHERE id = ?`, [nowIso(), matchedSpace.id]);
    }
    saveDb(db, dbPath);
    const rows = db.exec(`
      SELECT a.id, a.source_type, a.source_id, a.space_id, s.name, a.title, a.url, a.body, a.author, a.source_label, a.captured_at, a.updated_at, a.confidence
      FROM brain_artifacts a
      LEFT JOIN brain_spaces s ON s.id = a.space_id
      WHERE a.id = ?
    `, [result.id]);
    return rowToBrainArtifact(rows[0].values[0]);
  } finally {
    db.close();
  }
}

export function brainMemoryOverviewFromDb(db: Database, limit = 8): BrainMemoryOverview {
  initBrainSchema(db);
  const scalar = (sql: string): number => Number(db.exec(sql)[0]?.values?.[0]?.[0] ?? 0);
  const artifactRows = db.exec(`
    SELECT a.id, a.source_type, a.source_id, a.space_id, s.name, a.title, a.url, a.body, a.author, a.source_label, a.captured_at, a.updated_at, a.confidence
    FROM brain_artifacts a
    LEFT JOIN brain_spaces s ON s.id = a.space_id
    ORDER BY a.updated_at DESC
    LIMIT ?
  `, [limit]);
  const entityRows = db.exec(`
    SELECT name, kind, mentions
    FROM brain_entities
    ORDER BY mentions DESC, updated_at DESC
    LIMIT 10
  `);
  return {
    artifactCount: scalar(`SELECT COUNT(*) FROM brain_artifacts`),
    entityCount: scalar(`SELECT COUNT(*) FROM brain_entities`),
    edgeCount: scalar(`SELECT COUNT(*) FROM brain_edges`),
    claimCount: scalar(`SELECT COUNT(*) FROM brain_claims`),
    timelineCount: scalar(`SELECT COUNT(*) FROM brain_timeline_events`),
    recentArtifacts: (artifactRows[0]?.values ?? []).map(rowToBrainArtifact),
    topEntities: (entityRows[0]?.values ?? []).map((row) => ({
      name: String(row[0] ?? ''),
      kind: String(row[1] ?? ''),
      mentions: Number(row[2] ?? 0),
    })),
  };
}

export async function brainMemoryOverview(limit = 8): Promise<BrainMemoryOverview> {
  const { db } = await openBrainDb();
  try {
    return brainMemoryOverviewFromDb(db, limit);
  } finally {
    db.close();
  }
}

export function listBrainWorkflowsFromDb(db: Database): BrainWorkflow[] {
  initBrainSchema(db);
  const rows = db.exec(`
    SELECT id, name, description, button_label, icon, last_run_at
    FROM brain_workflows
    ORDER BY CASE id
      WHEN 'capture' THEN 1 WHEN 'distill' THEN 2 WHEN 'connect' THEN 3
      WHEN 'watch' THEN 4 WHEN 'review' THEN 5 WHEN 'repair' THEN 6
      WHEN 'publish' THEN 7 ELSE 99 END
  `);
  return (rows[0]?.values ?? []).map(rowToWorkflow);
}

export async function listBrainWorkflows(): Promise<BrainWorkflow[]> {
  const { db } = await openBrainDb();
  try {
    return listBrainWorkflowsFromDb(db);
  } finally {
    db.close();
  }
}

export function listBrainRunsFromDb(db: Database, limit = 20): BrainRun[] {
  initBrainSchema(db);
  const rows = db.exec(`
    SELECT r.id, r.space_id, s.name, r.agent_type, r.status, r.started_at, r.finished_at, r.summary, r.error
    FROM brain_agent_runs r
    LEFT JOIN brain_spaces s ON s.id = r.space_id
    ORDER BY r.started_at DESC
    LIMIT ?
  `, [limit]);
  return (rows[0]?.values ?? []).map(rowToRun);
}

export async function listBrainRuns(limit = 20): Promise<BrainRun[]> {
  const { db } = await openBrainDb();
  try {
    return listBrainRunsFromDb(db, limit);
  } finally {
    db.close();
  }
}

export function listBrainFindingsFromDb(
  db: Database,
  limit = 50,
  onlyOpen = false,
  decision?: BrainFinding['decision'],
): BrainFinding[] {
  initBrainSchema(db);
  const filters: string[] = [];
  const params: Array<string | number> = [];
  if (onlyOpen) filters.push('f.resolved = 0');
  if (decision) {
    filters.push('f.decision = ?');
    params.push(decision);
  }
  params.push(limit);
  const rows = db.exec(`
    SELECT f.id, f.run_id, f.space_id, s.name, f.agent_type, f.finding_type, f.title, f.url, f.detail, f.severity, f.created_at, f.resolved,
           f.decision, f.decision_note, f.decided_at
    FROM brain_agent_findings f
    LEFT JOIN brain_spaces s ON s.id = f.space_id
    ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
    ORDER BY COALESCE(f.decided_at, f.created_at) DESC
    LIMIT ?
  `, params);
  return (rows[0]?.values ?? []).map(rowToFinding);
}

export function decideBrainFindingFromDb(
  db: Database,
  id: number,
  input: BrainFindingDecisionInput,
): { finding: BrainFinding; artifactId: string | null; watchedRepo: string | null } {
  initBrainSchema(db);
  const finding = listBrainFindingsFromDb(db, 10_000, false).find((item) => item.id === id);
  if (!finding) throw new Error(`Finding not found: ${id}`);
  if (finding.resolved) {
    if (finding.decision === input.decision) return { finding, artifactId: null, watchedRepo: null };
    throw new Error('This update has already been reviewed.');
  }

  const title = String(input.title ?? finding.title).trim().slice(0, 220) || finding.title;
  const detail = String(input.detail ?? finding.detail).trim() || finding.detail;
  const note = String(input.note ?? '').trim().slice(0, 1000);
  const decidedAt = nowIso();
  let artifactId: string | null = null;
  let watchedRepo: string | null = null;

  if (input.decision === 'accepted') {
    const artifact = upsertBrainArtifactFromDb(db, {
      sourceType: 'accepted_finding',
      sourceId: String(id),
      spaceId: finding.spaceId,
      title,
      url: finding.url,
      body: note ? `${detail}\n\nReview note: ${note}` : detail,
      sourceLabel: 'Accepted workspace update',
      capturedAt: finding.createdAt,
      rawJson: JSON.stringify({ findingType: finding.findingType, agentType: finding.agentType, decisionNote: note }),
      confidence: 0.95,
      githubUrls: finding.url?.includes('github.com/') ? [finding.url] : [],
    });
    artifactId = artifact.id;

    const parsedRepo = finding.findingType === 'github_discovery' && finding.url
      ? parseGitHubRepo(finding.url)
      : null;
    if (parsedRepo) {
      db.run(
        `INSERT OR IGNORE INTO brain_space_repos (space_id, repo, owner, name, source, created_at)
         VALUES (?, ?, ?, ?, 'accepted_finding', ?)`,
        [finding.spaceId, parsedRepo.repo, parsedRepo.owner, parsedRepo.name, decidedAt],
      );
      watchedRepo = parsedRepo.repo;
    }
  }

  db.run(
    `UPDATE brain_agent_findings
     SET title = ?, detail = ?, resolved = 1, decision = ?, decision_note = ?, decided_at = ?
     WHERE id = ?`,
    [title, detail, input.decision, note, decidedAt, id],
  );
  db.run(
    `INSERT INTO brain_timeline_events (artifact_id, event_type, title, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [artifactId ?? `finding:${id}`, `finding_${input.decision}`, title, note || detail.slice(0, 300), decidedAt],
  );

  const updated = listBrainFindingsFromDb(db, 10_000, false).find((item) => item.id === id)!;
  return { finding: updated, artifactId, watchedRepo };
}

export async function decideBrainFinding(
  id: number,
  input: BrainFindingDecisionInput,
): Promise<{ finding: BrainFinding; artifactId: string | null; watchedRepo: string | null }> {
  const { db, dbPath } = await openBrainDb();
  try {
    const result = decideBrainFindingFromDb(db, id, input);
    saveDb(db, dbPath);
    await updateBrainPages(db);
    return result;
  } finally {
    db.close();
  }
}

export async function listBrainFindings(
  limit = 50,
  onlyOpen = false,
  decision?: BrainFinding['decision'],
): Promise<BrainFinding[]> {
  const { db } = await openBrainDb();
  try {
    return listBrainFindingsFromDb(db, limit, onlyOpen, decision);
  } finally {
    db.close();
  }
}

function createRun(db: Database, spaceId: string | null, agentType: BrainRun['agentType']): number {
  db.run(
    `INSERT INTO brain_agent_runs (space_id, agent_type, status, started_at) VALUES (?, ?, 'running', ?)`,
    [spaceId, agentType, nowIso()],
  );
  return Number(db.exec(`SELECT last_insert_rowid()`)[0]?.values?.[0]?.[0] ?? 0);
}

function finishRun(db: Database, runId: number, status: 'success' | 'error', summary: string, error?: string): void {
  db.run(
    `UPDATE brain_agent_runs SET status = ?, finished_at = ?, summary = ?, error = ? WHERE id = ?`,
    [status, nowIso(), summary, error ?? null, runId],
  );
}

export function recoverStaleBrainAgentRuns(db: Database, staleAfterMs = 30 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const rows = db.exec(
    `SELECT id FROM brain_agent_runs WHERE status = 'running' AND started_at < ?`,
    [cutoff],
  );
  const ids = (rows[0]?.values ?? []).map((row) => Number(row[0]));
  for (const id of ids) {
    db.run(
      `UPDATE brain_agent_runs
       SET status = 'error', finished_at = ?, summary = ?, error = ?
       WHERE id = ? AND status = 'running'`,
      [nowIso(), 'Recovered an interrupted agent run.', 'The previous process ended before this run could finish.', id],
    );
  }
  return ids.length;
}

function assertNoRunningBrainAgents(db: Database): void {
  recoverStaleBrainAgentRuns(db);
  const running = db.exec(`SELECT COUNT(*) FROM brain_agent_runs WHERE status = 'running'`)[0]?.values?.[0]?.[0];
  if (Number(running ?? 0) > 0) throw new Error('Brain agents are already running.');
}

function addFinding(
  db: Database,
  runId: number,
  spaceId: string,
  agentType: BrainAgentType,
  findingType: string,
  title: string,
  detail: string,
  url?: string | null,
  severity: BrainFinding['severity'] = 'info',
): boolean {
  const existing = db.exec(
    `SELECT id FROM brain_agent_findings WHERE space_id = ? AND agent_type = ? AND finding_type = ? AND title = ? AND COALESCE(url, '') = COALESCE(?, '') LIMIT 1`,
    [spaceId, agentType, findingType, title, url ?? null],
  );
  if (existing[0]?.values?.length) return false;
  db.run(
    `INSERT INTO brain_agent_findings (run_id, space_id, agent_type, finding_type, title, url, detail, severity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [runId, spaceId, agentType, findingType, title, url ?? null, detail, severity, nowIso()],
  );
  return true;
}

function createWorkflowRun(db: Database, workflowId: BrainWorkflowId, spaceId: string | null): number {
  db.run(
    `INSERT INTO brain_workflow_runs (workflow_id, space_id, status, started_at)
     VALUES (?, ?, 'running', ?)`,
    [workflowId, spaceId, nowIso()],
  );
  return Number(db.exec(`SELECT last_insert_rowid()`)[0]?.values?.[0]?.[0] ?? 0);
}

function finishWorkflowRun(
  db: Database,
  runId: number,
  workflowId: BrainWorkflowId,
  status: 'success' | 'error',
  summary: string,
  changedCount: number,
  error?: string,
): void {
  const now = nowIso();
  db.run(
    `UPDATE brain_workflow_runs
     SET status = ?, finished_at = ?, summary = ?, changed_count = ?, error = ?
     WHERE id = ?`,
    [status, now, summary, changedCount, error ?? null, runId],
  );
  db.run(`UPDATE brain_workflows SET last_run_at = ?, updated_at = ? WHERE id = ?`, [now, now, workflowId]);
}

function rowToWorkflowRun(row: unknown[]): BrainWorkflowRun {
  return {
    id: Number(row[0]),
    workflowId: row[1] as BrainWorkflowId,
    spaceId: (row[2] as string) ?? null,
    status: row[3] as BrainWorkflowRun['status'],
    startedAt: String(row[4] ?? ''),
    finishedAt: (row[5] as string) ?? null,
    summary: String(row[6] ?? ''),
    changedCount: Number(row[7] ?? 0),
    error: (row[8] as string) ?? null,
  };
}

export async function listBrainWorkflowRuns(limit = 20): Promise<BrainWorkflowRun[]> {
  const { db } = await openBrainDb();
  try {
    const rows = db.exec(`
      SELECT id, workflow_id, space_id, status, started_at, finished_at, summary, changed_count, error
      FROM brain_workflow_runs
      ORDER BY started_at DESC
      LIMIT ?
    `, [limit]);
    return (rows[0]?.values ?? []).map(rowToWorkflowRun);
  } finally {
    db.close();
  }
}

export async function runBrainWorkflow(
  workflowId: BrainWorkflowId,
  target: string = 'all',
): Promise<{ workflow: BrainWorkflowId; summary: string; changed: number; run: BrainWorkflowRun; agents?: { spaces: number; findings: number } }> {
  if (!BRAIN_WORKFLOWS.some((workflow) => workflow.id === workflowId)) throw new Error(`Unknown Brain workflow: ${workflowId}`);
  const { db, dbPath } = await openBrainDb();
  const selectedSpace = target === 'all' ? null : getSpaceFromDb(db, target);
  if (target !== 'all' && !selectedSpace) {
    db.close();
    throw new Error(`Sub-Brain not found: ${target}`);
  }
  const workflowRunId = createWorkflowRun(db, workflowId, selectedSpace?.id ?? null);
  try {
    const spaces = selectedSpace ? [selectedSpace] : listBrainSpacesFromDb(db);
    let changed = 0;
    let summary = '';
    let agentResult: { spaces: number; findings: number } | undefined;

    if (workflowId === 'capture') {
      const result = syncBrainMemoryFromDb(db);
      changed = result.created;
      summary = `Cleaned up ${result.artifacts} source item(s); ${result.created} new memory card(s), ${result.edges} connection(s), ${result.claims} claim(s).`;
    } else if (workflowId === 'distill') {
      const result = syncBrainMemoryFromDb(db);
      changed = result.claims;
      const totalClaims = Number(db.exec(`SELECT COUNT(*) FROM brain_claims`)[0]?.values?.[0]?.[0] ?? 0);
      summary = `Distilled ${totalClaims} source-backed claim(s) from your bookmarks, X Feed, and notes.`;
    } else if (workflowId === 'connect') {
      const result = syncBrainMemoryFromDb(db);
      changed = result.edges;
      const totalEdges = Number(db.exec(`SELECT COUNT(*) FROM brain_edges`)[0]?.values?.[0]?.[0] ?? 0);
      summary = `Mapped ${totalEdges} typed connection(s) across people, repos, domains, and topics.`;
    } else if (workflowId === 'watch') {
      assertNoRunningBrainAgents(db);
      let findings = 0;
      for (const space of spaces) {
        findings += await runRepoWatcherForSpace(db, space);
        findings += await runResearchScoutForSpace(db, space);
        await updateBrainPage(db, space.id);
      }
      await updateMainBrainPage(db);
      changed = findings;
      agentResult = { spaces: spaces.length, findings };
      summary = `Checked ${spaces.length} topic(s) and found ${findings} update(s).`;
    } else if (workflowId === 'review') {
      const runId = createRun(db, selectedSpace?.id ?? null, 'memory_curator');
      let findings = 0;
      for (const space of spaces) {
        if (space.bookmarkCount === 0) {
          addFinding(db, runId, space.id, 'memory_curator', 'empty_topic', `${space.name}: no bookmarks gathered yet`, 'Run Clean up new saves or add more watch words so this topic has source material.', null, 'warning');
          findings++;
        }
        if (!space.lastSeededAt) {
          addFinding(db, runId, space.id, 'memory_curator', 'needs_seed', `${space.name}: not gathered yet`, 'This topic has rules but has not gathered matching bookmarks yet.', null, 'info');
          findings++;
        }
        if (!space.lastAgentRunAt || Date.now() - new Date(space.lastAgentRunAt).getTime() > 24 * 60 * 60 * 1000) {
          addFinding(db, runId, space.id, 'memory_curator', 'stale_topic', `${space.name}: update check is stale`, 'Run Update watchlists to refresh repos and discovery sources for this topic.', null, 'info');
          findings++;
        }
      }
      finishRun(db, runId, 'success', `${findings} review finding(s).`);
      changed = findings;
      summary = findings ? `Found ${findings} Brain item(s) that need attention.` : 'No weak spots found. Your topics look current.';
    } else if (workflowId === 'repair') {
      const result = syncBrainMemoryFromDb(db);
      const runId = createRun(db, selectedSpace?.id ?? null, 'memory_curator');
      const thinRows = db.exec(`
        SELECT a.space_id, COALESCE(s.name, 'Main Brain'), COUNT(*)
        FROM brain_artifacts a
        LEFT JOIN brain_spaces s ON s.id = a.space_id
        WHERE LENGTH(a.body) < 80
        GROUP BY a.space_id
        LIMIT 10
      `);
      let findings = 0;
      for (const row of thinRows[0]?.values ?? []) {
        const spaceId = (row[0] as string) ?? spaces[0]?.id;
        if (!spaceId) continue;
        addFinding(db, runId, spaceId, 'memory_curator', 'thin_memory_cards', `${String(row[1])}: thin memory cards`, `${Number(row[2] ?? 0)} memory card(s) need richer source text or notes.`, null, 'info');
        findings++;
      }
      finishRun(db, runId, 'success', `${findings} repair finding(s).`);
      changed = result.created + findings;
      summary = `Repaired memory indexes and surfaced ${findings} weak card group(s).`;
    } else if (workflowId === 'publish') {
      await updateBrainPages(db);
      changed = spaces.length;
      summary = `Updated generated markdown sections for ${spaces.length} topic(s). Manual notes were preserved.`;
    }

    finishWorkflowRun(db, workflowRunId, workflowId, 'success', summary, changed);
    saveDb(db, dbPath);
    const runRows = db.exec(`
      SELECT id, workflow_id, space_id, status, started_at, finished_at, summary, changed_count, error
      FROM brain_workflow_runs
      WHERE id = ?
    `, [workflowRunId]);
    return { workflow: workflowId, summary, changed, run: rowToWorkflowRun(runRows[0].values[0]), agents: agentResult };
  } catch (err) {
    finishWorkflowRun(db, workflowRunId, workflowId, 'error', 'Workflow failed.', 0, (err as Error).message);
    saveDb(db, dbPath);
    throw err;
  } finally {
    db.close();
  }
}

async function githubJson(pathname: string): Promise<any> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'xtreme-bookmarks',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${pathname}`, { headers });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

function cleanReadmeExcerpt(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[|*_`>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 520);
}

function decodeGithubReadme(readme: any): string {
  if (!readme?.content || readme.encoding !== 'base64') return '';
  try {
    return cleanReadmeExcerpt(Buffer.from(String(readme.content).replace(/\s/g, ''), 'base64').toString('utf8'));
  } catch {
    return '';
  }
}

export function buildBrainRepoIntelligence(
  space: Pick<BrainSpace, 'name' | 'focusQuestion'>,
  repo: Pick<BrainRepo, 'repo'>,
  meta: any,
  release: any,
  commit: any,
  readme: any,
  change: 'baseline' | 'release' | 'commit',
): BrainRepoIntelligence {
  const description = String(meta?.description || '').trim();
  const readmeExcerpt = decodeGithubReadme(readme);
  const latestReleaseName = String(release?.name || release?.tag_name || '').trim();
  const latestCommitTitle = String(commit?.commit?.message || '').split('\n')[0].trim();
  const focus = space.focusQuestion ? ` the question "${space.focusQuestion}"` : ` ${space.name}`;
  const recommendedAction = change === 'release'
    ? `Review ${latestReleaseName || 'the new release'}, identify what changed, and record one implication for${focus}.`
    : change === 'commit'
      ? `Inspect "${latestCommitTitle || 'the latest commit'}" and decide whether it changes what this workspace should remember or try.`
      : `Start with the README, capture one durable principle, and compare the project's approach with${focus}.`;
  return {
    description: description || readmeExcerpt.slice(0, 220) || `${repo.repo} is a watched GitHub project.`,
    htmlUrl: String(meta?.html_url || `https://github.com/${repo.repo}`),
    homepage: String(meta?.homepage || ''),
    stars: Number(meta?.stargazers_count || 0),
    openIssues: Number(meta?.open_issues_count || 0),
    defaultBranch: String(meta?.default_branch || ''),
    topics: Array.isArray(meta?.topics) ? meta.topics.map(String).slice(0, 8) : [],
    readmeExcerpt,
    latestReleaseName,
    latestReleaseUrl: String(release?.html_url || ''),
    latestCommitTitle,
    latestCommitUrl: String(commit?.html_url || ''),
    latestCommitAuthor: String(commit?.commit?.author?.name || commit?.author?.login || ''),
    latestCommitAt: commit?.commit?.author?.date ? String(commit.commit.author.date) : null,
    recommendedAction,
  };
}

async function runRepoWatcherForSpace(db: Database, space: BrainSpace): Promise<number> {
  const runId = createRun(db, space.id, 'repo_watcher');
  let findings = 0;
  try {
    const repoRows = db.exec(
      `SELECT ${BRAIN_REPO_COLUMNS} FROM brain_space_repos WHERE space_id = ? ORDER BY repo`,
      [space.id],
    );
    const repos = (repoRows[0]?.values ?? []).map(rowToRepo);
    if (repos.length === 0) {
      finishRun(db, runId, 'success', 'No repos watched yet.');
      return findings;
    }
    for (const repo of repos) {
      try {
        const [meta, releases, commits, readme] = await Promise.all([
          githubJson(`/repos/${repo.owner}/${repo.name}`),
          githubJson(`/repos/${repo.owner}/${repo.name}/releases?per_page=1`).catch(() => []),
          githubJson(`/repos/${repo.owner}/${repo.name}/commits?per_page=1`).catch(() => []),
          githubJson(`/repos/${repo.owner}/${repo.name}/readme`).catch(() => null),
        ]);

        const release = Array.isArray(releases) ? releases[0] : null;
        const commit = Array.isArray(commits) ? commits[0] : null;
        const firstCheck = !repo.lastCheckedAt;
        const releaseChanged = !firstCheck && release?.id && String(release.id) !== repo.lastReleaseId;
        const commitChanged = !firstCheck && commit?.sha && commit.sha !== repo.lastCommitSha;
        const intelligence = buildBrainRepoIntelligence(
          space,
          repo,
          meta,
          release,
          commit,
          readme,
          releaseChanged ? 'release' : commitChanged ? 'commit' : 'baseline',
        );

        if (releaseChanged) {
          if (addFinding(
            db,
            runId,
            space.id,
            'repo_watcher',
            'release',
            `${repo.repo}: ${release.name || release.tag_name}`,
            `${String(release.body || intelligence.description).slice(0, 1500)}\n\nWhy it matters: this project is watched in ${space.name}${space.focusQuestion ? ` to help answer "${space.focusQuestion}"` : ''}.\n\nNext step: ${intelligence.recommendedAction}`,
            release.html_url,
          )) findings++;
        }

        if (commitChanged) {
          if (addFinding(
            db,
            runId,
            space.id,
            'repo_watcher',
            'commit',
            `${repo.repo}: ${commit.commit?.message?.split('\n')[0] || 'new commit'}`,
            `Changed by ${intelligence.latestCommitAuthor || 'an unknown contributor'} on ${intelligence.latestCommitAt || 'an unknown date'}.\n\nWhy it matters: this is the newest code-level change in a project watched by ${space.name}.\n\nNext step: ${intelligence.recommendedAction}`,
            commit.html_url,
          )) findings++;
        }

        db.run(
          `UPDATE brain_space_repos SET
             last_checked_at = ?, last_release_id = ?, last_commit_sha = ?, description = ?, html_url = ?,
             homepage = ?, stars = ?, open_issues = ?, default_branch = ?, topics_json = ?, readme_excerpt = ?,
             latest_release_name = ?, latest_release_url = ?, latest_commit_title = ?, latest_commit_url = ?,
             latest_commit_author = ?, latest_commit_at = ?, recommended_action = ?
           WHERE space_id = ? AND repo = ?`,
          [
            nowIso(), release?.id ? String(release.id) : repo.lastReleaseId, commit?.sha ?? repo.lastCommitSha,
            intelligence.description, intelligence.htmlUrl, intelligence.homepage, intelligence.stars,
            intelligence.openIssues, intelligence.defaultBranch, JSON.stringify(intelligence.topics), intelligence.readmeExcerpt,
            intelligence.latestReleaseName, intelligence.latestReleaseUrl, intelligence.latestCommitTitle,
            intelligence.latestCommitUrl, intelligence.latestCommitAuthor, intelligence.latestCommitAt,
            intelligence.recommendedAction, space.id, repo.repo,
          ],
        );
      } catch (err) {
        if (addFinding(db, runId, space.id, 'repo_watcher', 'repo_error', `${repo.repo}: watcher failed`, (err as Error).message, null, 'warning')) findings++;
      }
    }
    db.run(`UPDATE brain_spaces SET last_agent_run_at = ?, updated_at = ? WHERE id = ?`, [nowIso(), nowIso(), space.id]);
    finishRun(db, runId, 'success', `${findings} repo watcher finding(s).`);
    return findings;
  } catch (err) {
    finishRun(db, runId, 'error', 'Repo watcher failed.', (err as Error).message);
    throw err;
  }
}

const GENERIC_DISCOVERY_TERMS = new Set([
  'agent', 'agents', 'app', 'apps', 'github', 'open source', 'project', 'projects', 'research', 'tool', 'tools',
]);

export function scoreGithubDiscovery(item: any, terms: string[]): number {
  const fullName = String(item?.full_name || '').toLowerCase();
  const description = String(item?.description || '').toLowerCase();
  const topics = (Array.isArray(item?.topics) ? item.topics : []).join(' ').toLowerCase();
  return terms.reduce((score, rawTerm) => {
    const term = rawTerm.toLowerCase().trim();
    if (!term || GENERIC_DISCOVERY_TERMS.has(term)) return score;
    if (fullName.includes(term)) return score + 4;
    if (description.includes(term)) return score + 2;
    if (topics.includes(term)) return score + 1;
    return score;
  }, 0);
}

async function runResearchScoutForSpace(db: Database, space: BrainSpace): Promise<number> {
  const runId = createRun(db, space.id, 'research_scout');
  let findings = 0;
  try {
    const terms = [...space.keywords, space.category, space.domain].filter((v): v is string => Boolean(v)).slice(0, 6);
    if (terms.length === 0) {
      finishRun(db, runId, 'success', 'No keywords available for research scout.');
      return findings;
    }

    const specificTerms = terms
      .map((term) => term.toLowerCase().trim())
      .filter((term) => term.length >= 4 && !GENERIC_DISCOVERY_TERMS.has(term));
    const queryTerms = specificTerms.length ? specificTerms : terms;
    const query = encodeURIComponent(`${queryTerms.join(' ')} in:name,description,readme`);
    try {
      const data = await githubJson(`/search/repositories?q=${query}&sort=updated&order=desc&per_page=5`);
      const candidates = (data.items ?? [])
        .map((item: any) => ({ item, score: scoreGithubDiscovery(item, queryTerms) }))
        .filter((candidate: { score: number }) => candidate.score >= 2)
        .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
        .slice(0, 5);
      for (const { item } of candidates) {
        if (addFinding(
          db,
          runId,
          space.id,
          'research_scout',
          'github_discovery',
          `${item.full_name}: ${item.stargazers_count ?? 0} stars`,
          item.description || 'GitHub repository matched this Sub-Brain topic.',
          item.html_url,
        )) findings++;
      }
    } catch (err) {
      if (addFinding(db, runId, space.id, 'research_scout', 'github_search_error', 'GitHub discovery failed', (err as Error).message, null, 'warning')) findings++;
    }

    if (process.env.BRAVE_SEARCH_API_KEY) {
      try {
        const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(terms.join(' '))}&count=5`, {
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY,
          },
        });
        if (!res.ok) throw new Error(`Brave ${res.status}: ${await res.text()}`);
        const data = await res.json() as any;
        for (const item of data.web?.results ?? []) {
          if (addFinding(db, runId, space.id, 'research_scout', 'web_discovery', item.title, item.description || 'Web result matched this Sub-Brain topic.', item.url)) findings++;
        }
      } catch (err) {
        if (addFinding(db, runId, space.id, 'research_scout', 'web_search_error', 'Web discovery failed', (err as Error).message, null, 'warning')) findings++;
      }
    } else {
      addFinding(db, runId, space.id, 'research_scout', 'web_search_disabled', 'Web discovery disabled', 'Set BRAVE_SEARCH_API_KEY to enable web search. GitHub discovery still ran.', null, 'info');
    }

    db.run(`UPDATE brain_spaces SET last_agent_run_at = ?, updated_at = ? WHERE id = ?`, [nowIso(), nowIso(), space.id]);
    finishRun(db, runId, 'success', `${findings} research scout finding(s).`);
    return findings;
  } catch (err) {
    finishRun(db, runId, 'error', 'Research scout failed.', (err as Error).message);
    throw err;
  }
}

export async function runBrainAgents(target: string = 'all'): Promise<{ spaces: number; findings: number; runs: BrainRun[] }> {
  const { db, dbPath } = await openBrainDb();
  try {
    assertNoRunningBrainAgents(db);
    const spaces = target === 'all'
      ? listBrainSpacesFromDb(db)
      : [getSpaceFromDb(db, target)].filter((s): s is BrainSpace => Boolean(s));
    if (spaces.length === 0) throw new Error(`No Sub-Brain found for "${target}".`);
    let findings = 0;
    for (const space of spaces) {
      findings += await runRepoWatcherForSpace(db, space);
      findings += await runResearchScoutForSpace(db, space);
      await updateBrainPage(db, space.id);
    }
    await updateMainBrainPage(db);
    saveDb(db, dbPath);
    return { spaces: spaces.length, findings, runs: await listBrainRuns(10) };
  } finally {
    db.close();
  }
}

export async function runDueBrainAgents(intervalMs = 60 * 60 * 1000): Promise<{ ran: boolean; findings: number }> {
  const { db } = await openBrainDb();
  try {
    const lastRows = db.exec(`SELECT MAX(started_at) FROM brain_agent_runs WHERE agent_type IN ('repo_watcher', 'research_scout')`);
    const last = lastRows[0]?.values?.[0]?.[0] as string | undefined;
    if (last && Date.now() - new Date(last).getTime() < intervalMs) return { ran: false, findings: 0 };
  } finally {
    db.close();
  }
  const result = await runBrainAgents('all');
  return { ran: true, findings: result.findings };
}

async function updateBrainPage(db: Database, spaceId: string): Promise<void> {
  const space = getSpaceFromDb(db, spaceId);
  if (!space) return;
  await ensureDir(path.dirname(space.pagePath));
  const bookmarkRows = db.exec(`
    SELECT b.author_handle, b.text, b.url
    FROM brain_space_bookmarks sb
    JOIN bookmarks b ON b.id = sb.bookmark_id
    WHERE sb.space_id = ?
    ORDER BY sb.score DESC, COALESCE(b.bookmarked_at, b.posted_at) DESC
    LIMIT 12
  `, [space.id]);
  const repos = db.exec(`SELECT repo FROM brain_space_repos WHERE space_id = ? ORDER BY repo`, [space.id])[0]?.values ?? [];
  const findings = db.exec(`
    SELECT title, url, detail, created_at
    FROM brain_agent_findings
    WHERE space_id = ? AND resolved = 0
    ORDER BY created_at DESC
    LIMIT 10
  `, [space.id])[0]?.values ?? [];
  const generated = [
    `## Generated Status`,
    ``,
    `Updated: ${nowIso()}`,
    ``,
    `- Bookmarks: ${space.bookmarkCount}`,
    `- Watched repos: ${space.repoCount}`,
    `- Open findings: ${space.openFindings}`,
    ``,
    `### Seed Rules`,
    `- Keywords: ${space.keywords.join(', ') || 'none'}`,
    `- Category: ${space.category || 'any'}`,
    `- Domain: ${space.domain || 'any'}`,
    `- Collection: ${space.collection || 'any'}`,
    ``,
    `### Watched Repos`,
    ...(repos.length ? repos.map((r) => `- ${r[0]}`) : ['- none yet']),
    ``,
    `### Top Bookmarks`,
    ...((bookmarkRows[0]?.values ?? []).length
      ? (bookmarkRows[0]?.values ?? []).map((r) => `- @${r[0] || '?'}: ${String(r[1] ?? '').slice(0, 140)} ([source](${r[2]}))`)
      : ['- none seeded yet']),
    ``,
    `### Latest Agent Findings`,
    ...(findings.length
      ? findings.map((r) => `- ${r[0]}${r[1] ? ` ([link](${r[1]}))` : ''}: ${String(r[2] ?? '').slice(0, 220)}`)
      : ['- none yet']),
  ].join('\n');
  const existing = await pathExists(space.pagePath)
    ? await readMd(space.pagePath)
    : `# ${space.name}\n\n${space.description || 'Manual notes can go here.'}\n`;
  await writeMd(space.pagePath, replaceManagedSection(existing, generated));
}

async function updateMainBrainPage(db: Database): Promise<void> {
  const spaces = listBrainSpacesFromDb(db);
  await ensureDir(path.dirname(mainBrainPath()));
  const generated = [
    `## Generated Command Center`,
    ``,
    `Updated: ${nowIso()}`,
    ``,
    `- Sub-Brains: ${spaces.length}`,
    `- Watched repos: ${spaces.reduce((sum, s) => sum + s.repoCount, 0)}`,
    `- Open findings: ${spaces.reduce((sum, s) => sum + s.openFindings, 0)}`,
    ``,
    `### Sub-Brains`,
    ...(spaces.length ? spaces.map((s) => `- [[brain/${s.id}]] - ${s.bookmarkCount} bookmarks, ${s.repoCount} repos, ${s.openFindings} open findings`) : ['- none yet']),
  ].join('\n');
  const existing = await pathExists(mainBrainPath())
    ? await readMd(mainBrainPath())
    : `# Main Brain\n\nManual command-center notes can go here.\n`;
  await writeMd(mainBrainPath(), replaceManagedSection(existing, generated));
}

export async function updateBrainPages(db?: Database): Promise<void> {
  if (db) {
    for (const space of listBrainSpacesFromDb(db)) await updateBrainPage(db, space.id);
    await updateMainBrainPage(db);
    return;
  }
  const opened = await openBrainDb();
  try {
    for (const space of listBrainSpacesFromDb(opened.db)) await updateBrainPage(opened.db, space.id);
    await updateMainBrainPage(opened.db);
  } finally {
    opened.db.close();
  }
}

export function brainDashboardFromDb(db: Database): BrainDashboard {
  const spaces = listBrainSpacesFromDb(db);
  const recentRuns = listBrainRunsFromDb(db, 8);
  const findings = listBrainFindingsFromDb(db, 12, true);
  const memory = brainMemoryOverviewFromDb(db, 8);
  const workflows = listBrainWorkflowsFromDb(db);
  const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;
  return {
    spaces,
    recentRuns,
    findings,
    staleSpaces: spaces.filter((s) => !s.lastAgentRunAt || new Date(s.lastAgentRunAt).getTime() < staleThreshold),
    repoCount: spaces.reduce((sum, s) => sum + s.repoCount, 0),
    memory,
    workflows,
  };
}

export async function brainDashboard(): Promise<BrainDashboard> {
  const { db } = await openBrainDb();
  try {
    return brainDashboardFromDb(db);
  } finally {
    db.close();
  }
}
