/**
 * Multi-Agent Maintenance System for Xtreme Bookmarks 2nd Brain.
 *
 * Agents:
 * 1. Contradiction Detector  — finds conflicting claims across wiki pages
 * 2. Link Repair Agent       — detects broken wikilinks and dead URLs
 * 3. Health Report Agent     — generates a system-wide health summary
 * 4. Entity Linker           — scans pages for unlinked entity mentions
 */

import { resolveEngine, invokeEngineAsync, type ResolvedEngine } from './engine.js';
import { getContradictions, getGraphStats, loadGraph, extractEntities, addRelation } from './graph.js';
import { listFiles, readMd, writeMd, pathExists } from './fs.js';
import { mdDir, mdCategoriesDir, mdDomainsDir, mdEntitiesDir, mdConceptsDir } from './paths.js';
import { getMemoryTierStats } from './memory-tier.js';
import { buildAgentSystemRules, buildL1L2Context } from './memory-tier.js';
import { removeFrontmatter } from './md-frontmatter.js';
import path from 'node:path';
import fs from 'node:fs';

// ── Types ────────────────────────────────────────────────────────────────

export interface AgentReport {
  agent: string;
  timestamp: string;
  findings: AgentFinding[];
  summary: string;
}

export interface AgentFinding {
  severity: 'info' | 'warning' | 'error';
  category: string;
  detail: string;
  page?: string;
  suggestion?: string;
}

export interface HealthReport {
  timestamp: string;
  wikiPages: number;
  graphNodes: number;
  graphEdges: number;
  contradictions: number;
  clusters: number;
  memoryTiers: Record<string, number>;
  brokenLinks: string[];
  orphanedPages: string[];
  healthScore: number; // 0-100
  agents: AgentReport[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function listAllWikiPages(): Promise<string[]> {
  const dirs = [mdCategoriesDir(), mdDomainsDir(), mdEntitiesDir(), mdConceptsDir()];
  const allFiles: string[] = [];

  for (const dir of dirs) {
    try {
      const files = await listFiles(dir);
      allFiles.push(
        ...files
          .filter(f => f.endsWith('.md'))
          .map(f => path.join(dir, f)),
      );
    } catch { /* dir doesn't exist yet */ }
  }

  return allFiles;
}

function extractWikilinks(content: string): string[] {
  const matches = content.match(/\[\[([^\]]+)\]\]/g) ?? [];
  return matches.map(m => m.slice(2, -2));
}

// ── Agent 1: Contradiction Detector ──────────────────────────────────────

async function runContradictionAgent(
  engine: ResolvedEngine | null,
  progress: (s: string) => void,
): Promise<AgentReport> {
  const findings: AgentFinding[] = [];
  const contradictions = await getContradictions();

  if (contradictions.length === 0) {
    progress('[Contradiction Agent] No contradictions flagged in graph.');
    return {
      agent: 'contradiction-detector',
      timestamp: new Date().toISOString(),
      findings,
      summary: 'No contradictions found.',
    };
  }

  progress(`[Contradiction Agent] Found ${contradictions.length} flagged contradictions.`);

  for (const c of contradictions) {
    const finding: AgentFinding = {
      severity: 'warning',
      category: 'contradiction',
      detail: `${c.source} contradicts ${c.target} (confidence: ${c.confidence.toFixed(2)})`,
      suggestion: '',
    };

    if (engine) {
      try {
        const systemRules = buildAgentSystemRules();
        const prompt = buildL1L2Context(systemRules, `
Contradiction detected:
- Source: ${c.source}
- Target: ${c.target}
- Confidence: ${c.confidence}
- Backed by ${c.sourceBookmarkIds.length} bookmark(s)

Provide a 1-2 sentence reconciliation note.`);

        const resolution = await invokeEngineAsync(engine, prompt, { timeout: 30_000 });
        finding.suggestion = resolution;
        progress(`  → Resolved: ${resolution.slice(0, 100)}...`);
      } catch (err) {
        progress(`  → LLM resolution failed: ${(err as Error).message.slice(0, 80)}`);
      }
    }

    findings.push(finding);
  }

  return {
    agent: 'contradiction-detector',
    timestamp: new Date().toISOString(),
    findings,
    summary: `${contradictions.length} contradiction(s) analyzed.`,
  };
}

// ── Agent 2: Link Repair ─────────────────────────────────────────────────

async function runLinkRepairAgent(
  progress: (s: string) => void,
): Promise<AgentReport> {
  const findings: AgentFinding[] = [];
  const pages = await listAllWikiPages();

  progress(`[Link Repair Agent] Scanning ${pages.length} wiki pages for broken links...`);

  const existingPages = new Set<string>();
  for (const p of pages) {
    const rel = path.relative(mdDir(), p).replace(/\\/g, '/').replace(/\.md$/, '');
    existingPages.add(rel);
  }

  let brokenCount = 0;
  for (const pagePath of pages) {
    try {
      const content = await readMd(pagePath);
      const links = extractWikilinks(content);

      for (const link of links) {
        if (!existingPages.has(link)) {
          brokenCount++;
          const rel = path.relative(mdDir(), pagePath).replace(/\\/g, '/');
          findings.push({
            severity: 'warning',
            category: 'broken-link',
            detail: `Broken wikilink [[${link}]]`,
            page: rel,
            suggestion: `Create page or update link to existing page.`,
          });
        }
      }
    } catch { /* skip unreadable files */ }
  }

  const summary = brokenCount === 0
    ? 'All wikilinks resolve correctly.'
    : `${brokenCount} broken wikilink(s) found.`;

  progress(`[Link Repair Agent] ${summary}`);

  return {
    agent: 'link-repair',
    timestamp: new Date().toISOString(),
    findings,
    summary,
  };
}

// ── Agent 3: Orphan Detector ─────────────────────────────────────────────

async function runOrphanDetector(
  progress: (s: string) => void,
): Promise<AgentReport> {
  const findings: AgentFinding[] = [];
  const pages = await listAllWikiPages();

  progress(`[Orphan Detector] Checking for orphaned pages...`);

  // Build a set of all pages that are linked to from elsewhere
  const linkedPages = new Set<string>();
  for (const pagePath of pages) {
    try {
      const content = await readMd(pagePath);
      const links = extractWikilinks(content);
      for (const link of links) linkedPages.add(link);
    } catch { /* skip */ }
  }

  // Find pages that no other page links to
  for (const pagePath of pages) {
    const rel = path.relative(mdDir(), pagePath).replace(/\\/g, '/').replace(/\.md$/, '');
    // Skip index files
    if (rel === 'index' || rel === 'schema' || rel === 'log') continue;

    if (!linkedPages.has(rel)) {
      findings.push({
        severity: 'info',
        category: 'orphaned-page',
        detail: `Page "${rel}" has no incoming links`,
        page: rel,
        suggestion: 'Add cross-references from related pages.',
      });
    }
  }

  const summary = findings.length === 0
    ? 'No orphaned pages.'
    : `${findings.length} orphaned page(s) found.`;

  progress(`[Orphan Detector] ${summary}`);

  return {
    agent: 'orphan-detector',
    timestamp: new Date().toISOString(),
    findings,
    summary,
  };
}

// ── Agent 4: Entity Linker ───────────────────────────────────────────────

async function runEntityLinker(
  progress: (s: string) => void,
): Promise<AgentReport> {
  const findings: AgentFinding[] = [];
  const pages = await listAllWikiPages();

  progress(`[Entity Linker] Scanning ${pages.length} pages for unlinked entities...`);

  // Build set of existing entity pages
  const entityPages = new Set<string>();
  for (const p of pages) {
    const rel = path.relative(mdDir(), p).replace(/\\/g, '/').replace(/\.md$/, '');
    if (rel.startsWith('entities/')) {
      entityPages.add(rel.replace('entities/', '').toLowerCase());
    }
  }

  let unlinked = 0;
  for (const pagePath of pages) {
    try {
      const content = await readMd(pagePath);
      const plainContent = removeFrontmatter(content);
      const entities = extractEntities(plainContent);

      for (const ent of entities) {
        const slug = ent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        // Check if this entity has a page but isn't linked
        if (entityPages.has(slug)) {
          const wikilink = `[[entities/${slug}]]`;
          if (!content.includes(wikilink)) {
            unlinked++;
            const rel = path.relative(mdDir(), pagePath).replace(/\\/g, '/');
            findings.push({
              severity: 'info',
              category: 'missing-crossref',
              detail: `"${ent.name}" has an entity page but isn't linked from ${rel}`,
              page: rel,
              suggestion: `Add ${wikilink} to the page.`,
            });
          }
        }
      }
    } catch { /* skip */ }
  }

  const summary = unlinked === 0
    ? 'All known entities are cross-referenced.'
    : `${unlinked} missing cross-reference(s) found.`;

  progress(`[Entity Linker] ${summary}`);

  return {
    agent: 'entity-linker',
    timestamp: new Date().toISOString(),
    findings,
    summary,
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────

/**
 * Run all maintenance agents and produce a combined report.
 */
export async function runMaintenanceAgent(
  progress: (s: string) => void,
  options: { useLlm?: boolean } = {},
): Promise<HealthReport> {
  const useLlm = options.useLlm ?? false;
  let engine: ResolvedEngine | null = null;

  if (useLlm) {
    try {
      engine = await resolveEngine();
      progress(`[Agent] Using ${engine.name} for LLM-powered analysis.`);
    } catch {
      progress('[Agent] No LLM available — running in offline mode.');
    }
  } else {
    progress('[Agent] Running in offline mode (use --llm for AI-powered analysis).');
  }

  progress('');

  // Run all agents
  const contradictionReport = await runContradictionAgent(engine, progress);
  progress('');
  const linkReport = await runLinkRepairAgent(progress);
  progress('');
  const orphanReport = await runOrphanDetector(progress);
  progress('');
  const entityReport = await runEntityLinker(progress);
  progress('');

  // Gather system stats
  const graphStats = await getGraphStats();
  const memoryTiers = await getMemoryTierStats();
  const allPages = await listAllWikiPages();

  const brokenLinks = linkReport.findings
    .filter(f => f.category === 'broken-link')
    .map(f => f.detail);

  const orphanedPages = orphanReport.findings
    .filter(f => f.category === 'orphaned-page')
    .map(f => f.page!)
    .filter(Boolean);

  // Calculate health score
  const issues = [
    ...contradictionReport.findings,
    ...linkReport.findings,
    ...orphanReport.findings,
    ...entityReport.findings,
  ];
  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;
  const infoCount = issues.filter(i => i.severity === 'info').length;
  const healthScore = Math.max(0, Math.min(100,
    100 - (errorCount * 10) - (warningCount * 5) - (infoCount * 1),
  ));

  const report: HealthReport = {
    timestamp: new Date().toISOString(),
    wikiPages: allPages.length,
    graphNodes: graphStats.totalNodes,
    graphEdges: graphStats.totalEdges,
    contradictions: graphStats.contradictions,
    clusters: graphStats.clusters,
    memoryTiers,
    brokenLinks,
    orphanedPages,
    healthScore,
    agents: [contradictionReport, linkReport, orphanReport, entityReport],
  };

  // Summary
  progress('═══ Health Report ═══════════════════════════════════════');
  progress(`  Wiki pages:      ${allPages.length}`);
  progress(`  Graph nodes:     ${graphStats.totalNodes}`);
  progress(`  Graph edges:     ${graphStats.totalEdges}`);
  progress(`  Contradictions:  ${graphStats.contradictions}`);
  progress(`  Clusters:        ${graphStats.clusters}`);
  progress(`  Memory tiers:    W:${memoryTiers.working} E:${memoryTiers.episodic} S:${memoryTiers.semantic} P:${memoryTiers.procedural}`);
  progress(`  Health score:    ${healthScore}%`);
  progress(`  Issues:          ${errorCount} errors, ${warningCount} warnings, ${infoCount} info`);
  progress('═══════════════════════════════════════════════════════');

  return report;
}

/**
 * Export health report as JSON for OpenSpec protocol.
 */
export function exportHealthReportAsJson(report: HealthReport): string {
  return JSON.stringify({
    schema: 'xtreme-bookmarks/health/v1',
    ...report,
  }, null, 2);
}
