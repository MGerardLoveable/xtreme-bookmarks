// Tiny markdown renderer — no dependencies.
//
// Supports a pragmatic subset of GFM:
//   - headings (# .. ######)
//   - bold / italic / inline code
//   - unordered + ordered lists (flat)
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

  // Inline code (do first so its contents are not formatted)
  s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);

  // Wiki links: [[path]] or [[path|alias]]
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    const t = String(target).trim();
    const a = alias ? String(alias).trim() : t;
    return `<a href="#" data-wiki="${t}">${a}</a>`;
  });

  // Regular links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const u = url.trim();
    const safe = /^(https?:|\/|#|mailto:)/i.test(u) ? u : '';
    if (!safe) return text;
    return `<a href="${safe}" target="_blank" rel="noopener">${text}</a>`;
  });

  // Bare URLs (skip if inside <a>)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)"']+)/g, (_, lead, url) => `${lead}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);

  // Bold / italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');

  return s;
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
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s+/, ''));
        i++;
      }
      out.push(`<ul>${items.map((it) => `<li>${renderInline(it, opts)}</li>`).join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      out.push(`<ol>${items.map((it) => `<li>${renderInline(it, opts)}</li>`).join('')}</ol>`);
      continue;
    }

    // Blank line
    if (line.trim() === '') { i++; continue; }

    // Paragraph (collect until blank / block element)
    const pbuf = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^[-*+]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^(---|\*\*\*|___)\s*$/.test(lines[i])
    ) {
      pbuf.push(lines[i]); i++;
    }
    if (pbuf.length) out.push(`<p>${renderInline(pbuf.join(' '), opts)}</p>`);
  }

  return out.join('\n');
}
