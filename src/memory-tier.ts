/**
 * Memory Tiering System for Xtreme Bookmarks 2nd Brain.
 *
 * Implements a hierarchical memory architecture:
 *   Working  →  Episodic  →  Semantic  →  Procedural
 *
 * - Working:    Fresh bookmarks (< N days old). High confidence, volatile.
 * - Episodic:   Older bookmarks. Confidence decays over time.
 * - Semantic:   Consolidated knowledge. Stable, cross-referenced.
 * - Procedural: "How-to" knowledge. Derived from patterns, rarely changes.
 *
 * Also provides L1/L2 cache context building for agent prompts.
 */

import { twitterBookmarksIndexPath } from './paths.js';
import { openDb, saveDb } from './db.js';
import type { Database } from 'sql.js';

// ── Types ────────────────────────────────────────────────────────────────

export type MemoryTier = 'working' | 'episodic' | 'semantic' | 'procedural';

export interface MemoryTierConfig {
  workingMemoryDays: number;
  episodicMemoryDays: number;
  confidenceDecayRate: number; // Multiplier per day (e.g. 0.98)
  minimumConfidenceThreshold: number; // Below this, fact is archived
  minimumSemanticConfidence: number; // Must be above this to graduate to semantic
}

export const DEFAULT_TIER_CONFIG: MemoryTierConfig = {
  workingMemoryDays: 7,
  episodicMemoryDays: 30,
  confidenceDecayRate: 0.98,
  minimumConfidenceThreshold: 0.2,
  minimumSemanticConfidence: 0.6,
};

export interface ConsolidationResult {
  workingToEpisodic: number;
  episodicToSemantic: number;
  decayed: number;
  archived: number;
  totalProcessed: number;
}

// ── L1/L2 Cache ──────────────────────────────────────────────────────────

/**
 * Build a structured prompt context with L1 (system rules / identity)
 * and L2 (retrieved wiki knowledge) layers.
 *
 * L1 is cached / persisted; L2 is dynamic per query.
 */
export function buildL1L2Context(systemRules: string, retrievedMarkdown: string): string {
  return `<L1_CACHE type="system_rules">
${systemRules}
</L1_CACHE>

<L2_CACHE type="wiki_knowledge">
${retrievedMarkdown}
</L2_CACHE>`;
}

/**
 * Build the system rules block (L1) for maintenance agents.
 */
export function buildAgentSystemRules(): string {
  return `You are a maintenance agent for the Xtreme Bookmarks knowledge base.

RULES:
- Never fabricate citations. Every claim must trace back to a bookmark URL.
- When two bookmarks contradict, flag both and add a "Contradiction" callout.
- Preserve existing wikilinks ([[page]]) and add new ones when entities match.
- Write in neutral, factual tone. No marketing language.
- Emit valid YAML frontmatter when creating or updating pages.
- Your outputs are markdown. Do not wrap in code fences.`;
}

// ── Decay ─────────────────────────────────────────────────────────────────

/**
 * Calculate exponential decay for a confidence score.
 * Returns the new confidence after `daysElapsed` days.
 */
export function calculateDecay(
  baseConfidence: number,
  daysElapsed: number,
  rate = DEFAULT_TIER_CONFIG.confidenceDecayRate,
): number {
  return Math.max(0, baseConfidence * Math.pow(rate, daysElapsed));
}

/**
 * Determine what tier a bookmark should be in based on age and confidence.
 */
export function suggestTier(
  currentTier: MemoryTier,
  daysOld: number,
  confidence: number,
  config = DEFAULT_TIER_CONFIG,
): MemoryTier {
  // Procedural is sticky — only set manually or by agents
  if (currentTier === 'procedural') return 'procedural';

  if (confidence < config.minimumConfidenceThreshold) return 'episodic'; // archive candidate

  if (daysOld <= config.workingMemoryDays) return 'working';

  if (daysOld <= config.episodicMemoryDays) return 'episodic';

  // Older than episodic window + high confidence → semantic
  if (confidence >= config.minimumSemanticConfidence) return 'semantic';

  return 'episodic';
}

// ── Consolidation ────────────────────────────────────────────────────────

/**
 * Main consolidation sweep. Runs through all bookmarks and:
 *  1. Promotes Working → Episodic based on age
 *  2. Promotes Episodic → Semantic based on confidence + age
 *  3. Applies confidence decay to Episodic and Semantic tiers
 *  4. Archives items below minimum threshold
 */
export async function consolidateMemoryTiers(
  config = DEFAULT_TIER_CONFIG,
  progress?: (msg: string) => void,
): Promise<ConsolidationResult> {
  const log = progress ?? (() => {});
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);

  const result: ConsolidationResult = {
    workingToEpisodic: 0,
    episodicToSemantic: 0,
    decayed: 0,
    archived: 0,
    totalProcessed: 0,
  };

  try {
    // Check if memory columns exist
    const cols = db.exec('PRAGMA table_info(bookmarks)');
    const colNames = new Set(
      (cols[0]?.values ?? []).map(v => v[1] as string),
    );
    if (!colNames.has('memory_tier')) {
      log('⚠ memory_tier column not found. Run migration first.');
      return result;
    }

    const now = Date.now();

    // ── 1. Working → Episodic ──
    const workingThreshold = new Date(
      now - config.workingMemoryDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    db.run(
      `UPDATE bookmarks SET memory_tier = 'episodic'
       WHERE memory_tier = 'working'
         AND COALESCE(posted_at, bookmarked_at) < ?`,
      [workingThreshold],
    );
    result.workingToEpisodic = db.getRowsModified();
    if (result.workingToEpisodic > 0) {
      log(`  ✓ ${result.workingToEpisodic} bookmarks promoted: working → episodic`);
    }

    // ── 2. Episodic → Semantic ──
    const episodicThreshold = new Date(
      now - config.episodicMemoryDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    db.run(
      `UPDATE bookmarks SET memory_tier = 'semantic'
       WHERE memory_tier = 'episodic'
         AND confidence_score >= ?
         AND COALESCE(posted_at, bookmarked_at) < ?`,
      [config.minimumSemanticConfidence, episodicThreshold],
    );
    result.episodicToSemantic = db.getRowsModified();
    if (result.episodicToSemantic > 0) {
      log(`  ✓ ${result.episodicToSemantic} bookmarks promoted: episodic → semantic`);
    }

    // ── 3. Confidence decay ──
    db.run(
      `UPDATE bookmarks
       SET confidence_score = confidence_score * ?
       WHERE memory_tier IN ('episodic', 'semantic')
         AND confidence_score > ?`,
      [config.confidenceDecayRate, config.minimumConfidenceThreshold],
    );
    result.decayed = db.getRowsModified();
    if (result.decayed > 0) {
      log(`  ↓ ${result.decayed} confidence scores decayed (rate: ${config.confidenceDecayRate})`);
    }

    // ── 4. Archive very low confidence items ──
    db.run(
      `UPDATE bookmarks
       SET memory_tier = 'episodic'
       WHERE memory_tier = 'semantic'
         AND confidence_score < ?`,
      [config.minimumConfidenceThreshold],
    );
    result.archived = db.getRowsModified();
    if (result.archived > 0) {
      log(`  ⬇ ${result.archived} items demoted below confidence threshold`);
    }

    // Count total processed
    const total = db.exec('SELECT COUNT(*) FROM bookmarks WHERE memory_tier IS NOT NULL');
    result.totalProcessed = Number(total[0]?.values[0]?.[0] ?? 0);

    saveDb(db, dbPath);
    log(`  Done. ${result.totalProcessed} total bookmarks in memory system.`);
  } finally {
    db.close();
  }

  return result;
}

/**
 * Get a summary of current memory tier distribution.
 */
export async function getMemoryTierStats(): Promise<Record<MemoryTier, number>> {
  const dbPath = twitterBookmarksIndexPath();
  const db = await openDb(dbPath);

  try {
    const rows = db.exec(
      `SELECT COALESCE(memory_tier, 'working') as tier, COUNT(*) as c
       FROM bookmarks GROUP BY tier ORDER BY c DESC`,
    );
    const stats: Record<string, number> = {
      working: 0,
      episodic: 0,
      semantic: 0,
      procedural: 0,
    };
    for (const row of rows[0]?.values ?? []) {
      const tier = row[0] as string;
      if (tier in stats) stats[tier] = row[1] as number;
    }
    return stats as Record<MemoryTier, number>;
  } finally {
    db.close();
  }
}
