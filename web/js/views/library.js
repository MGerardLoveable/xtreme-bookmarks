// Library view — three-pane reader.
//
// Left rail: read status, collections, categories, domains, top authors.
// Main:      search bar + active-filter chips + virtualized result list.
// Right:     detail pane for the selected bookmark.

import { api, fmtNumber, fmtRelativeTime, fmtDate } from '../api.js';
import { renderIcons, iconSvg } from '../icons.js';
import { $, $$, el, escape, debounce, toast, copy, linkify } from '../util.js';

const PAGE_SIZE = 50;
const CATEGORY_OPTIONS = ['unclassified', 'tool', 'security', 'technique', 'launch', 'research', 'opinion', 'commerce'];
const LS_LIBRARY_PRESENTATION = 'xb.library.presentation';
const LS_LIBRARY_MODE = 'xb.library.mode';
const LS_LIBRARY_SECTION = 'xb.library.section';
const TODAY_REASON_LABELS = {
  overdue_review: 'Review due',
  stale_claim: 'Recheck this claim',
  surprising_connection: 'Connects active work',
  active_project: 'Active project',
  new_capture: 'New signal',
  forgotten_gem: 'Forgotten gem',
  worth_revisiting: 'Worth revisiting',
};
const INTENT_LABELS = {
  learn: 'Learn',
  build: 'Build',
  try: 'Try',
  research: 'Research',
  contact: 'Contact',
  buy: 'Buy',
  inspiration: 'Inspiration',
  reference: 'Reference',
};

function highlightSearchText(value, tokens) {
  const text = String(value || '');
  const searchTokens = (tokens || []).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!searchTokens.length) return escape(text);
  const lower = text.toLowerCase();
  let cursor = 0;
  let html = '';
  while (cursor < text.length) {
    let nextIndex = -1;
    let nextToken = '';
    for (const token of searchTokens) {
      const index = lower.indexOf(token.toLowerCase(), cursor);
      if (index >= 0 && (nextIndex < 0 || index < nextIndex)) {
        nextIndex = index;
        nextToken = token;
      }
    }
    if (nextIndex < 0) {
      html += escape(text.slice(cursor));
      break;
    }
    html += escape(text.slice(cursor, nextIndex));
    html += `<mark class="search-hit">${escape(text.slice(nextIndex, nextIndex + nextToken.length))}</mark>`;
    cursor = nextIndex + nextToken.length;
  }
  return html;
}

function mediaItemsFor(b) {
  const seen = new Set();
  const items = [];
  const add = (url) => {
    if (typeof url !== 'string' || !url.trim()) return;
    const clean = url.trim();
    if (seen.has(clean)) return;
    seen.add(clean);
    items.push(clean);
  };
  (Array.isArray(b.media) ? b.media : []).forEach(add);
  (Array.isArray(b.quotedMedia) ? b.quotedMedia : []).forEach(add);
  return items;
}

function xMediaCandidates(src) {
  if (!src || !/pbs\.twimg\.com/i.test(src)) return [];
  const candidates = [];
  if (!/[?&]name=/.test(src)) candidates.push(src + (src.includes('?') ? '&' : '?') + 'name=small');
  if (/\/media\/[^?]+\.(?:jpg|jpeg|png|webp)$/i.test(src)) candidates.push(src.replace(/\.(jpg|jpeg|png|webp)$/i, '?format=$1&name=small'));
  return candidates.filter((candidate) => candidate !== src);
}

function mediaImg(src) {
  return `<img src="${escape(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-x-media="${escape(src)}">`;
}

function mediaThumb(mediaItems) {
  if (!mediaItems.length) {
    return '<div class="bookmark-thumb bookmark-thumb-empty"><span data-icon="bookmark"></span></div>';
  }
  const shown = mediaItems.slice(0, 4);
  return `
    <div class="bookmark-thumb bookmark-thumb-grid media-${shown.length}">
      ${shown.map(mediaImg).join('')}
      ${mediaItems.length > 4 ? `<span class="thumb-count">+${mediaItems.length - 4}</span>` : ''}
    </div>
  `;
}

export function LibraryView(root) {
  let inboxSince = localStorage.getItem('xb.v2.inbox.since') || new Date(Date.now() - 7 * 86400000).toISOString();
  const state = {
    filters: { q: '', author: null, category: null, domain: null, collection: null, readStatus: null },
    sort: 'desc',
    presentation: localStorage.getItem(LS_LIBRARY_PRESENTATION) || 'refined',
    displayMode: localStorage.getItem(LS_LIBRARY_MODE) || 'reading',
    section: localStorage.getItem(LS_LIBRARY_SECTION) || 'today',
    offset: 0,
    total: 0,
    libraryTotal: 0,
    bookmarks: [],
    activeId: null,
    loading: false,
    hasMore: false,
    facets: { categories: [], domains: [], collections: [], authors: [] },
    inbox: false,
    search: null,
    projects: [],
  };
  let listController = null;
  let detailController = null;

  root.innerHTML = `
    <div class="library">
      <aside class="library-rail" aria-label="Filters">
        <section class="rail-section" id="rail-status">
          <div class="rail-title">Status</div>
          <div class="rail-list" id="rail-status-list"></div>
        </section>
        <section class="rail-section" id="rail-collections">
          <div class="rail-title">Collections</div>
          <div class="rail-list" id="rail-collections-list"><div class="placeholder">—</div></div>
        </section>
        <section class="rail-section" id="rail-categories">
          <div class="rail-title">Categories</div>
          <div class="rail-list" id="rail-categories-list"><div class="placeholder">—</div></div>
        </section>
        <section class="rail-section" id="rail-domains">
          <div class="rail-title">Top domains</div>
          <div class="rail-list" id="rail-domains-list"><div class="placeholder">—</div></div>
        </section>
        <section class="rail-section" id="rail-authors">
          <div class="rail-title">Top authors</div>
          <div class="rail-list" id="rail-authors-list"><div class="placeholder">—</div></div>
        </section>
        <section class="rail-section" id="rail-ideas">
          <div class="rail-title">Ideas
            <button class="btn btn-ghost btn-xs" id="ideas-refresh" title="Refresh ideas">↻</button>
          </div>
          <div class="rail-list" id="lib-ideas-list"><div class="placeholder">—</div></div>
        </section>
      </aside>

      <section class="library-main">
        <header class="library-context">
          <div>
            <span class="library-eyebrow">Signal archive</span>
            <h1 id="lib-section-title">Today</h1>
          </div>
          <div class="library-context-actions">
            <div class="toolbar-segment library-section-switch" id="lib-section" aria-label="Library section">
              <button class="segment-btn" data-section="today"><span data-icon="sun"></span>Today</button>
              <button class="segment-btn" data-section="archive"><span data-icon="layers"></span>Archive</button>
            </div>
            <button class="icon-btn" id="lib-today-refresh" title="Refresh Today" aria-label="Refresh Today">
              <span data-icon="refresh-cw"></span>
            </button>
          </div>
        </header>
        <div class="library-toolbar">
          <button class="btn btn-sm inbox-toggle" id="lib-inbox" title="Review items added since your last review">
            <span data-icon="inbox"></span><span>Inbox</span>
          </button>
          <div class="search library-search">
            <span class="search-icon" data-icon="search"></span>
            <input class="input" id="lib-search" type="text" placeholder="Search bookmarks, @handles, category:tool…" autocomplete="off" spellcheck="false">
            <span class="search-shortcut">/</span>
          </div>
          <div class="toolbar-segment" id="lib-display-mode" aria-label="Display mode">
            <button class="segment-btn" data-mode="reading">Reading</button>
            <button class="segment-btn" data-mode="triage">Triage</button>
            <button class="segment-btn" data-mode="gallery">Gallery</button>
          </div>
          <button class="btn btn-ghost btn-sm" id="lib-presentation" title="Switch between refined and classic Library">
            <span data-icon="layers"></span><span id="lib-presentation-label">Classic</span>
          </button>
          <button class="btn btn-ghost btn-sm" id="lib-sort" title="Toggle sort direction">
            <span data-icon="calendar"></span><span id="lib-sort-label">Newest</span>
          </button>
          <button class="btn btn-ghost btn-sm" id="lib-clear" title="Clear all filters">
            <span data-icon="x"></span>Clear
          </button>
          <button class="icon-btn library-filter-toggle" id="lib-filters" title="Show filters" aria-label="Show filters" aria-expanded="false">
            <span data-icon="sliders-horizontal"></span>
          </button>
        </div>
        <div class="library-grab-status" id="lib-grab-status" hidden>
          <span class="library-grab-spinner" aria-hidden="true"></span>
          <span id="lib-grab-status-text">Grab starting...</span>
        </div>
        <div class="active-filters" id="lib-active"></div>
        <div class="results-summary" id="lib-summary"><span>—</span></div>
        <div class="bookmark-list" id="lib-list"></div>
      </section>

      <button class="library-rail-scrim" id="lib-rail-scrim" aria-label="Close filters" hidden></button>
      <aside class="library-detail" id="lib-detail" aria-label="Bookmark detail">
        <div class="detail-empty detail-empty-shell">
          <span class="detail-empty-icon" data-icon="library"></span>
          <span class="detail-empty-kicker">Reading desk</span>
          <h2>Open a signal</h2>
          <p>Select any bookmark to read the full post, inspect media, add notes, or file it into a Topic.</p>
          <span class="detail-empty-hint"><kbd>j</kbd><kbd>k</kbd> to move through the queue</span>
        </div>
      </aside>
    </div>
  `;

  renderIcons(root);

  // Ideas rail integration
  async function loadLibraryIdeas() {
    try {
      const res = await fetch('/api/ideas');
      const ideas = await res.json();
      const container = els.ideasList || $('#lib-ideas-list', root);
      if (!container) return;

      if (!ideas || ideas.length === 0) {
        container.innerHTML = `<div class="rail-empty">No ideas yet</div>`;
        return;
      }

      container.innerHTML = ideas.slice(0, 5).map(idea => `
        <div class="rail-idea-item" data-id="${idea.id}">
          <div class="rail-idea-title">${escape(idea.title || 'Untitled')}</div>
          <div class="rail-idea-meta">${new Date(idea.created).toLocaleDateString()}</div>
        </div>
      `).join('');

      container.querySelectorAll('.rail-idea-item').forEach(el => {
        el.addEventListener('click', () => {
          const id = el.dataset.id;
          // For now just alert - we can open in Brain or modal later
          const idea = ideas.find(i => i.id === id);
          if (idea) showIdeaModal(idea);
        });
      });
    } catch (e) {
      console.warn('Could not load ideas for library rail');
    }
  }

  loadLibraryIdeas();

  const els = {
    search: $('#lib-search', root),
    sort: $('#lib-sort', root),
    sortLabel: $('#lib-sort-label', root),
    clear: $('#lib-clear', root),
    presentation: $('#lib-presentation', root),
    presentationLabel: $('#lib-presentation-label', root),
    displayMode: $('#lib-display-mode', root),
    section: $('#lib-section', root),
    sectionTitle: $('#lib-section-title', root),
    todayRefresh: $('#lib-today-refresh', root),
    active: $('#lib-active', root),
    summary: $('#lib-summary', root),
    grabStatus: $('#lib-grab-status', root),
    grabStatusText: $('#lib-grab-status-text', root),
    list: $('#lib-list', root),
    detail: $('#lib-detail', root),
    railStatus: $('#rail-status-list', root),
    railCollections: $('#rail-collections-list', root),
    railCategories: $('#rail-categories-list', root),
    railDomains: $('#rail-domains-list', root),
    railAuthors: $('#rail-authors-list', root),
    ideasList: $('#lib-ideas-list', root),
  };

  const shell = $('.library', root);

  function applySection() {
    const isToday = state.section === 'today';
    shell.classList.toggle('library-today', isToday);
    els.sectionTitle.textContent = isToday ? 'Today' : 'Research Library';
    els.todayRefresh.hidden = !isToday;
    els.sort.hidden = isToday;
    els.clear.hidden = isToday;
    $('#lib-inbox', root).hidden = isToday;
    $$('.segment-btn', els.section).forEach((btn) => {
      const active = btn.dataset.section === state.section;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function setSection(section, options = {}) {
    const next = section === 'archive' ? 'archive' : 'today';
    const changed = state.section !== next;
    state.section = next;
    localStorage.setItem(LS_LIBRARY_SECTION, next);
    state.offset = 0;
    state.search = null;
    if (changed) {
      els.search.value = next === 'today' ? '' : state.filters.q;
    }
    applySection();
    renderActive();
    if (options.load !== false && (changed || options.refresh)) load(false, Boolean(options.refresh));
  }

  function applyPresentation() {
    const presentation = state.presentation === 'classic' ? 'classic' : 'refined';
    const mode = ['reading', 'triage', 'gallery'].includes(state.displayMode) ? state.displayMode : 'reading';
    shell.classList.toggle('library-classic', presentation === 'classic');
    shell.classList.toggle('library-refined', presentation !== 'classic');
    shell.classList.toggle('mode-reading', mode === 'reading');
    shell.classList.toggle('mode-triage', mode === 'triage');
    shell.classList.toggle('mode-gallery', mode === 'gallery');
    els.presentationLabel.textContent = presentation === 'classic' ? 'Refined' : 'Classic';
    els.presentation.title = presentation === 'classic' ? 'Use the refined Library' : 'Fall back to the classic Library';
    $$('.segment-btn', els.displayMode).forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
    });
    applySection();
  }

  function setPresentation(next) {
    state.presentation = next === 'classic' ? 'classic' : 'refined';
    localStorage.setItem(LS_LIBRARY_PRESENTATION, state.presentation);
    applyPresentation();
  }

  function setDisplayMode(mode) {
    if (!['reading', 'triage', 'gallery'].includes(mode)) return;
    state.displayMode = mode;
    localStorage.setItem(LS_LIBRARY_MODE, mode);
    applyPresentation();
  }

  function updateGrabStatus(detail) {
    if (!els.grabStatus || !els.grabStatusText) return;
    const visible = detail && detail.state && detail.state !== 'idle';
    els.grabStatus.hidden = !visible;
    if (!visible) return;
    els.grabStatus.dataset.state = detail.state;
    els.grabStatusText.textContent = detail.message || 'Grab running...';
  }

  document.addEventListener('xb:grab-status', (event) => updateGrabStatus(event.detail));
  updateGrabStatus(window.__xbGrabStatus);

  // ── Facets ────────────────────────────────────────────────────────────────
  async function loadFacets() {
    try {
      const [cats, doms, cols, stats, unread] = await Promise.all([
        api.categories(),
        api.domains(),
        api.collections().catch(() => ({ collections: [] })),
        api.stats(),
        api.unreadCount().catch(() => ({ count: 0 })),
      ]);
      state.facets.categories = (cats.categories || []).filter((c) => c.name);
      state.facets.domains = (doms.domains || []).filter((d) => d.name);
      state.facets.collections = cols.collections || [];
      state.facets.authors = stats.topAuthors || [];
      state.libraryTotal = stats.totalBookmarks || 0;
      state.unreadCount = unread.count;
      renderRails();
    } catch (err) {
      console.error('Failed to load facets', err);
    }
  }

  function renderRails() {
    // Status
    const statusItems = [
      { key: null, label: 'All', count: state.libraryTotal || state.total || undefined },
      { key: 'unread', label: 'Unread', count: state.unreadCount },
      { key: 'read', label: 'Read' },
    ];
    els.railStatus.innerHTML = statusItems.map((it) => `
      <button class="rail-item ${state.filters.readStatus === it.key ? 'active' : ''}" data-status="${it.key ?? ''}">
        <span>${escape(it.label)}</span>
        ${it.count != null ? `<span class="rail-item-count">${fmtNumber(it.count)}</span>` : ''}
      </button>
    `).join('');
    $$('.rail-item', els.railStatus).forEach((btn) =>
      btn.addEventListener('click', () => setFilter({ readStatus: btn.dataset.status || null }))
    );

    // Collections
    const cols = state.facets.collections;
    if (!cols.length) {
      els.railCollections.innerHTML = '<div class="placeholder" style="font-size:11px;padding:6px">None yet</div>';
    } else {
      els.railCollections.innerHTML = cols.slice(0, 14).map((c) => `
        <button class="rail-item ${state.filters.collection === c.name ? 'active' : ''}" data-col="${escape(c.name)}">
          <span>${escape(c.name)}</span>
          <span class="rail-item-count">${fmtNumber(c.count ?? 0)}</span>
        </button>
      `).join('');
      $$('.rail-item', els.railCollections).forEach((btn) =>
        btn.addEventListener('click', () => setFilter({ collection: btn.dataset.col }))
      );
    }

    // Categories
    els.railCategories.innerHTML = state.facets.categories.slice(0, 10).map((c) => `
      <button class="rail-item ${state.filters.category === c.name ? 'active' : ''}" data-cat="${escape(c.name)}">
        <span>${escape(c.name)}</span>
        <span class="rail-item-count">${fmtNumber(c.count)}</span>
      </button>
    `).join('') || '<div class="placeholder" style="font-size:11px;padding:6px">None</div>';
    $$('.rail-item', els.railCategories).forEach((btn) =>
      btn.addEventListener('click', () => setFilter({ category: btn.dataset.cat }))
    );

    // Domains
    els.railDomains.innerHTML = state.facets.domains.slice(0, 10).map((d) => `
      <button class="rail-item ${state.filters.domain === d.name ? 'active' : ''}" data-dom="${escape(d.name)}">
        <span>${escape(d.name)}</span>
        <span class="rail-item-count">${fmtNumber(d.count)}</span>
      </button>
    `).join('') || '<div class="placeholder" style="font-size:11px;padding:6px">None</div>';
    $$('.rail-item', els.railDomains).forEach((btn) =>
      btn.addEventListener('click', () => setFilter({ domain: btn.dataset.dom }))
    );

    // Authors
    els.railAuthors.innerHTML = state.facets.authors.slice(0, 10).map((a) => `
      <button class="rail-item ${state.filters.author === a.handle ? 'active' : ''}" data-author="${escape(a.handle)}">
        <span>@${escape(a.handle)}</span>
        <span class="rail-item-count">${fmtNumber(a.count)}</span>
      </button>
    `).join('') || '<div class="placeholder" style="font-size:11px;padding:6px">None</div>';
    $$('.rail-item', els.railAuthors).forEach((btn) =>
      btn.addEventListener('click', () => setFilter({ author: btn.dataset.author }))
    );
  }

  function renderActive() {
    if (state.section === 'today') {
      els.active.innerHTML = '';
      return;
    }
    const chips = [];
    const f = state.filters;
    if (f.q)          chips.push({ k: 'q', label: `“${f.q}”`, icon: 'search' });
    if (f.author)     chips.push({ k: 'author', label: `@${f.author}`, icon: 'user-round' });
    if (f.category)   chips.push({ k: 'category', label: f.category, icon: 'tag' });
    if (f.domain)     chips.push({ k: 'domain', label: f.domain, icon: 'globe' });
    if (f.collection) chips.push({ k: 'collection', label: f.collection, icon: 'folder' });
    if (f.readStatus) chips.push({ k: 'readStatus', label: f.readStatus === 'unread' ? 'Unread only' : 'Read only', icon: 'eye' });

    els.active.innerHTML = chips.map((c) => `
      <button class="chip chip-on chip-removable" data-clear="${c.k}">
        <span data-icon="${c.icon}"></span>${escape(c.label)}<span data-icon="x"></span>
      </button>
    `).join('');
    renderIcons(els.active);
    $$('.chip-removable', els.active).forEach((chip) =>
      chip.addEventListener('click', () => setFilter({ [chip.dataset.clear]: null }))
    );
  }

  // ── Filter state ──────────────────────────────────────────────────────────
  function setFilter(patch) {
    const next = { ...patch };
    const hasQuery = Object.prototype.hasOwnProperty.call(next, 'q');
    setSection('archive', { load: false });
    // Toggle behavior: clicking the same rail item clears it.
    Object.keys(next).forEach((k) => {
      if (k !== 'q' && state.filters[k] === next[k] && next[k] !== null) next[k] = null;
    });
    Object.assign(state.filters, next);
    if (hasQuery) els.search.value = state.filters.q || '';
    state.offset = 0;
    renderActive();
    renderRails();
    load();
  }

  function clearAll() {
    setSection('archive', { load: false });
    state.filters = { q: '', author: null, category: null, domain: null, collection: null, readStatus: null };
    els.search.value = '';
    state.inbox = false;
    $('#lib-inbox', root).classList.remove('btn-on');
    state.offset = 0;
    renderActive();
    renderRails();
    load();
  }

  // ── Load bookmarks ────────────────────────────────────────────────────────
  async function load(append = false, refreshToday = false) {
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    const requestedSection = state.section;
    state.loading = true;
    if (!append) renderSkeleton();
    try {
      if (requestedSection === 'today') {
        const result = await api.today(7, refreshToday, { signal: controller.signal });
        if (controller.signal.aborted || state.section !== requestedSection) return;
        state.total = result.items?.length || 0;
        state.search = null;
        state.hasMore = false;
        state.bookmarks = (result.items || []).map((item) => ({
          ...item.bookmark,
          _today: {
            id: item.id,
            reason: item.reason,
            score: item.score,
            scoreBreakdown: item.scoreBreakdown || [],
          },
        }));
        renderList();
        renderSummary();
        if (!append) renderRails();
        return;
      }
      const params = {
        q: state.filters.q || undefined,
        author: state.filters.author || undefined,
        category: state.filters.category || undefined,
        domain: state.filters.domain || undefined,
        collection: state.filters.collection || undefined,
        readStatus: state.filters.readStatus || undefined,
        capturedAfter: state.inbox ? inboxSince : undefined,
        sort: state.sort,
        limit: PAGE_SIZE,
        offset: state.offset,
      };
      const { bookmarks, total, search } = await api.listBookmarks(params, { signal: controller.signal });
      if (controller.signal.aborted || state.section !== requestedSection) return;
      state.total = total;
      state.search = search || null;
      state.hasMore = state.offset + bookmarks.length < total;
      state.bookmarks = append ? [...state.bookmarks, ...bookmarks] : bookmarks;
      renderList();
      renderSummary();
      if (!append) renderRails(); // status counts may update
    } catch (err) {
      if (err.name === 'AbortError') return;
      els.list.innerHTML = `<div class="empty-state"><h3>Couldn't load</h3><p>${escape(err.message)}</p></div>`;
    } finally {
      if (listController === controller) state.loading = false;
    }
  }

  function renderSummary() {
    const total = state.total;
    const shown = state.bookmarks.length;
    if (state.section === 'today') {
      els.summary.innerHTML = `
        <span><strong style="color:var(--fg)">${fmtNumber(shown)}</strong> signals selected for today</span>
        <span class="summary-context">Balanced across goals, freshness, and forgotten value</span>
      `;
      return;
    }
    const activeFilter = state.filters.collection || state.filters.category || state.filters.domain || state.filters.author || state.filters.readStatus || '';
    els.summary.innerHTML = `
      <span><strong style="color:var(--fg)">${fmtNumber(shown)}</strong> of ${fmtNumber(total)} results</span>
      ${activeFilter ? `<span class="summary-context">${escape(String(activeFilter))}</span>` : ''}
      ${state.search?.correction ? `<button class="search-correction" id="lib-search-correction">Showing results for <strong>${escape(state.search.correction)}</strong><span>Clear</span></button>` : ''}
      ${state.inbox ? `<span class="summary-context"><span data-icon="inbox"></span>Since ${escape(new Date(inboxSince).toLocaleDateString())}</span><button class="btn btn-sm btn-ghost" id="lib-inbox-done">Mark inbox reviewed</button>` : ''}
    `;
    renderIcons(els.summary);
    $('#lib-inbox-done', els.summary)?.addEventListener('click', () => {
      localStorage.setItem('xb.v2.inbox.since', new Date().toISOString());
      inboxSince = localStorage.getItem('xb.v2.inbox.since');
      state.inbox = false;
      $('#lib-inbox', root).classList.remove('btn-on');
      state.offset = 0;
      load();
      toast('Inbox reviewed');
    });
    $('#lib-search-correction', els.summary)?.addEventListener('click', () => {
      state.search = null;
      state.filters.q = '';
      els.search.value = '';
      state.offset = 0;
      load();
    });
  }

  function renderSkeleton() {
    els.list.innerHTML = Array.from({ length: 7 }).map(() => `
      <div class="bookmark-row bookmark-row-skeleton">
        <div class="bookmark-avatar"></div>
        <div class="bookmark-body">
          <div class="skeleton-line skeleton-meta"></div>
          <div class="skeleton-line"></div>
          <div class="skeleton-line short"></div>
        </div>
      </div>
    `).join('');
  }

  // ── Render list ───────────────────────────────────────────────────────────
  function renderList() {
    if (!state.bookmarks.length) {
      els.list.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon" data-icon="${state.section === 'today' ? 'check-circle' : 'inbox'}"></span>
          <h3>${state.section === 'today' ? 'Today is clear' : 'No bookmarks found'}</h3>
          <p>${state.section === 'today'
            ? 'Refresh when you want another small set of useful signals.'
            : state.filters.q
              ? `No tweet text, quoted post, note, highlight, author, link, or domain matched “${escape(state.filters.q)}”.`
              : 'Try removing a filter or running Grab.'}</p>
          ${state.section === 'today' ? '<button class="btn" id="lib-empty-refresh"><span data-icon="refresh-cw"></span>Refresh</button>' : ''}
        </div>`;
      renderIcons(els.list);
      $('#lib-empty-refresh', els.list)?.addEventListener('click', () => load(false, true));
      return;
    }

    const frag = document.createDocumentFragment();
    state.bookmarks.forEach((b, idx) => {
      frag.appendChild(renderRow(b, idx));
    });

    // Load more
    if (state.hasMore) {
      const more = el('div', { style: { padding: '16px', textAlign: 'center' } }, [
        el('button', {
          class: 'btn btn-ghost', onclick: () => { state.offset += PAGE_SIZE; load(true); },
        }, ['Load more']),
      ]);
      frag.appendChild(more);
    }

    els.list.innerHTML = '';
    els.list.appendChild(frag);
    renderIcons(els.list);
  }

  function renderRow(b, idx) {
    const active = b.id === state.activeId;
    const today = b._today;
    const mediaItems = mediaItemsFor(b);
    const avatar = b.authorProfileImageUrl
      ? `<img src="${escape(b.authorProfileImageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'bookmark-avatar-fallback',textContent:'${escape((b.authorName || b.authorHandle || '?').slice(0, 1).toUpperCase())}'}))">`
      : `<div class="bookmark-avatar-fallback">${escape((b.authorName || b.authorHandle || '?').slice(0, 1).toUpperCase())}</div>`;
    const wikiTag = b.inWiki ? '<span class="chip"><span data-icon="brain-circuit"></span>Topic source</span>' : '';
    const tags = [
      wikiTag,
      ...(b.categories || []).slice(0, 3).map((c) => `<span class="chip chip-cat chip-cat-${escape(String(c).toLowerCase())}">${escape(c)}</span>`),
    ].filter(Boolean).join('');
    const postedOrBookmarked = b.bookmarkedAt || b.postedAt;
    const searchTokens = state.search?.tokens || [];
    const matchedFields = Array.isArray(b.searchMatch) ? b.searchMatch : [];
    const matchLabel = matchedFields.length
      ? `<span class="search-match-label">Matched ${escape(matchedFields.join(', '))}</span>`
      : '';
    const quotedContext = matchedFields.includes('quoted post') && b.quotedText
      ? `<div class="search-match-context"><span>Quoted</span>${highlightSearchText(b.quotedText, searchTokens)}</div>`
      : '';
    const todayReason = today ? TODAY_REASON_LABELS[today.reason] || 'Worth revisiting' : '';
    const todayWhy = today
      ? (today.scoreBreakdown || []).slice(0, 2).map((part) => part.label).join(' · ')
      : '';
    const row = el('article', {
      class: `bookmark-row${active ? ' active' : ''}${b.isRead ? ' read' : ''}${today ? ' today-row' : ''}`,
      dataset: { id: b.id, idx: String(idx) },
      tabindex: '0',
      'aria-label': `Open bookmark by ${b.authorName || b.authorHandle || 'Unknown'}`,
    });
    row.innerHTML = `
      <div class="bookmark-avatar">${avatar}</div>
      <div class="bookmark-body">
        ${today ? `
          <div class="today-reason">
            <span><span data-icon="sparkles"></span>${escape(todayReason)}</span>
            <span title="${escape(todayWhy)}">${escape(todayWhy)}</span>
          </div>
        ` : ''}
        <div class="bookmark-meta">
          <span class="bookmark-author">${escape(b.authorName || b.authorHandle || 'Unknown')}</span>
          ${b.authorHandle ? `<span class="bookmark-handle">@${escape(b.authorHandle)}</span>` : ''}
          <span>·</span>
          <span title="${escape(postedOrBookmarked || '')}">${fmtRelativeTime(postedOrBookmarked)}</span>
          ${b.mediaCount ? `<span>·</span><span>${b.mediaCount} media</span>` : ''}
        </div>
        <div class="bookmark-text">${highlightSearchText(b.text || '', searchTokens)}</div>
        ${quotedContext}
        ${matchLabel}
        ${tags ? `<div class="bookmark-tags">${tags}</div>` : ''}
        ${today ? `
          <div class="today-row-actions" aria-label="Today actions">
            <button class="btn btn-sm" data-today-action="done"><span data-icon="check"></span>Done</button>
            <button class="btn btn-sm btn-ghost" data-today-action="snooze"><span data-icon="clock-3"></span>Snooze</button>
            <button class="icon-btn" data-today-action="dismiss" title="Dismiss from Today" aria-label="Dismiss from Today"><span data-icon="x"></span></button>
          </div>
        ` : ''}
      </div>
      ${mediaThumb(mediaItems)}
      <div class="bookmark-row-actions">
        <button class="row-action" data-row-action="read" title="${b.isRead ? 'Mark unread' : 'Mark read'}" aria-label="${b.isRead ? 'Mark unread' : 'Mark read'}">
          <span data-icon="${b.isRead ? 'eye-off' : 'check-circle'}"></span>
        </button>
        <button class="row-action" data-row-action="brain" title="${b.inWiki ? 'Remove from Topics' : 'Add to Topics'}" aria-label="${b.inWiki ? 'Remove from Topics' : 'Add to Topics'}">
          <span data-icon="brain-circuit"></span>
        </button>
        <a class="row-action" href="${escape(b.url || '#')}" target="_blank" rel="noopener" data-row-action="open" title="Open on X" aria-label="Open on X">
          <span data-icon="external-link"></span>
        </a>
      </div>
    `;
    wireMediaFallbacks(row);
    row.querySelectorAll('[data-today-action]').forEach((action) => {
      action.addEventListener('click', async (event) => {
        event.stopPropagation();
        action.disabled = true;
        try {
          await api.todayAction(today.id, action.dataset.todayAction);
          state.bookmarks = state.bookmarks.filter((item) => item.id !== b.id);
          state.total = state.bookmarks.length;
          if (state.activeId === b.id) clearDetail();
          renderList();
          renderSummary();
          toast(action.dataset.todayAction === 'snooze' ? 'Snoozed for a week' : 'Today updated');
        } catch (err) {
          action.disabled = false;
          toast(`Today update failed: ${err.message}`);
        }
      });
    });
    row.querySelectorAll('[data-row-action]').forEach((action) => {
      action.addEventListener('click', async (event) => {
        event.stopPropagation();
        const kind = action.dataset.rowAction;
        if (kind === 'open') return;
        action.disabled = true;
        try {
          if (kind === 'read') {
            const res = await api.setRead(b.id, !b.isRead);
            b.isRead = Boolean(res.isRead);
            patchBookmark(b.id, { isRead: b.isRead });
            renderList();
            toast(b.isRead ? 'Marked as read' : 'Marked as unread');
          }
          if (kind === 'brain') {
            const res = await api.setWiki(b.id, !b.inWiki);
            b.inWiki = Boolean(res.inWiki);
            patchBookmark(b.id, { inWiki: b.inWiki });
            renderList();
            toast(b.inWiki ? 'Added to Topics' : 'Removed from Topics');
          }
        } catch (err) {
          toast(`Action failed: ${err.message}`);
        } finally {
          action.disabled = false;
        }
      });
    });
    row.addEventListener('click', () => select(b.id));
    row.addEventListener('keydown', (event) => {
      if (event.target !== row) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select(b.id);
      }
    });
    return row;
  }

  // ── Detail pane ───────────────────────────────────────────────────────────
  async function select(id) {
    detailController?.abort();
    detailController = new AbortController();
    state.activeId = id;
    // Update row highlight
    $$('.bookmark-row', els.list).forEach((r) => r.classList.toggle('active', r.dataset.id === id));

    try {
      const [b, projectData] = await Promise.all([
        api.getBookmark(id, { signal: detailController.signal }),
        api.brainSpaces().catch(() => ({ spaces: [] })),
      ]);
      state.projects = projectData.spaces || [];
      renderDetail(b);
      shell.classList.add('detail-open');
    } catch (err) {
      if (err.name === 'AbortError') return;
      els.detail.innerHTML = `<div class="detail-empty">Failed to load: ${escape(err.message)}</div>`;
      shell.classList.add('detail-open');
    }
  }

  function clearDetail() {
    state.activeId = null;
    $$('.bookmark-row', els.list).forEach((r) => r.classList.remove('active'));
    shell.classList.remove('detail-open');
    renderDetail(null);
  }

  function patchBookmark(id, patch) {
    const item = state.bookmarks.find((b) => b.id === id);
    if (item) Object.assign(item, patch);
  }

  function wireMediaFallbacks(scope) {
    $$('img[data-x-media]', scope).forEach((img) => {
      if (img.dataset.mediaFallbackReady === '1') return;
      img.dataset.mediaFallbackReady = '1';
      img.addEventListener('error', () => {
        const candidates = xMediaCandidates(img.dataset.xMedia || img.getAttribute('src'));
        const index = Number(img.dataset.fallbackIndex || 0);
        const next = candidates[index];
        if (next) {
          img.dataset.fallbackIndex = String(index + 1);
          img.src = next;
        } else {
          img.closest('.bookmark-thumb')?.classList.add('media-missing');
          img.classList.add('media-hidden');
        }
      });
    });
  }

  function renderDetail(b) {
    if (!b) {
      els.detail.innerHTML = `
        <div class="detail-empty detail-empty-shell">
          <span class="detail-empty-icon" data-icon="library"></span>
          <span class="detail-empty-kicker">Reading desk</span>
          <h2>Open a signal</h2>
          <p>Select any bookmark to read the full post, inspect media, add notes, or file it into a Topic.</p>
          <span class="detail-empty-hint"><kbd>j</kbd><kbd>k</kbd> to move through the queue</span>
        </div>`;
      renderIcons(els.detail);
      return;
    }

    const avatar = b.authorProfileImageUrl
      ? `<img src="${escape(b.authorProfileImageUrl)}" alt="" style="width:48px;height:48px;border-radius:50%;object-fit:cover" referrerpolicy="no-referrer">`
      : `<div class="bookmark-avatar" style="width:48px;height:48px"><div class="bookmark-avatar-fallback">${escape((b.authorName || b.authorHandle || '?').slice(0, 1).toUpperCase())}</div></div>`;

    const posted = b.postedAt ? fmtDate(b.postedAt) : '';
    const bookmarked = b.bookmarkedAt ? fmtDate(b.bookmarkedAt) : '';
    const currentCategory = (b.primaryCategory || (b.categories && b.categories[0]) || 'unclassified').toLowerCase();
    const categoryOptions = CATEGORY_OPTIONS.includes(currentCategory)
      ? CATEGORY_OPTIONS
      : [currentCategory, ...CATEGORY_OPTIONS];
    const collections = Array.isArray(b.collections) ? b.collections : [];
    const mediaItems = mediaItemsFor(b);
    const activation = b.activation || {};
    const profile = activation.profile || {};
    const enrichment = activation.enrichment || null;
    const projects = Array.isArray(activation.projects) ? activation.projects : [];
    const availableProjects = (state.projects || []).filter((space) => space.status !== 'archived');
    const nextReviewDate = profile.nextReviewAt ? String(profile.nextReviewAt).slice(0, 10) : '';

    els.detail.innerHTML = `
      <div class="detail">
        <div class="detail-header">
          ${avatar}
          <div class="detail-author">
            <span class="detail-author-name">${escape(b.authorName || b.authorHandle || 'Unknown')}</span>
            ${b.authorHandle ? `<span class="detail-author-handle">@${escape(b.authorHandle)}</span>` : ''}
          </div>
          <button class="icon-btn" id="detail-copy" title="Copy as Markdown" aria-label="Copy as Markdown"><span data-icon="copy"></span></button>
          <button class="icon-btn" id="detail-close" title="Close detail" aria-label="Close detail"><span data-icon="x"></span></button>
        </div>

        <div class="detail-text">${linkify(b.text || '')}</div>

        ${mediaItems.length ? `
          <div class="detail-media">
            ${mediaItems.map(mediaImg).join('')}
          </div>
        ` : ''}

        ${(b.categories && b.categories.length) || (b.domains && b.domains.length) ? `
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${(b.categories || []).map((c) => `<span class="chip chip-cat chip-cat-${escape(String(c).toLowerCase())}"><span data-icon="tag"></span>${escape(c)}</span>`).join('')}
            ${(b.domains || []).map((d) => `<span class="chip"><span data-icon="globe"></span>${escape(d)}</span>`).join('')}
          </div>
        ` : ''}

        <div class="detail-stats">
          <div class="detail-stat"><div class="detail-stat-value">${fmtNumber(b.likeCount ?? 0)}</div><div class="detail-stat-label">Likes</div></div>
          <div class="detail-stat"><div class="detail-stat-value">${fmtNumber(b.repostCount ?? 0)}</div><div class="detail-stat-label">Reposts</div></div>
          <div class="detail-stat"><div class="detail-stat-value">${fmtNumber(b.viewCount ?? 0)}</div><div class="detail-stat-label">Views</div></div>
        </div>

        <div class="detail-actions">
          <a class="btn btn-primary btn-block" href="${escape(b.url || '#')}" target="_blank" rel="noopener">
            <span data-icon="external-link"></span>Open on X
          </a>
          <button class="btn btn-block" id="detail-read">
            <span data-icon="${b.isRead ? 'eye-off' : 'check-circle'}"></span>${b.isRead ? 'Mark unread' : 'Mark read'}
          </button>
          <button class="btn btn-block ${b.inWiki ? 'btn-on' : ''}" id="detail-wiki">
            <span data-icon="brain-circuit"></span>${b.inWiki ? 'In Topics' : 'Add to Topics'}
          </button>
          <button class="btn btn-block" id="detail-build-brain">
            <span data-icon="zap"></span>Refresh topic index
          </button>
        </div>

        <section class="detail-activation">
          <div class="detail-section-heading">
            <div>
              <span class="detail-section-kicker">Activation</span>
              <div class="detail-section-title">Make this useful</div>
            </div>
            <button class="btn btn-sm" id="detail-activation-save"><span data-icon="check"></span>Save</button>
          </div>
          <div class="activation-fields">
            <label class="detail-field">
              <span>Intent</span>
              <select class="input detail-select" id="detail-intent">
                <option value="">Not set</option>
                ${Object.entries(INTENT_LABELS).map(([value, label]) => `
                  <option value="${value}" ${profile.intent === value ? 'selected' : ''}>${label}</option>
                `).join('')}
              </select>
            </label>
            <label class="detail-field activation-importance">
              <span>Importance <output id="detail-importance-value">${Number(profile.importance || 0)}</output>/5</span>
              <input id="detail-importance" type="range" min="0" max="5" step="1" value="${Number(profile.importance || 0)}">
            </label>
            <label class="detail-field">
              <span>Status</span>
              <select class="input detail-select" id="detail-activation-status">
                ${['active', 'done', 'archived'].map((value) => `
                  <option value="${value}" ${(profile.status || 'active') === value ? 'selected' : ''}>${value.charAt(0).toUpperCase() + value.slice(1)}</option>
                `).join('')}
              </select>
            </label>
            <label class="detail-field">
              <span>Review</span>
              <input class="input" id="detail-review-date" type="date" value="${escape(nextReviewDate)}">
            </label>
          </div>
          <label class="detail-field">
            <span>Why I saved this</span>
            <textarea class="activation-why" id="detail-why-saved" placeholder="The decision, project, or question this could help with…">${escape(profile.whySaved || '')}</textarea>
          </label>

          <div class="activation-distill">
            <div class="activation-distill-heading">
              <span><span data-icon="sparkles"></span>Brain Cycle</span>
              <span>${enrichment ? `Updated ${escape(fmtRelativeTime(enrichment.enrichedAt))} ago` : 'Not distilled yet'}</span>
            </div>
            ${enrichment ? `
              <div class="activation-insight">
                <span>Summary</span>
                <p>${escape(enrichment.summary)}</p>
              </div>
              <div class="activation-insight">
                <span>Key claim</span>
                <p>${escape(enrichment.keyClaim)}</p>
              </div>
              <div class="activation-insight">
                <span>Why it matters</span>
                <p>${escape(enrichment.whyItMatters)}</p>
              </div>
              <div class="activation-insight activation-next">
                <span>Next move</span>
                <p>${escape(enrichment.suggestedAction)}</p>
              </div>
            ` : `
              <button class="btn btn-sm" id="detail-run-cycle"><span data-icon="refresh-cw"></span>Run Brain Cycle</button>
            `}
          </div>

          <div class="activation-projects">
            <div class="detail-field">
              <span>Workspaces</span>
              <div class="activation-project-list">
                ${projects.length ? projects.map((project) => `
                  <button class="chip chip-removable activation-project-chip" data-project-id="${escape(project.id)}" title="Remove from ${escape(project.name)}">
                    <span data-icon="folder-kanban"></span>${escape(project.name)}<small>${escape(project.role)}</small><span data-icon="x"></span>
                  </button>
                `).join('') : '<span class="placeholder">No workspace yet</span>'}
              </div>
            </div>
            <div class="activation-project-add">
              <select class="input detail-select" id="detail-project">
                <option value="">Choose workspace</option>
                ${availableProjects.map((space) => `
                  <option value="${escape(space.id)}">${escape(space.name)} · ${escape(space.kind || 'project')}</option>
                `).join('')}
              </select>
              <select class="input detail-select" id="detail-project-role" aria-label="Workspace role">
                ${['evidence', 'inspiration', 'task', 'decision', 'reference'].map((role) => `<option value="${role}">${role}</option>`).join('')}
              </select>
              <button class="icon-btn" id="detail-project-add" title="Add to workspace" aria-label="Add to workspace"><span data-icon="plus"></span></button>
            </div>
          </div>

          <div class="activation-commands">
            <button class="btn btn-sm" id="detail-ask"><span data-icon="message-circle"></span>Ask with this</button>
            <button class="btn btn-sm" id="detail-context-pack"><span data-icon="copy"></span>Context pack</button>
            ${b.authorHandle ? `<button class="btn btn-sm" id="detail-dossier"><span data-icon="user-round"></span>Author dossier</button>` : ''}
          </div>
        </section>

        <div class="detail-organize">
          <div class="detail-section-title">Organize</div>
          <label class="detail-field">
            <span>Category</span>
            <select class="input detail-select" id="detail-category" aria-label="Category">
              ${categoryOptions.map((cat) => `<option value="${escape(cat)}" ${cat === currentCategory ? 'selected' : ''}>${escape(cat)}</option>`).join('')}
            </select>
          </label>

          <div class="detail-field">
            <span>Collections</span>
            <div class="detail-collection-list">
              ${collections.length ? collections.map((name) => `
                <button class="chip chip-removable detail-collection-chip" data-collection="${escape(name)}" title="Remove from ${escape(name)}">
                  <span data-icon="folder"></span>${escape(name)}<span data-icon="x"></span>
                </button>
              `).join('') : '<span class="placeholder">None yet</span>'}
            </div>
            <div class="detail-collection-add">
              <input class="input" id="detail-collection-input" type="text" placeholder="New or existing collection…" autocomplete="off">
              <button class="btn" id="detail-collection-add"><span data-icon="plus"></span>Add</button>
            </div>
          </div>
        </div>

        <div class="detail-note">
          <div class="detail-section-title">Note</div>
          <textarea id="detail-note" placeholder="Capture a thought, pattern, or action…">${escape(b.note || '')}</textarea>
        </div>

        <div>
          <div class="detail-section-title">Metadata</div>
          <div style="font-size:12px;color:var(--fg-3);display:grid;gap:4px">
            ${posted ? `<div>Posted · <span class="mono">${escape(posted)}</span></div>` : ''}
            ${bookmarked ? `<div>Bookmarked · <span class="mono">${escape(bookmarked)}</span></div>` : ''}
            ${b.primaryCategory ? `<div>Primary category · ${escape(b.primaryCategory)}</div>` : ''}
            ${b.primaryDomain ? `<div>Primary domain · ${escape(b.primaryDomain)}</div>` : ''}
          </div>
        </div>

        <div class="detail-danger">
          <div>
            <div class="detail-section-title">Delete</div>
            <p>Remove it from this library, or also remove it from your saved Bookmarks on X.</p>
          </div>
          <div class="detail-danger-actions">
            <button class="btn btn-block btn-danger-ghost" id="detail-delete-local">
              <span data-icon="trash"></span>Remove locally
            </button>
            <button class="btn btn-block btn-danger" id="detail-delete-x">
              <span data-icon="trash"></span>Remove from X too
            </button>
          </div>
        </div>
      </div>
    `;

    renderIcons(els.detail);
    wireMediaFallbacks(els.detail);

    // Wire up actions
    const importance = $('#detail-importance', els.detail);
    const importanceValue = $('#detail-importance-value', els.detail);
    importance?.addEventListener('input', () => {
      importanceValue.value = importance.value;
      importanceValue.textContent = importance.value;
    });

    $('#detail-activation-save', els.detail)?.addEventListener('click', async () => {
      const btn = $('#detail-activation-save', els.detail);
      btn.disabled = true;
      try {
        const reviewDate = $('#detail-review-date', els.detail).value;
        const res = await api.saveActivation(b.id, {
          intent: $('#detail-intent', els.detail).value || null,
          whySaved: $('#detail-why-saved', els.detail).value,
          importance: Number($('#detail-importance', els.detail).value),
          status: $('#detail-activation-status', els.detail).value,
          nextReviewAt: reviewDate ? new Date(`${reviewDate}T12:00:00`).toISOString() : null,
        });
        b.activation = res.activation;
        patchBookmark(b.id, { activation: {
          ...(state.bookmarks.find((item) => item.id === b.id)?.activation || {}),
          profile: res.profile,
        } });
        renderList();
        renderDetail(b);
        toast('Activation saved');
      } catch (err) {
        btn.disabled = false;
        toast(`Activation failed: ${err.message}`);
      }
    });

    $('#detail-run-cycle', els.detail)?.addEventListener('click', async () => {
      const btn = $('#detail-run-cycle', els.detail);
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Distilling';
      try {
        await api.runBrainCycle(1, { bookmarkIds: [b.id], force: true });
        const refreshed = await api.getBookmark(b.id);
        Object.assign(b, refreshed);
        renderDetail(b);
        toast('Brain Cycle complete');
      } catch (err) {
        btn.disabled = false;
        toast(`Brain Cycle failed: ${err.message}`);
      }
    });

    $('#detail-project-add', els.detail)?.addEventListener('click', async () => {
      const projectId = $('#detail-project', els.detail).value;
      const role = $('#detail-project-role', els.detail).value;
      if (!projectId) { toast('Choose a workspace'); return; }
      try {
        const res = await api.addBookmarkProject(b.id, projectId, role);
        b.activation = res.activation;
        renderDetail(b);
        toast('Added to workspace');
      } catch (err) { toast(`Workspace update failed: ${err.message}`); }
    });

    $$('.activation-project-chip', els.detail).forEach((chip) => {
      chip.addEventListener('click', async () => {
        try {
          const res = await api.removeBookmarkProject(b.id, chip.dataset.projectId);
          b.activation = res.activation;
          renderDetail(b);
          toast('Removed from workspace');
        } catch (err) { toast(`Workspace update failed: ${err.message}`); }
      });
    });

    $('#detail-ask', els.detail)?.addEventListener('click', () => {
      const firstProject = b.activation?.projects?.[0]?.id || null;
      document.dispatchEvent(new CustomEvent('xb:navigate', {
        detail: {
          view: 'ask',
          ask: {
            question: `What is useful, actionable, or uncertain in this saved post by @${b.authorHandle || 'unknown'}: ${String(b.text || '').slice(0, 500)}`,
            topicId: firstProject,
          },
        },
      }));
    });

    $('#detail-context-pack', els.detail)?.addEventListener('click', async () => {
      const btn = $('#detail-context-pack', els.detail);
      btn.disabled = true;
      try {
        const result = await api.contextPack({
          query: String(b.text || '').slice(0, 600),
          title: `Context from @${b.authorHandle || 'bookmark'}`,
          topicId: b.activation?.projects?.[0]?.id || null,
          synthesis: b.activation?.enrichment?.summary || '',
          limit: 12,
        });
        await copy(result.pack.markdown);
        toast(`Context pack copied · ${result.pack.evidence.length} sources`);
      } catch (err) {
        toast(`Context pack failed: ${err.message}`);
      } finally {
        btn.disabled = false;
      }
    });

    $('#detail-dossier', els.detail)?.addEventListener('click', async () => {
      const btn = $('#detail-dossier', els.detail);
      btn.disabled = true;
      try {
        const result = await api.dossier(b.authorHandle);
        renderDossier(result.dossier, b);
      } catch (err) {
        btn.disabled = false;
        toast(`Dossier failed: ${err.message}`);
      }
    });

    $('#detail-read', els.detail).addEventListener('click', async () => {
      try {
        const res = await api.setRead(b.id, !b.isRead);
        b.isRead = Boolean(res.isRead);
        // Update the row in the list
        const row = $(`.bookmark-row[data-id="${b.id}"]`, els.list);
        if (row) row.classList.toggle('read', b.isRead);
        renderDetail(b);
        toast(b.isRead ? 'Marked as read' : 'Marked as unread');
      } catch (err) { toast(`Failed: ${err.message}`); }
    });

    $('#detail-copy', els.detail).addEventListener('click', () => {
      const md = buildMarkdown(b);
      copy(md).then(() => toast('Copied as Markdown')).catch(() => toast('Clipboard unavailable'));
    });
    $('#detail-close', els.detail).addEventListener('click', clearDetail);

    $('#detail-wiki', els.detail).addEventListener('click', async () => {
      const nextWiki = !b.inWiki;
      try {
        const res = await api.setWiki(b.id, nextWiki);
        b.inWiki = Boolean(res.inWiki);
        patchBookmark(b.id, { inWiki: b.inWiki });
        renderList();
        renderDetail(b);
        toast(b.inWiki ? 'Added to Topics' : 'Removed from Topics');
      } catch (err) { toast(`Topic update failed: ${err.message}`); }
    });

    $('#detail-build-brain', els.detail).addEventListener('click', async () => {
      const btn = $('#detail-build-brain', els.detail);
      btn.disabled = true;
      toast('Refreshing topic index…');
      try {
        await api.wikiStream((event, data) => {
          if (event === 'progress' && data?.message) toast(data.message, 1800);
          if (event === 'done') toast('Topic index refreshed', 2600);
          if (event === 'error') toast(`Build failed: ${data?.message || 'unknown'}`);
        });
      } catch (err) {
        toast(`Build failed: ${err.message}`);
      } finally {
        btn.disabled = false;
      }
    });

    async function deleteBookmark(fromX) {
      const prompt = fromX
        ? 'Remove this post from your actual X bookmarks and from Xtreme? This cannot be undone on X.'
        : 'Remove this bookmark from Xtreme? It will stay saved on X.';
      if (!window.confirm(prompt)) return;

      const localBtn = $('#detail-delete-local', els.detail);
      const xBtn = $('#detail-delete-x', els.detail);
      localBtn.disabled = true;
      xBtn.disabled = true;
      try {
        const res = await api.deleteBookmark(b.id, fromX);
        state.bookmarks = state.bookmarks.filter((item) => item.id !== b.id);
        state.total = Math.max(0, state.total - 1);
        clearDetail();
        renderList();
        renderSummary();
        loadFacets();
        toast(fromX && res.xDeleted ? 'Removed from X and Xtreme' : 'Removed from Xtreme');
      } catch (err) {
        localBtn.disabled = false;
        xBtn.disabled = false;
        toast(`Delete failed: ${err.message}`, 6000);
      }
    }

    $('#detail-delete-local', els.detail).addEventListener('click', () => deleteBookmark(false));
    $('#detail-delete-x', els.detail).addEventListener('click', () => deleteBookmark(true));

    $('#detail-category', els.detail).addEventListener('change', async (e) => {
      const category = e.target.value;
      try {
        const res = await api.setCategory(b.id, category);
        b.primaryCategory = res.primaryCategory;
        b.categories = res.categories || [category];
        patchBookmark(b.id, { primaryCategory: b.primaryCategory, categories: b.categories });
        renderList();
        renderDetail(b);
        loadFacets();
        toast(`Categorized as ${category}`);
      } catch (err) { toast(`Category failed: ${err.message}`); }
    });

    async function addCollection() {
      const input = $('#detail-collection-input', els.detail);
      const name = input.value.trim();
      if (!name) return;
      try {
        await api.addCollection(b.id, name);
        const nextCollections = Array.from(new Set([...(b.collections || []), name])).sort((a, z) => a.localeCompare(z));
        b.collections = nextCollections;
        patchBookmark(b.id, { collections: nextCollections });
        renderDetail(b);
        loadFacets();
        toast(`Added to ${name}`);
      } catch (err) { toast(`Collection failed: ${err.message}`); }
    }

    $('#detail-collection-add', els.detail).addEventListener('click', addCollection);
    $('#detail-collection-input', els.detail).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addCollection(); }
    });
    $$('.detail-collection-chip', els.detail).forEach((chip) => chip.addEventListener('click', async () => {
      const name = chip.dataset.collection;
      try {
        await api.removeCollection(b.id, name);
        const nextCollections = (b.collections || []).filter((c) => c !== name);
        b.collections = nextCollections;
        patchBookmark(b.id, { collections: nextCollections });
        renderDetail(b);
        loadFacets();
        toast(`Removed from ${name}`);
      } catch (err) { toast(`Remove failed: ${err.message}`); }
    }));

    const noteEl = $('#detail-note', els.detail);
    const saveNote = debounce(async () => {
      try { await api.saveNote(b.id, noteEl.value); toast('Note saved', 1400); }
      catch (err) { toast(`Save failed: ${err.message}`); }
    }, 600);
    noteEl.addEventListener('input', saveNote);
  }

  function renderDossier(dossier, sourceBookmark) {
    const maxMonth = Math.max(1, ...(dossier.timeline || []).map((item) => Number(item.count || 0)));
    const avatar = dossier.author.profileImageUrl
      ? `<img class="dossier-avatar" src="${escape(dossier.author.profileImageUrl)}" alt="" referrerpolicy="no-referrer">`
      : `<div class="dossier-avatar dossier-avatar-fallback">${escape((dossier.author.name || dossier.author.handle || '?').slice(0, 1).toUpperCase())}</div>`;
    els.detail.innerHTML = `
      <div class="detail dossier">
        <div class="detail-header">
          <button class="icon-btn" id="dossier-back" title="Back to bookmark" aria-label="Back to bookmark"><span data-icon="arrow-left"></span></button>
          ${avatar}
          <div class="detail-author">
            <span class="detail-author-name">${escape(dossier.author.name)}</span>
            <span class="detail-author-handle">@${escape(dossier.author.handle)}</span>
          </div>
          <a class="icon-btn" href="https://x.com/${encodeURIComponent(dossier.author.handle)}" target="_blank" rel="noopener" title="Open on X" aria-label="Open on X"><span data-icon="external-link"></span></a>
        </div>

        <div class="dossier-title">
          <span class="detail-section-kicker">Author dossier</span>
          <h2>Signal history</h2>
        </div>

        <div class="dossier-metrics">
          <div><strong>${fmtNumber(dossier.totals.bookmarks)}</strong><span>Bookmarks</span></div>
          <div><strong>${fmtNumber(dossier.totals.notes)}</strong><span>Your notes</span></div>
          <div><strong>${fmtNumber(dossier.totals.enriched)}</strong><span>Distilled</span></div>
          <div><strong>${fmtNumber(dossier.totals.unread)}</strong><span>Unread</span></div>
        </div>

        ${(dossier.timeline || []).length ? `
          <section class="dossier-section">
            <div class="detail-section-title">Capture rhythm</div>
            <div class="dossier-timeline">
              ${dossier.timeline.map((item) => `
                <span style="height:${Math.max(8, Math.round((item.count / maxMonth) * 100))}%" title="${escape(item.month)} · ${fmtNumber(item.count)}"></span>
              `).join('')}
            </div>
          </section>
        ` : ''}

        <section class="dossier-section">
          <div class="detail-section-title">Recurring territory</div>
          <div class="dossier-territory">
            ${(dossier.categories || []).map((item) => `<span class="chip"><span data-icon="tag"></span>${escape(item.name)} <strong>${fmtNumber(item.count)}</strong></span>`).join('')}
            ${(dossier.domains || []).slice(0, 5).map((item) => `<span class="chip"><span data-icon="globe"></span>${escape(item.name)} <strong>${fmtNumber(item.count)}</strong></span>`).join('')}
          </div>
        </section>

        ${(dossier.projects || []).length ? `
          <section class="dossier-section">
            <div class="detail-section-title">Workspaces</div>
            <div class="dossier-projects">
              ${dossier.projects.map((project) => `
                <span><span data-icon="folder-kanban"></span><strong>${escape(project.name)}</strong><small>${escape(project.kind)} · ${fmtNumber(project.count)} signals</small></span>
              `).join('')}
            </div>
          </section>
        ` : ''}

        <section class="dossier-section">
          <div class="detail-section-title">Extracted claims</div>
          <div class="dossier-claims">
            ${(dossier.claims || []).length ? dossier.claims.slice(0, 10).map((claim) => `
              <button data-dossier-bookmark="${escape(claim.bookmarkId)}">
                <span>${escape(claim.text)}</span>
                <small>${escape(fmtDate(claim.capturedAt))}${claim.freshUntil && new Date(claim.freshUntil) < new Date() ? ' · recheck' : ''}</small>
              </button>
            `).join('') : '<span class="placeholder">Run Brain Cycle to extract claims.</span>'}
          </div>
        </section>

        <section class="dossier-section">
          <div class="detail-section-title">Recent signals</div>
          <div class="dossier-signals">
            ${(dossier.recentSignals || []).slice(0, 10).map((signal) => `
              <button data-dossier-bookmark="${escape(signal.id)}">
                <span>${escape(signal.summary || String(signal.text || '').slice(0, 180))}</span>
                <small>${escape(fmtDate(signal.bookmarkedAt || signal.postedAt))} · ${escape(signal.category || 'unclassified')}</small>
              </button>
            `).join('')}
          </div>
        </section>
      </div>
    `;
    renderIcons(els.detail);
    $('#dossier-back', els.detail).addEventListener('click', () => renderDetail(sourceBookmark));
    $$('[data-dossier-bookmark]', els.detail).forEach((button) => {
      button.addEventListener('click', () => select(button.dataset.dossierBookmark));
    });
  }

  function buildMarkdown(b) {
    const lines = [];
    lines.push(`## ${b.authorName || b.authorHandle || 'Bookmark'}`);
    if (b.authorHandle) lines.push(`_@${b.authorHandle}_`);
    lines.push('');
    lines.push(b.text || '');
    lines.push('');
    if (b.url) lines.push(`Source: ${b.url}`);
    if (b.categories && b.categories.length) lines.push(`Categories: ${b.categories.join(', ')}`);
    return lines.join('\n');
  }

  // ── Toolbar wiring ────────────────────────────────────────────────────────
  const onSearch = debounce((v) => setFilter({ q: v.trim() }), 220);
  els.search.addEventListener('input', (e) => onSearch(e.target.value));
  els.sort.addEventListener('click', () => {
    state.sort = state.sort === 'desc' ? 'asc' : 'desc';
    els.sortLabel.textContent = state.sort === 'desc' ? 'Newest' : 'Oldest';
    state.offset = 0;
    load();
  });
  els.presentation.addEventListener('click', () => {
    setPresentation(state.presentation === 'classic' ? 'refined' : 'classic');
  });
  $$('.segment-btn', els.displayMode).forEach((btn) => {
    btn.addEventListener('click', () => setDisplayMode(btn.dataset.mode));
  });
  $$('.segment-btn', els.section).forEach((btn) => {
    btn.addEventListener('click', () => setSection(btn.dataset.section));
  });
  els.todayRefresh.addEventListener('click', () => load(false, true));
  els.clear.addEventListener('click', clearAll);
  $('#lib-inbox', root).addEventListener('click', () => {
    setSection('archive', { load: false });
    state.inbox = !state.inbox;
    $('#lib-inbox', root).classList.toggle('btn-on', state.inbox);
    if (state.inbox) setDisplayMode('triage');
    state.offset = 0;
    load();
  });
  const filterButton = $('#lib-filters', root);
  const filterScrim = $('#lib-rail-scrim', root);
  function setFiltersOpen(open) {
    root.classList.toggle('filters-open', open);
    filterButton.setAttribute('aria-expanded', String(open));
    filterScrim.hidden = !open;
  }
  filterButton.addEventListener('click', () => setFiltersOpen(!root.classList.contains('filters-open')));
  filterScrim.addEventListener('click', () => setFiltersOpen(false));
  applyPresentation();

  // ── Initial load ──────────────────────────────────────────────────────────
  let facetsLoaded = false;

  // ── View lifecycle / keyboard ─────────────────────────────────────────────
  function activeIndex() {
    return Math.max(0, state.bookmarks.findIndex((b) => b.id === state.activeId));
  }
  function moveSelection(delta) {
    if (!state.bookmarks.length) return;
    let i = state.activeId ? activeIndex() : -1;
    i = Math.max(0, Math.min(state.bookmarks.length - 1, i + delta));
    select(state.bookmarks[i].id);
    const row = $(`.bookmark-row[data-id="${state.bookmarks[i].id}"]`, els.list);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  return {
    onShow() {
      if (!facetsLoaded) { loadFacets(); facetsLoaded = true; }
      if (!state.bookmarks.length) load();
      renderActive();
    },
    onHide() { listController?.abort(); detailController?.abort(); },
    onKey(e) {
      if (e.key === 'j') { e.preventDefault(); moveSelection(1); }
      else if (e.key === 'k') { e.preventDefault(); moveSelection(-1); }
      else if (e.key === 'u') { setFilter({ readStatus: state.filters.readStatus === 'unread' ? null : 'unread' }); }
      else if (e.key === 'e') {
        const b = state.bookmarks.find((x) => x.id === state.activeId);
        if (b) {
          api.setRead(b.id, !b.isRead).then((res) => {
            b.isRead = Boolean(res.isRead);
            renderList();
            toast(b.isRead ? 'Read' : 'Unread');
          });
        }
      } else if (e.key === 'Enter') {
        const b = state.bookmarks.find((x) => x.id === state.activeId);
        if (b && b.url) window.open(b.url, '_blank', 'noopener');
      } else if (e.key === 'Escape' && state.activeId) {
        e.preventDefault();
        clearDetail();
      }
    },
    focusSearch() { els.search.focus(); els.search.select(); },
    applyFilter(patch) {
      setFilter(patch);
      if (patch.q !== undefined) els.search.value = patch.q || '';
    },
    refresh() { load(); loadFacets(); },
  };
}
// Lightweight modal for idea details (replaces alert)
function showIdeaModal(idea) {
  const modal = document.createElement('div');
  modal.className = 'idea-modal-overlay';
  modal.innerHTML = `
    <div class="idea-modal">
      <div class="idea-modal-header">
        <h3>${escape(idea.title || 'Untitled Idea')}</h3>
        <button class="close-btn" data-icon="x"></button>
      </div>
      <div class="idea-modal-body">
        <div class="idea-meta-row">
          <span>${new Date(idea.created).toLocaleString()}</span>
          ${idea.promoted ? '<span class="promoted-badge">★ Promoted to wiki</span>' : ''}
        </div>
        ${idea.tags && idea.tags.length ? `<div class="idea-tags">${idea.tags.map(t => `<span class="tag-pill">${escape(t)}</span>`).join('')}</div>` : ''}
        <div class="idea-text">${escape(idea.text || '').replace(/\n/g, '<br>')}</div>
      </div>
      <div class="idea-modal-footer">
        <button class="btn btn-primary promote-modal-btn" data-id="${idea.id}">Promote to Wiki</button>
        <button class="btn btn-ghost delete-modal-btn" data-id="${idea.id}">Delete</button>
        <button class="btn btn-ghost close-modal-btn">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  renderIcons(modal);

  const close = () => modal.remove();
  modal.querySelector('.close-btn').onclick = close;
  modal.querySelector('.close-modal-btn').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };

  const promoteBtn = modal.querySelector('.promote-modal-btn');
  if (promoteBtn) {
    promoteBtn.onclick = async () => {
      const r = await fetch(`/api/ideas/${encodeURIComponent(idea.id)}/promote`, { method: 'POST' });
      const res = await r.json();
      if (res.success) {
        close();
        // refresh rail if possible
        if (window.loadLibraryIdeas) window.loadLibraryIdeas(true);
      }
    };
  }
  const delBtn = modal.querySelector('.delete-modal-btn');
  if (delBtn) {
    delBtn.onclick = async () => {
      if (!confirm('Delete idea?')) return;
      await fetch(`/api/ideas/${encodeURIComponent(idea.id)}`, { method: 'DELETE' });
      close();
      if (window.loadLibraryIdeas) window.loadLibraryIdeas(true);
    };
  }
}
