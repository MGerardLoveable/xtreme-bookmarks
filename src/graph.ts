/**
 * Typed Knowledge Graph for Xtreme Bookmarks 2nd Brain.
 *
 * Stores explicit entity relationships (uses, depends_on, contradicts, etc.)
 * in a JSON-backed graph file alongside the wiki output.
 *
 * Supports:
 * - Entity extraction from bookmark text
 * - Relationship typing and confidence scoring
 * - Contradiction detection
 * - Cluster discovery (connected components)
 * - Graph stats and query helpers
 */

import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, ensureDir } from './fs.js';
import { mdDir } from './paths.js';

// ── Types ────────────────────────────────────────────────────────────────

export type RelationType =
  | 'uses'
  | 'depends_on'
  | 'contradicts'
  | 'supersedes'
  | 'is_related'
  | 'author_of'
  | 'implements'
  | 'extends';

export interface GraphEdge {
  source: string;     // wikilink slug, e.g., 'categories/react'
  target: string;
  relation: RelationType;
  confidence: number; // 0.0 – 1.0
  sourceBookmarkIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GraphNode {
  id: string;         // slug
  label: string;      // human-readable name
  type: 'category' | 'domain' | 'entity' | 'concept' | 'tool';
  mentionCount: number;
  firstSeen: string;
  lastSeen: string;
}

export interface GraphStore {
  nodes: GraphNode[];
  edges: GraphEdge[];
  updatedAt: string;
  version: number;
}

export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  contradictions: number;
  clusters: number;
  topConnected: { id: string; connections: number }[];
}

// ── Paths ────────────────────────────────────────────────────────────────

export function graphStorePath(): string {
  return path.join(mdDir(), 'graph.json');
}

// ── Load / Save ──────────────────────────────────────────────────────────

export async function loadGraph(): Promise<GraphStore> {
  const p = graphStorePath();
  if (fs.existsSync(p)) {
    try {
      const data = await readJson<GraphStore>(p);
      // Migrate from older format
      if (!data.nodes) data.nodes = [];
      if (!data.version) data.version = 1;
      return data;
    } catch { /* corrupt → fresh */ }
  }
  return { nodes: [], edges: [], updatedAt: new Date().toISOString(), version: 1 };
}

export async function saveGraph(graph: GraphStore): Promise<void> {
  await ensureDir(mdDir());
  graph.updatedAt = new Date().toISOString();
  await writeJson(graphStorePath(), graph);
}

// ── Node Operations ──────────────────────────────────────────────────────

export async function upsertNode(
  id: string,
  label: string,
  type: GraphNode['type'],
): Promise<void> {
  const graph = await loadGraph();
  const existing = graph.nodes.find(n => n.id === id);
  const now = new Date().toISOString();

  if (existing) {
    existing.mentionCount++;
    existing.lastSeen = now;
    if (label && label !== existing.label) existing.label = label;
  } else {
    graph.nodes.push({
      id,
      label,
      type,
      mentionCount: 1,
      firstSeen: now,
      lastSeen: now,
    });
  }

  await saveGraph(graph);
}

// ── Edge Operations ──────────────────────────────────────────────────────

export async function addRelation(
  source: string,
  target: string,
  relation: RelationType,
  sourceId: string,
  confidence = 0.5,
): Promise<void> {
  const graph = await loadGraph();
  const now = new Date().toISOString();
  const existing = graph.edges.find(
    e => e.source === source && e.target === target && e.relation === relation,
  );

  if (existing) {
    if (!existing.sourceBookmarkIds.includes(sourceId)) {
      existing.sourceBookmarkIds.push(sourceId);
      // Boost confidence upon corroboration (diminishing returns)
      existing.confidence = Math.min(1.0, existing.confidence + 0.1 * (1 - existing.confidence));
    }
    existing.updatedAt = now;
  } else {
    graph.edges.push({
      source,
      target,
      relation,
      confidence,
      sourceBookmarkIds: [sourceId],
      createdAt: now,
      updatedAt: now,
    });
  }

  await saveGraph(graph);
}

export async function removeRelation(
  source: string,
  target: string,
  relation: RelationType,
): Promise<boolean> {
  const graph = await loadGraph();
  const before = graph.edges.length;
  graph.edges = graph.edges.filter(
    e => !(e.source === source && e.target === target && e.relation === relation),
  );
  if (graph.edges.length < before) {
    await saveGraph(graph);
    return true;
  }
  return false;
}

// ── Query Helpers ────────────────────────────────────────────────────────

export async function getContradictions(): Promise<GraphEdge[]> {
  const graph = await loadGraph();
  return graph.edges.filter(e => e.relation === 'contradicts');
}

export async function getRelatedNodes(nodeId: string): Promise<{ node: string; relation: RelationType; direction: 'outgoing' | 'incoming' }[]> {
  const graph = await loadGraph();
  const results: { node: string; relation: RelationType; direction: 'outgoing' | 'incoming' }[] = [];

  for (const edge of graph.edges) {
    if (edge.source === nodeId) {
      results.push({ node: edge.target, relation: edge.relation, direction: 'outgoing' });
    } else if (edge.target === nodeId) {
      results.push({ node: edge.source, relation: edge.relation, direction: 'incoming' });
    }
  }

  return results;
}

/**
 * Find connected components (clusters) in the graph.
 * Returns an array of node ID sets.
 */
export async function findClusters(): Promise<Set<string>[]> {
  const graph = await loadGraph();
  const visited = new Set<string>();
  const clusters: Set<string>[] = [];

  // Build adjacency list
  const adj = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!adj.has(edge.source)) adj.set(edge.source, new Set());
    if (!adj.has(edge.target)) adj.set(edge.target, new Set());
    adj.get(edge.source)!.add(edge.target);
    adj.get(edge.target)!.add(edge.source);
  }

  for (const nodeId of adj.keys()) {
    if (visited.has(nodeId)) continue;

    // BFS
    const cluster = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      cluster.add(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    clusters.push(cluster);
  }

  return clusters;
}

// ── Entity Extraction ────────────────────────────────────────────────────

/** Common tech entities we can extract without LLM */
const ENTITY_PATTERNS: [RegExp, string][] = [
  [/\bgithub\.com\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)/gi, 'tool'],
  [/@([a-zA-Z0-9_]{1,15})\b/g, 'entity'],
  [/\b(React|Vue|Angular|Svelte|Next\.js|Nuxt|Vite|Webpack)\b/gi, 'tool'],
  [/\b(TypeScript|JavaScript|Python|Rust|Go|Java|C\+\+|Ruby|Swift|Kotlin)\b/gi, 'tool'],
  [/\b(GPT-4|Claude|Gemini|LLaMA|Mistral|Sonnet|Opus|Haiku)\b/gi, 'concept'],
  [/\b(Docker|Kubernetes|Terraform|AWS|GCP|Azure)\b/gi, 'tool'],
  [/\b(PostgreSQL|MongoDB|Redis|SQLite|DynamoDB)\b/gi, 'tool'],
];

/**
 * Extract entities from bookmark text using regex patterns.
 * Returns de-duplicated entity mentions with their types.
 */
export function extractEntities(text: string): { name: string; type: GraphNode['type'] }[] {
  const seen = new Set<string>();
  const results: { name: string; type: GraphNode['type'] }[] = [];

  for (const [pattern, type] of ENTITY_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1] ?? match[0];
      const normalized = name.toLowerCase();
      if (!seen.has(normalized) && normalized.length > 1) {
        seen.add(normalized);
        results.push({ name, type: type as GraphNode['type'] });
      }
    }
  }

  return results;
}

// ── Stats ────────────────────────────────────────────────────────────────

export async function getGraphStats(): Promise<GraphStats> {
  const graph = await loadGraph();
  const clusters = await findClusters();

  // Count connections per node
  const connectionCount = new Map<string, number>();
  for (const edge of graph.edges) {
    connectionCount.set(edge.source, (connectionCount.get(edge.source) ?? 0) + 1);
    connectionCount.set(edge.target, (connectionCount.get(edge.target) ?? 0) + 1);
  }

  const topConnected = [...connectionCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, connections]) => ({ id, connections }));

  return {
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length,
    contradictions: graph.edges.filter(e => e.relation === 'contradicts').length,
    clusters: clusters.length,
    topConnected,
  };
}

/**
 * Export graph as Mermaid diagram syntax for embedding in markdown.
 */
export async function exportGraphAsMermaid(maxEdges = 50): Promise<string> {
  const graph = await loadGraph();
  const edges = graph.edges
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxEdges);

  const lines = ['graph LR'];
  for (const edge of edges) {
    const label = edge.relation.replace(/_/g, ' ');
    const srcId = edge.source.replace(/[^a-zA-Z0-9]/g, '_');
    const tgtId = edge.target.replace(/[^a-zA-Z0-9]/g, '_');
    lines.push(`  ${srcId}["${edge.source}"] -->|${label}| ${tgtId}["${edge.target}"]`);
  }

  return lines.join('\n');
}
