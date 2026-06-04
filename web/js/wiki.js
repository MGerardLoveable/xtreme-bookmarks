// Wiki modal — browse and read generated markdown pages.
//
// Usage:
//   openWiki()              → open modal, show index
//   openWiki('categories/ai') → open modal, load that page

import { api } from './api.js';
import { renderIcons } from './icons.js';
import { $, $$, escape, debounce, toast, copy } from './util.js';
import { renderMarkdown } from './markdown.js';

let rootEl = null;
let pages = [];
let pagesLoaded = false;

function ensureDom() {
  if (rootEl) return rootEl;
  rootEl = document.createElement('div');
  rootEl.className = 'wiki-overlay';
  rootEl.id = 'wiki-overlay';
  rootEl.hidden = true;
  rootEl.innerHTML = `
    <div class="wiki-panel" role="dialog" aria-modal="true" aria-label="Wiki">
      <aside class="wiki-sidebar">
        <header class="wiki-sidebar-header">
          <div class="search">
            <span class="search-icon" data-icon="search"></span>
            <input class="input" id="wiki-search" type="text" placeholder="Search pages…" autocomplete="off">
          </div>
        </header>
        <div class="wiki-tree" id="wiki-tree"><div class="placeholder">Loading…</div></div>
      </aside>
      <main class="wiki-main">
        <header class="wiki-main-header">
          <div class="wiki-breadcrumb" id="wiki-breadcrumb"></div>
          <div class="wiki-main-actions">
            <button class="icon-btn" id="wiki-copy" title="Copy markdown"><span data-icon="copy"></span></button>
            <button class="icon-btn" id="wiki-close" title="Close (Esc)" aria-label="Close"><span data-icon="x"></span></button>
          </div>
        </header>
        <article class="wiki-content" id="wiki-content">
          <div class="empty-state">
            <span class="empty-icon" data-icon="folder"></span>
            <h3>Pick a page</h3>
            <p>Select a page from the left to read its contents.</p>
          </div>
        </article>
      </main>
    </div>
  `;
  document.body.appendChild(rootEl);
  renderIcons(rootEl);

  // Wiring
  rootEl.addEventListener('click', (e) => {
    if (e.target === rootEl) closeWiki();
  });
  $('#wiki-close', rootEl).addEventListener('click', closeWiki);
  $('#wiki-copy', rootEl).addEventListener('click', () => {
    const raw = rootEl.dataset.raw || '';
    if (!raw) return;
    copy(raw).then(() => toast('Copied markdown'));
  });
  $('#wiki-search', rootEl).addEventListener('input', debounce((e) => renderTree(e.target.value), 120));

  // Internal link clicks (markdown links with data-wiki)
  $('#wiki-content', rootEl).addEventListener('click', (e) => {
    const a = e.target.closest('a[data-wiki]');
    if (!a) return;
    e.preventDefault();
    loadPage(a.dataset.wiki);
  });

  return rootEl;
}

async function ensurePages() {
  if (pagesLoaded) return pages;
  try {
    const res = await api.listPages();
    pages = res.pages || [];
    pagesLoaded = true;
  } catch (err) {
    pages = [];
    toast(`Couldn't list pages: ${err.message}`);
  }
  return pages;
}

function renderTree(query = '') {
  const q = query.trim().toLowerCase();
  const filtered = q ? pages.filter((p) => p.path.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)) : pages;

  if (!filtered.length) {
    $('#wiki-tree', rootEl).innerHTML = q
      ? `<div class="placeholder" style="font-size:12px">No matches for "${escape(q)}"</div>`
      : `<div class="empty-state" style="padding:16px"><p>No wiki pages yet. Run <code>ft wiki</code> to generate.</p></div>`;
    return;
  }

  const groups = {};
  for (const p of filtered) (groups[p.type] = groups[p.type] || []).push(p);
  const order = ['root', 'categories', 'domains', 'entities', 'concepts', 'bookmarks'];
  const typesInOrder = [
    ...order.filter((t) => groups[t]),
    ...Object.keys(groups).filter((t) => !order.includes(t)),
  ];

  $('#wiki-tree', rootEl).innerHTML = typesInOrder.map((type) => `
    <section class="wiki-tree-group">
      <div class="wiki-tree-label">${escape(type)}</div>
      ${groups[type].map((p) => `
        <button class="wiki-tree-item" data-p="${escape(p.path)}" title="${escape(p.path)}">
          <span>${escape(p.title)}</span>
        </button>
      `).join('')}
    </section>
  `).join('');

  $$('.wiki-tree-item', rootEl).forEach((btn) => btn.addEventListener('click', () => loadPage(btn.dataset.p)));

  // Highlight active page
  const current = rootEl.dataset.page || '';
  $$('.wiki-tree-item', rootEl).forEach((btn) => btn.classList.toggle('active', btn.dataset.p === current));
}

async function loadPage(pagePath) {
  const content = $('#wiki-content', rootEl);
  content.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;
  renderIcons(content);

  try {
    const { content: md, exists } = await api.getPage(pagePath);
    rootEl.dataset.page = pagePath;
    rootEl.dataset.raw = md || '';

    $('#wiki-breadcrumb', rootEl).innerHTML = pagePath.split('/').map((part, i, arr) => `
      <span class="wiki-breadcrumb-part">${escape(part.replace(/\.md$/, '').replace(/-/g, ' '))}</span>
      ${i < arr.length - 1 ? '<span class="wiki-breadcrumb-sep">/</span>' : ''}
    `).join('');

    if (!exists) {
      content.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon" data-icon="file"></span>
          <h3>Page not found</h3>
          <p>No wiki page at <code>${escape(pagePath)}</code>.</p>
        </div>`;
      renderIcons(content);
      return;
    }

    const html = renderMarkdown(md);
    content.innerHTML = `<div class="wiki-article">${html}</div>`;

    // Update tree highlight
    $$('.wiki-tree-item', rootEl).forEach((btn) => btn.classList.toggle('active', btn.dataset.p === pagePath));
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><h3>Couldn't load</h3><p>${escape(err.message)}</p></div>`;
  }
}

export async function openWiki(initialPath) {
  // Close sibling overlays so we don't stack modals.
  const palette = document.getElementById('palette');
  if (palette && !palette.hidden) palette.hidden = true;
  const help = document.getElementById('help-overlay');
  if (help && !help.hidden) help.hidden = true;

  ensureDom();
  rootEl.hidden = false;
  document.body.style.overflow = 'hidden';

  await ensurePages();
  renderTree('');

  const defaultPath = initialPath || (pages.find((p) => p.path === 'index.md')?.path) || pages[0]?.path;
  if (defaultPath) loadPage(defaultPath);
}

export function closeWiki() {
  if (!rootEl) return;
  rootEl.hidden = true;
  document.body.style.overflow = '';
}

export function isWikiOpen() { return rootEl && !rootEl.hidden; }
