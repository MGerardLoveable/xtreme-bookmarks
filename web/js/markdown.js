// Tiny markdown renderer — no dependencies.
//
// Supports a pragmatic subset of GFM:
//   - headings (# .. ######)
//   - bold / italic / inline code
//   - unordered + ordered lists, including task lists and wrapped items
//   - GFM-style tables
//   - code fences
//   - blockquotes
//   - horizontal rules
//   - links [text](url) and wiki links [[page]] or [[page|alias]]
//   - paragraphs
//   - frontmatter (stripped)

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ESC[c]); }

function renderInline(text, opts) {
  let s = escapeHtml(text);
  const tokens = [];
  const stash = (html) => `\u0000MD${tokens.push(html) - 1}\u0000`;

  // Protect generated elements so later URL and emphasis passes cannot
  // accidentally create nested anchors or format code contents.
  s = s.replace(/`([^`]+)`/g, (_, code) => stash(`<code>${code}</code>`));

  // Wiki links: [[path]] or [[path|alias]]
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    const t = String(target).trim();
    const a = alias ? String(alias).trim() : t;
    return stash(`<a href="#" data-wiki="${t}">${a}</a>`);
  });

  // Regular links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const u = url.trim();
    const safe = /^(https?:|\/|#|mailto:)/i.test(u) ? u : '';
    if (!safe) return text;
    return stash(`<a href="${safe}" target="_blank" rel="noopener">${text}</a>`);
  });

  // Bare URLs. Existing links are tokens at this point, so this cannot nest.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"')\]]+)/g, (_, lead, url) =>
    `${lead}${stash(`<a href="${url}" target="_blank" rel="noopener">${url}</a>`)}`);

  // Bold / italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');

  s = s.replace(/\u0000MD(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
  return s;
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableDivider(line) {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isBlockStart(lines, index) {
  const line = lines[index] || '';
  return (
    /^(#{1,6})\s+/.test(line) ||
    /^```/.test(line) ||
    /^>\s?/.test(line) ||
    /^[-*+]\s+/.test(line) ||
    /^\d+\.\s+/.test(line) ||
    /^(---|\*\*\*|___)\s*$/.test(line) ||
    (line.includes('|') && isTableDivider(lines[index + 1] || ''))
  );
}

function collectList(lines, start, ordered, opts) {
  const marker = ordered ? /^\d+\.\s+(.*)$/ : /^[-*+]\s+(.*)$/;
  const anyMarker = /^(?:[-*+]|\d+\.)\s+/;
  const items = [];
  let i = start;

  while (i < lines.length) {
    const match = lines[i].match(marker);
    if (!match) break;
    const parts = [match[1]];
    i++;

    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !anyMarker.test(lines[i]) &&
      !isBlockStart(lines, i)
    ) {
      parts.push(lines[i].trim());
      i++;
    }
    items.push(parts.join(' '));
    while (i < lines.length && lines[i].trim() === '' && marker.test(lines[i + 1] || '')) i++;
  }

  const hasTasks = !ordered && items.some((item) => /^\[[ xX]\]\s+/.test(item));
  const html = items.map((item) => {
    const task = item.match(/^\[([ xX])\]\s+(.*)$/);
    if (!task) return `<li>${renderInline(item, opts)}</li>`;
    const checked = task[1].toLowerCase() === 'x';
    return `<li class="task-list-item"><input type="checkbox" disabled${checked ? ' checked' : ''}><span>${renderInline(task[2], opts)}</span></li>`;
  }).join('');

  return {
    html: `<${ordered ? 'ol' : 'ul'}${hasTasks ? ' class="task-list"' : ''}>${html}</${ordered ? 'ol' : 'ul'}>`,
    next: i,
  };
}

export function renderMarkdown(md, opts = {}) {
  if (!md) return '';

  // Strip YAML frontmatter at start
  let src = String(md).replace(/^---\n[\s\S]*?\n---\n?/, '');

  const lines = src.split(/\r?\n/);
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      i++; // skip closing fence
      out.push(`<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = renderInline(heading[2], opts);
      out.push(`<h${level}>${text}</h${level}>`);
      i++; continue;
    }

    // Horizontal rule
    if (/^(---|\*\*\*|___)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // GFM table
    if (line.includes('|') && isTableDivider(lines[i + 1] || '')) {
      const headers = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      out.push([
        '<div class="markdown-table-wrap"><table>',
        `<thead><tr>${headers.map((cell) => `<th>${renderInline(cell, opts)}</th>`).join('')}</tr></thead>`,
        `<tbody>${rows.map((row) => `<tr>${headers.map((_, index) => `<td>${renderInline(row[index] || '', opts)}</td>`).join('')}</tr>`).join('')}</tbody>`,
        '</table></div>',
      ].join(''));
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), opts)}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      const list = collectList(lines, i, false, opts);
      out.push(list.html);
      i = list.next;
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const list = collectList(lines, i, true, opts);
      out.push(list.html);
      i = list.next;
      continue;
    }

    // Blank line
    if (line.trim() === '') { i++; continue; }

    // Paragraph (collect until blank / block element)
    const pbuf = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !isBlockStart(lines, i)
    ) {
      pbuf.push(lines[i]); i++;
    }
    if (pbuf.length) out.push(`<p>${renderInline(pbuf.join(' '), opts)}</p>`);
  }

  return out.join('\n');
}
