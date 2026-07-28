import type { Database } from 'sql.js';
import { retrieveKnowledgeEvidenceFromDb, saveSynthesisFromDb } from './knowledge-service.js';
import type { KnowledgeEvidence, KnowledgeItem } from './types.js';

export type MakeArtifactType =
  | 'brief'
  | 'checklist'
  | 'decision'
  | 'experiment'
  | 'context_pack'
  | 'flashcards';

export interface ContextPackInput {
  query: string;
  title?: string;
  topicId?: string | null;
  limit?: number;
  synthesis?: string;
  evidence?: KnowledgeEvidence[];
}

export interface ContextPack {
  title: string;
  query: string;
  topicId: string | null;
  generatedAt: string;
  markdown: string;
  evidence: KnowledgeEvidence[];
  counts: {
    sources: number;
    personalAnnotations: number;
    generatedSyntheses: number;
  };
}

export interface MakeArtifactInput extends ContextPackInput {
  type: MakeArtifactType;
}

export interface MadeArtifact {
  type: MakeArtifactType;
  title: string;
  markdown: string;
  evidence: KnowledgeEvidence[];
  savedArtifact: KnowledgeItem;
  contextPack: ContextPack;
}

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function titleFromQuery(query: string): string {
  const normalized = clean(query).replace(/[?.!]+$/, '');
  if (!normalized) return 'Knowledge context';
  const words = normalized.split(' ').slice(0, 10).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const shortened = value.slice(0, limit + 1);
  const boundary = shortened.lastIndexOf(' ');
  return `${shortened.slice(0, boundary > limit * 0.65 ? boundary : limit).trim()}...`;
}

function normalizeEvidence(
  db: Database,
  input: ContextPackInput,
): KnowledgeEvidence[] {
  const limit = Math.max(1, Math.min(input.limit ?? 16, 30));
  const candidates = input.evidence?.length
    ? input.evidence
    : retrieveKnowledgeEvidenceFromDb(db, input.query, {
      topicId: input.topicId,
      limit: limit * 2,
    });
  const deduped = new Map<string, KnowledgeEvidence>();
  const kindCounts = new Map<string, number>();
  for (const item of candidates) {
    if (!item || typeof item.itemId !== 'string' || typeof item.excerpt !== 'string') continue;
    const key = `${item.provenance?.sourceType || item.kind}:${item.provenance?.sourceId || item.itemId}`;
    if (deduped.has(key)) continue;
    const kind = item.kind;
    const kindCount = kindCounts.get(kind) ?? 0;
    if (kindCount >= 8) continue;
    deduped.set(key, {
      ...item,
      title: clean(item.title) || 'Knowledge item',
      excerpt: truncate(clean(item.excerpt), 900),
      url: item.url || null,
    });
    kindCounts.set(kind, kindCount + 1);
    if (deduped.size >= limit) break;
  }
  return [...deduped.values()];
}

function citationLine(item: KnowledgeEvidence, index: number): string {
  const label = clean(item.provenance.sourceLabel || item.title || item.kind);
  const date = item.provenance.capturedAt ? `, ${item.provenance.capturedAt.slice(0, 10)}` : '';
  const url = item.url ? `, ${item.url}` : '';
  return `[${index + 1}] ${label}${date}${url}`;
}

function evidenceBullet(item: KnowledgeEvidence, index: number): string {
  return `- ${item.excerpt} [${index + 1}]`;
}

export function buildContextPackFromDb(
  db: Database,
  input: ContextPackInput,
): ContextPack {
  const query = clean(input.query);
  if (!query) throw new Error('A question or context-pack query is required.');
  const title = clean(input.title) || titleFromQuery(query);
  const evidence = normalizeEvidence(db, input);
  const personal = evidence.filter((item) => item.kind === 'note' || item.kind === 'highlight');
  const generated = evidence.filter((item) => item.kind === 'synthesis');
  const sources = evidence.filter((item) => item.kind !== 'note' && item.kind !== 'highlight' && item.kind !== 'synthesis');
  const sections: string[] = [
    `# ${title}`,
    '',
    `**Working question:** ${query}`,
    '',
    '> This pack separates source material, your own annotations, and generated synthesis so provenance stays visible.',
  ];

  if (input.synthesis?.trim()) {
    sections.push('', '## Current synthesis', '', clean(input.synthesis));
  }
  sections.push('', '## Your annotations', '');
  sections.push(...(personal.length
    ? personal.map((item) => evidenceBullet(item, evidence.indexOf(item)))
    : ['- No personal notes or highlights matched this question yet.']));
  sections.push('', '## Source material', '');
  sections.push(...(sources.length
    ? sources.map((item) => evidenceBullet(item, evidence.indexOf(item)))
    : ['- No primary source bookmarks matched this question yet.']));
  if (generated.length) {
    sections.push('', '## Prior generated synthesis', '');
    sections.push(...generated.map((item) => evidenceBullet(item, evidence.indexOf(item))));
  }
  sections.push('', '## Open work', '');
  sections.push(
    '- Which claim would materially change the next decision?',
    '- What evidence is missing, stale, or contradictory?',
    '- What should be tried, decided, or written next?',
  );
  sections.push('', '## Sources', '');
  sections.push(...(evidence.length
    ? evidence.map(citationLine)
    : ['No matching evidence was found in the local library.']));

  return {
    title,
    query,
    topicId: input.topicId ?? null,
    generatedAt: new Date().toISOString(),
    markdown: sections.join('\n'),
    evidence,
    counts: {
      sources: sources.length,
      personalAnnotations: personal.length,
      generatedSyntheses: generated.length,
    },
  };
}

function answerSummary(synthesis: string | undefined, evidence: KnowledgeEvidence[]): string {
  const direct = clean(synthesis);
  if (direct) return direct;
  if (!evidence.length) return 'The local library does not contain enough matching evidence yet.';
  return evidence.slice(0, 3).map((item) => item.excerpt).join(' ');
}

function checklistFromText(value: string): string[] {
  const parts = value
    .split(/(?<=[.!?])\s+|\n+/)
    .map(clean)
    .filter((line) => line.length > 20)
    .slice(0, 8);
  return parts.length
    ? parts.map((line) => `- [ ] ${line.replace(/[.!?]+$/, '')}`)
    : ['- [ ] Define the next useful action', '- [ ] Gather one confirming and one disconfirming source'];
}

function buildArtifactMarkdown(
  type: MakeArtifactType,
  title: string,
  query: string,
  synthesis: string,
  evidence: KnowledgeEvidence[],
  contextPack: ContextPack,
): string {
  const evidenceLines = evidence.slice(0, 8).map(evidenceBullet);
  const sources = evidence.map(citationLine);
  switch (type) {
    case 'checklist':
      return [
        `# ${title}`,
        '',
        `**Outcome:** ${query}`,
        '',
        '## Actions',
        '',
        ...checklistFromText(synthesis),
        '',
        '## Evidence to keep nearby',
        '',
        ...(evidenceLines.length ? evidenceLines : ['- No supporting evidence found yet.']),
        '',
        '## Sources',
        '',
        ...(sources.length ? sources : ['No matching sources.']),
      ].join('\n');
    case 'decision':
      return [
        `# ${title}`,
        '',
        '## Decision',
        '',
        query,
        '',
        '## Current read',
        '',
        synthesis,
        '',
        '## Evidence',
        '',
        ...(evidenceLines.length ? evidenceLines : ['- No supporting evidence found yet.']),
        '',
        '## Tradeoffs and uncertainty',
        '',
        '- What would have to be true for this choice to work?',
        '- What evidence would reverse the decision?',
        '- What is the smallest reversible next step?',
        '',
        '## Sources',
        '',
        ...(sources.length ? sources : ['No matching sources.']),
      ].join('\n');
    case 'experiment':
      return [
        `# ${title}`,
        '',
        '## Hypothesis',
        '',
        query,
        '',
        '## Why this is worth testing',
        '',
        synthesis,
        '',
        '## Smallest useful test',
        '',
        '- Scope: one narrow workflow or audience',
        '- Duration: short enough to reverse',
        '- Record: baseline, intervention, result, surprise',
        '',
        '## Success criteria',
        '',
        '- Define one observable behavior change.',
        '- Define one failure condition before starting.',
        '',
        '## Evidence',
        '',
        ...(evidenceLines.length ? evidenceLines : ['- No supporting evidence found yet.']),
        '',
        '## Sources',
        '',
        ...(sources.length ? sources : ['No matching sources.']),
      ].join('\n');
    case 'flashcards':
      return [
        `# ${title}`,
        '',
        ...evidence.slice(0, 10).flatMap((item, index) => [
          `## Card ${index + 1}`,
          '',
          `**Q:** What is the useful idea in "${item.title}"?`,
          '',
          `**A:** ${item.excerpt} [${index + 1}]`,
          '',
        ]),
        '## Sources',
        '',
        ...(sources.length ? sources : ['No matching sources.']),
      ].join('\n');
    case 'context_pack':
      return contextPack.markdown;
    case 'brief':
    default:
      return [
        `# ${title}`,
        '',
        '## Executive summary',
        '',
        synthesis,
        '',
        '## Evidence',
        '',
        ...(evidenceLines.length ? evidenceLines : ['- No supporting evidence found yet.']),
        '',
        '## Implications',
        '',
        '- Separate what the sources establish from what remains an inference.',
        '- Recheck time-sensitive claims before acting on them.',
        '- Connect the strongest signal to a project, decision, or experiment.',
        '',
        '## Sources',
        '',
        ...(sources.length ? sources : ['No matching sources.']),
      ].join('\n');
  }
}

export function makeKnowledgeArtifactFromDb(
  db: Database,
  input: MakeArtifactInput,
): MadeArtifact {
  const contextPack = buildContextPackFromDb(db, input);
  const title = clean(input.title) || `${contextPack.title} ${input.type.replace('_', ' ')}`;
  const synthesis = answerSummary(input.synthesis, contextPack.evidence);
  const markdown = buildArtifactMarkdown(
    input.type,
    title,
    contextPack.query,
    synthesis,
    contextPack.evidence,
    contextPack,
  );
  const savedArtifact = saveSynthesisFromDb(db, {
    question: title,
    answer: markdown,
    topicId: input.topicId,
    evidence: contextPack.evidence,
  });
  return {
    type: input.type,
    title,
    markdown,
    evidence: contextPack.evidence,
    savedArtifact,
    contextPack,
  };
}
