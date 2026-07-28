// Structured Ask result rendering.
//
// The model returns durable Markdown. This module turns that document into a
// scannable research brief while keeping older, less-structured answers useful.

import { renderMarkdown } from './markdown.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESC[char]);
}

const SECTION_TYPES = [
  { kind: 'summary', pattern: /summary|overview|direct answer|answer first/i, icon: 'target', label: 'Summary' },
  { kind: 'actions', pattern: /action|recommend|next move|what to do/i, icon: 'check-circle', label: 'Actions' },
  { kind: 'steps', pattern: /step|plan|roadmap|implementation|workflow/i, icon: 'layers', label: 'Plan' },
  { kind: 'risks', pattern: /risk|gap|caveat|contradiction|uncertaint|limitation/i, icon: 'shield-check', label: 'Caveats' },
  { kind: 'conclusion', pattern: /bottom line|conclusion|takeaway/i, icon: 'sparkles', label: 'Bottom line' },
  { kind: 'sources', pattern: /source|evidence|reference/i, icon: 'library', label: 'Sources' },
  { kind: 'findings', pattern: /finding|analysis|pattern|theme|match|comparison/i, icon: 'search', label: 'Findings' },
];

function sectionType(title) {
  return SECTION_TYPES.find((entry) => entry.pattern.test(title))
    || { kind: 'analysis', icon: 'message-circle', label: title };
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'section';
}

export function normalizeAskMarkdown(value) {
  return String(value ?? '')
    // Repair the nested citation form occasionally emitted by Grok:
    // ([source]([https://x.com/...))](x.com/...)))
    .replace(
      /\(\[source\]\(\[(https?:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]+)[^\n]{0,180}?\)\)\)/gi,
      '[source]($1)',
    )
    .replace(/\[source\]\(\[(https?:\/\/[^\]\s]+)\]\)/gi, '[source]($1)')
    .replace(/\(\[source\]\((https?:\/\/[^)\s]+)\)\)/gi, '[source]($1)');
}

export function parseAskDocument(value, fallbackTitle = 'Research answer') {
  const markdown = normalizeAskMarkdown(value).trim();
  const lines = markdown.split(/\r?\n/);
  let title = fallbackTitle;
  const bodyLines = [];
  let titleFound = false;

  for (const line of lines) {
    const heading = line.match(/^#\s+(.+)$/);
    if (!titleFound && heading) {
      title = heading[1].replace(/\*\*/g, '').trim() || fallbackTitle;
      titleFound = true;
    } else {
      bodyLines.push(line);
    }
  }

  const sections = [];
  let currentTitle = '';
  let currentLines = [];
  const flush = () => {
    const body = currentLines.join('\n').trim();
    if (!body) return;
    const resolvedTitle = currentTitle || (sections.length === 0 ? 'Overview' : 'Analysis');
    sections.push({ title: resolvedTitle, body, ...sectionType(resolvedTitle) });
  };

  for (const line of bodyLines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flush();
      currentTitle = heading[1].replace(/\*\*/g, '').trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  if (sections.length === 0 && markdown) {
    sections.push({
      title: 'Analysis',
      body: markdown,
      ...sectionType('Analysis'),
    });
  }

  const sourceUrls = new Set(
    [...markdown.matchAll(/https?:\/\/[^\s<>"')\]]+/g)]
      .map((match) => match[0].replace(/[.,;:]+$/, '')),
  );
  const wordCount = markdown.split(/\s+/).filter(Boolean).length;
  const actionCount = (markdown.match(/^- \[[ xX]\]\s+/gm) || []).length;

  return {
    title,
    sections,
    sourceCount: sourceUrls.size,
    wordCount,
    actionCount,
  };
}

export function renderAskDocument(value, options = {}) {
  const prefix = slug(options.prefix || 'ask-result');
  const document = parseAskDocument(value, options.fallbackTitle);
  const sectionIds = new Map();

  const sections = document.sections.map((section, index) => {
    const base = `${prefix}-${slug(section.title)}`;
    const duplicate = sectionIds.get(base) || 0;
    sectionIds.set(base, duplicate + 1);
    const id = duplicate ? `${base}-${duplicate + 1}` : base;
    return { ...section, id, index };
  });

  const metrics = [
    `<span><span data-icon="layers"></span>${sections.length} section${sections.length === 1 ? '' : 's'}</span>`,
    `<span><span data-icon="library"></span>${document.sourceCount} cited source${document.sourceCount === 1 ? '' : 's'}</span>`,
    document.actionCount
      ? `<span><span data-icon="check-circle"></span>${document.actionCount} action${document.actionCount === 1 ? '' : 's'}</span>`
      : '',
  ].filter(Boolean).join('');

  const navigation = sections.length > 1 ? `
    <nav class="ask-report-nav" aria-label="Answer sections">
      ${sections.map((section) => `
        <a href="#${section.id}" title="Jump to ${escapeHtml(section.title)}">
          <span data-icon="${section.icon}"></span>
          <span>${escapeHtml(section.label)}</span>
        </a>
      `).join('')}
    </nav>
  ` : '';

  return `
    <div class="ask-report">
      <header class="ask-report-header">
        <div class="ask-report-kicker">Research brief</div>
        <h2>${escapeHtml(document.title)}</h2>
        <div class="ask-report-metrics">${metrics}</div>
      </header>
      ${navigation}
      <div class="ask-report-sections">
        ${sections.map((section) => `
          <section class="ask-report-section" id="${section.id}" data-kind="${section.kind}">
            <div class="ask-report-section-rail" aria-hidden="true">
              <span>${String(section.index + 1).padStart(2, '0')}</span>
              <span data-icon="${section.icon}"></span>
            </div>
            <div class="ask-report-section-main">
              <h3>${escapeHtml(section.title)}</h3>
              <div class="ask-report-copy wiki-article">${renderMarkdown(section.body)}</div>
            </div>
          </section>
        `).join('')}
      </div>
    </div>
  `;
}
