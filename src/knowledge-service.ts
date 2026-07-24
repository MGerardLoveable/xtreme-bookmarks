import crypto from 'node:crypto';
import path from 'node:path';
import type { Database } from 'sql.js';
import { buildSearchPlan } from './search.js';
import { openDb, saveDb } from './db.js';
import { initBrainSchema, rowToBrainArtifact, brainArtifactToKnowledgeItem, brainSpaceToKnowledgeTopic, upsertBrainArtifactFromDb, listBrainSpacesFromDb } from './brain.js';
import { listFiles, readMd } from './fs.js';
import { mdConceptsDir, twitterBookmarksIndexPath } from './paths.js';
import type { KnowledgeAnnotation, KnowledgeEvidence, KnowledgeItem, KnowledgeTopic } from './types.js';

export interface RetrieveKnowledgeOptions {
  limit?: number;
  topicId?: string | null;
  includeConcepts?: boolean;
}

export interface SaveSynthesisInput {
  question: string;
  answer: string;
  topicId?: string | null;
  evidence?: KnowledgeEvidence[];
  filePath?: string;
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`, [table])[0]?.values?.length);
}

function termsForQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((term) => term.length > 2))].slice(0, 12);
}

function excerpt(value: unknown, limit = 700): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function relevance(text: string, terms: string[], base: number): number {
  const haystack = text.toLowerCase();
  return base + terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function evidenceId(...parts: string[]): string {
  return crypto.createHash('sha1').update(parts.join('\u001f')).digest('hex').slice(0, 24);
}

export function listKnowledgeTopicsFromDb(db: Database): KnowledgeTopic[] {
  initBrainSchema(db);
  return listBrainSpacesFromDb(db).map(brainSpaceToKnowledgeTopic);
}

export function listKnowledgeItemsFromDb(db: Database, options: { topicId?: string | null; limit?: number } = {}): KnowledgeItem[] {
  initBrainSchema(db);
  const conditions = options.topicId ? 'WHERE a.space_id = ?' : '';
  const params: Array<string | number> = options.topicId ? [options.topicId, options.limit ?? 100] : [options.limit ?? 100];
  const rows = db.exec(`
    SELECT a.id, a.source_type, a.source_id, a.space_id, s.name, a.title, a.url, a.body,
           a.author, a.source_label, a.captured_at, a.updated_at, a.confidence
    FROM brain_artifacts a
    LEFT JOIN brain_spaces s ON s.id = a.space_id
    ${conditions}
    ORDER BY a.updated_at DESC
    LIMIT ?
  `, params);
  return (rows[0]?.values ?? []).map((row) => brainArtifactToKnowledgeItem(rowToBrainArtifact(row)));
}

export function listKnowledgeAnnotationsFromDb(db: Database, itemId?: string): KnowledgeAnnotation[] {
  const annotations: KnowledgeAnnotation[] = [];
  if (tableExists(db, 'bookmark_notes')) {
    const where = itemId ? 'WHERE bookmark_id = ?' : '';
    const rows = db.exec(`SELECT bookmark_id, note, updated_at FROM bookmark_notes ${where} ORDER BY updated_at DESC`, itemId ? [itemId] : []);
    for (const row of rows[0]?.values ?? []) {
      const bookmarkId = String(row[0]);
      const updatedAt = String(row[2] ?? '');
      annotations.push({
        id: `note:${bookmarkId}`, itemId: bookmarkId, kind: 'note', body: String(row[1] ?? ''),
        createdAt: updatedAt, updatedAt,
        provenance: { sourceType: 'bookmark_note', sourceId: bookmarkId, sourceLabel: 'Your note', capturedAt: updatedAt },
      });
    }
  }
  if (tableExists(db, 'bookmark_highlights')) {
    const where = itemId ? 'WHERE bookmark_id = ?' : '';
    const rows = db.exec(`SELECT id, bookmark_id, text_fragment, color, created_at FROM bookmark_highlights ${where} ORDER BY created_at DESC`, itemId ? [itemId] : []);
    for (const row of rows[0]?.values ?? []) {
      const createdAt = String(row[4] ?? '');
      annotations.push({
        id: `highlight:${String(row[0])}`, itemId: String(row[1]), kind: 'highlight', body: String(row[2] ?? ''),
        color: String(row[3] ?? 'yellow'), createdAt, updatedAt: createdAt,
        provenance: { sourceType: 'bookmark_highlight', sourceId: String(row[0]), sourceLabel: `${String(row[3] ?? 'yellow')} highlight`, capturedAt: createdAt, fragment: String(row[2] ?? '') },
      });
    }
  }
  return annotations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function retrieveKnowledgeEvidenceFromDb(db: Database, query: string, options: RetrieveKnowledgeOptions = {}): KnowledgeEvidence[] {
  initBrainSchema(db);
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  const terms = termsForQuery(query);
  if (terms.length === 0) return [];
  const candidates: KnowledgeEvidence[] = [];
  const searchPlan = buildSearchPlan(query);
  const matches = (parts: unknown[]) => terms.some((term) => parts.some((part) => String(part ?? '').toLowerCase().includes(term)));

  if (tableExists(db, 'bookmarks')) {
    const hasFts = tableExists(db, 'bookmarks_fts');
    const rows = hasFts
      ? db.exec(`
          SELECT b.id, b.url, b.text, b.author_handle, b.author_name,
                 COALESCE(b.bookmarked_at, b.posted_at, b.synced_at), bm25(bookmarks_fts, 5.0, 1.0, 1.0)
          FROM bookmarks b JOIN bookmarks_fts ON bookmarks_fts.rowid = b.rowid
          WHERE bookmarks_fts MATCH ?
          ORDER BY bm25(bookmarks_fts, 5.0, 1.0, 1.0) ASC
          LIMIT ?
        `, [searchPlan.broadQuery, Math.max(limit * 3, 50)])
      : db.exec(`SELECT id, url, text, author_handle, author_name, COALESCE(bookmarked_at, posted_at, synced_at), 0 FROM bookmarks LIMIT ?`, [Math.max(limit * 20, 500)]);
    for (const row of rows[0]?.values ?? []) {
      if (!matches([row[2], row[3], row[4]])) continue;
      const id = String(row[0]);
      const ftsBoost = hasFts ? Math.max(0, 4 - Math.abs(Number(row[6] ?? 0))) : 0;
      candidates.push({
        id: evidenceId('bookmark', id), itemId: id, kind: 'bookmark',
        title: excerpt(row[2], 140) || 'Bookmark', excerpt: excerpt(row[2]), url: String(row[1] ?? '') || null,
        score: relevance(`${row[2]} ${row[3]} ${row[4]}`, terms, 5 + ftsBoost),
        provenance: { sourceType: 'bookmark', sourceId: id, sourceUrl: String(row[1] ?? '') || null, sourceLabel: row[3] ? `@${String(row[3])}` : 'Bookmark', capturedAt: String(row[5] ?? '') || null },
      });
    }
  }

  if (tableExists(db, 'bookmark_notes')) {
    const rows = db.exec(`SELECT n.bookmark_id, n.note, n.updated_at, b.url, b.text FROM bookmark_notes n LEFT JOIN bookmarks b ON b.id = n.bookmark_id`);
    for (const row of rows[0]?.values ?? []) {
      if (!matches([row[1], row[4]])) continue;
      const bookmarkId = String(row[0]);
      candidates.push({
        id: evidenceId('note', bookmarkId), itemId: bookmarkId, kind: 'note', title: `Note on ${excerpt(row[4], 90) || 'bookmark'}`,
        excerpt: excerpt(row[1]), url: String(row[3] ?? '') || null, score: relevance(String(row[1]), terms, 9),
        provenance: { sourceType: 'bookmark_note', sourceId: bookmarkId, sourceUrl: String(row[3] ?? '') || null, sourceLabel: 'Your note', capturedAt: String(row[2] ?? '') || null },
      });
    }
  }

  if (tableExists(db, 'bookmark_highlights')) {
    const rows = db.exec(`SELECT h.id, h.bookmark_id, h.text_fragment, h.color, h.created_at, b.url, b.text FROM bookmark_highlights h LEFT JOIN bookmarks b ON b.id = h.bookmark_id`);
    for (const row of rows[0]?.values ?? []) {
      if (!matches([row[2], row[6]])) continue;
      candidates.push({
        id: evidenceId('highlight', String(row[0])), itemId: String(row[1]), kind: 'highlight', title: `Highlight from ${excerpt(row[6], 90) || 'bookmark'}`,
        excerpt: excerpt(row[2]), url: String(row[5] ?? '') || null, score: relevance(String(row[2]), terms, 10),
        provenance: { sourceType: 'bookmark_highlight', sourceId: String(row[0]), sourceUrl: String(row[5] ?? '') || null, sourceLabel: `${String(row[3] ?? 'yellow')} highlight`, capturedAt: String(row[4] ?? '') || null, fragment: String(row[2] ?? '') },
      });
    }
  }

  const artifactParams: string[] = [];
  const artifactWhere = options.topicId ? 'WHERE a.space_id = ?' : '';
  if (options.topicId) artifactParams.push(options.topicId);
  const artifacts = db.exec(`SELECT a.id, a.source_type, a.source_id, a.title, a.url, a.body, a.source_label, a.captured_at FROM brain_artifacts a ${artifactWhere}`, artifactParams);
  for (const row of artifacts[0]?.values ?? []) {
    if (!matches([row[3], row[5], row[6]])) continue;
    const sourceType = String(row[1] ?? 'web_source');
    const kind = ['bookmark', 'note', 'x_feed', 'concept', 'synthesis', 'repo_event', 'web_source'].includes(sourceType)
      ? sourceType as KnowledgeEvidence['kind'] : 'web_source';
    candidates.push({
      id: evidenceId('artifact', String(row[0])), itemId: String(row[0]), kind, title: String(row[3] ?? 'Knowledge item'),
      excerpt: excerpt(row[5]), url: String(row[4] ?? '') || null, score: relevance(`${row[3]} ${row[5]}`, terms, sourceType === 'synthesis' ? 8 : 7),
      provenance: { sourceType, sourceId: String(row[2]), sourceUrl: String(row[4] ?? '') || null, sourceLabel: String(row[6] ?? sourceType), capturedAt: String(row[7] ?? '') || null },
    });
  }

  const deduped = new Map<string, KnowledgeEvidence>();
  for (const item of candidates) {
    const key = `${item.kind}:${item.provenance.sourceId}:${item.excerpt}`;
    if (!deduped.has(key) || deduped.get(key)!.score < item.score) deduped.set(key, item);
  }
  return [...deduped.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

async function conceptEvidence(query: string, limit: number): Promise<KnowledgeEvidence[]> {
  const terms = termsForQuery(query);
  const files = await listFiles(mdConceptsDir());
  const results: KnowledgeEvidence[] = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(mdConceptsDir(), file);
    try {
      const body = await readMd(filePath);
      if (!terms.some((term) => body.toLowerCase().includes(term))) continue;
      const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || file.replace(/\.md$/, '');
      results.push({
        id: evidenceId('concept', file), itemId: `concept:${file}`, kind: 'concept', title, excerpt: excerpt(body), url: null,
        score: relevance(`${title} ${body}`, terms, 6),
        provenance: { sourceType: 'concept', sourceId: file, sourceLabel: 'Saved concept' },
      });
    } catch { /* Ignore an unreadable concept without failing Ask. */ }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function retrieveKnowledgeEvidence(query: string, options: RetrieveKnowledgeOptions = {}): Promise<KnowledgeEvidence[]> {
  const db = await openDb(twitterBookmarksIndexPath());
  try {
    const dbEvidence = retrieveKnowledgeEvidenceFromDb(db, query, options);
    const concepts = options.includeConcepts === false ? [] : await conceptEvidence(query, options.limit ?? 30);
    return [...dbEvidence, ...concepts].sort((a, b) => b.score - a.score).slice(0, options.limit ?? 30);
  } finally {
    db.close();
  }
}

export function saveSynthesisFromDb(db: Database, input: SaveSynthesisInput): KnowledgeItem {
  initBrainSchema(db);
  const now = new Date().toISOString();
  const sourceId = evidenceId('synthesis', input.question, input.answer);
  const result = upsertBrainArtifactFromDb(db, {
    sourceType: 'synthesis', sourceId, spaceId: input.topicId ?? null, title: input.question, body: input.answer,
    author: 'You + AI', sourceLabel: 'Saved answer', capturedAt: now, confidence: 0.8,
    rawJson: JSON.stringify({ question: input.question, evidence: (input.evidence ?? []).map((item) => item.id), filePath: input.filePath ?? null }),
  });
  const rows = db.exec(`
    SELECT a.id, a.source_type, a.source_id, a.space_id, s.name, a.title, a.url, a.body,
           a.author, a.source_label, a.captured_at, a.updated_at, a.confidence
    FROM brain_artifacts a LEFT JOIN brain_spaces s ON s.id = a.space_id WHERE a.id = ?
  `, [result.id]);
  return brainArtifactToKnowledgeItem(rowToBrainArtifact(rows[0].values[0]));
}

export async function saveSynthesis(input: SaveSynthesisInput): Promise<KnowledgeItem> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);
  try {
    const item = saveSynthesisFromDb(db, input);
    saveDb(db, dbPath);
    return item;
  } finally {
    db.close();
  }
}
