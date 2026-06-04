// App shell: routing, theme, density, shortcuts, command palette.

import { renderIcons, iconSvg } from './icons.js';
import { api, fmtNumber } from './api.js';
import { $, $$, toast, debounce } from './util.js';

import { LibraryView }     from './views/library.js';
import { AskView }         from './views/ask.js';
import { GraphView }       from './views/graph.js';
import { BrainView }       from './views/brain.js';
import { XFeedView }       from './views/xfeed.js';
import { MaintenanceView } from './views/maintenance.js';
import { InsightsView }    from './views/insights.js';
import { openWiki, closeWiki, isWikiOpen } from './wiki.js';

const LS_THEME = 'xb.v2.theme';
const LS_DENSITY = 'xb.v2.density';
const LS_VIEW = 'xb.v2.view';

// ── Theme + density ─────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(LS_THEME, theme);
  const btn = $('#theme-btn');
  if (btn) btn.querySelector('[data-icon]').innerHTML = iconSvg(theme === 'dark' ? 'sun' : 'moon');
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}
function applyDensity(density) {
  document.documentElement.dataset.density = density;
  localStorage.setItem(LS_DENSITY, density);
}
function toggleDensity() {
  const cur = document.documentElement.dataset.density;
  applyDensity(cur === 'compact' ? 'comfortable' : 'compact');
}

// ── Views registry ──────────────────────────────────────────────────────────
const views = {
  library: null,
  ask: null,
  graph: null,
  brain: null,
  xfeed: null,
  maintenance: null,
  insights: null,
};
const viewFactories = {
  library: LibraryView,
  ask: AskView,
  graph: GraphView,
  brain: BrainView,
  xfeed: XFeedView,
  maintenance: MaintenanceView,
  insights: InsightsView,
};

let currentView = null;

function mountView(name) {
  const root = document.querySelector(`.view[data-view="${name}"]`);
  if (!root) return;
  if (!views[name]) {
    try {
      views[name] = viewFactories[name](root);
    } catch (err) {
      console.error(`Failed to initialize ${name} view`, err);
      root.innerHTML = `<div class="empty-state"><h3>Failed to load</h3><p>${(err && err.message) || 'Unknown error'}</p></div>`;
      return;
    }
  }
  if (views[name] && typeof views[name].onShow === 'function') {
    views[name].onShow();
  }
}

function unmountView(name) {
  if (views[name] && typeof views[name].onHide === 'function') {
    views[name].onHide();
  }
}

function switchView(name) {
  if (!viewFactories[name]) name = 'library';
  if (currentView === name) return;

  if (currentView) unmountView(currentView);

  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== name));
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === name)));

  currentView = name;
  localStorage.setItem(LS_VIEW, name);
  mountView(name);
}

// ── Status bar ──────────────────────────────────────────────────────────────
async function refreshStatusBar() {
  try {
    const [s, u] = await Promise.all([api.stats(), api.unreadCount()]);
    $('#status-total').innerHTML = `<strong>${fmtNumber(s.totalBookmarks)}</strong> bookmarks`;
    $('#status-unread').innerHTML = `<strong>${fmtNumber(u.count)}</strong> unread`;
    $('#status-authors').innerHTML = `<strong>${fmtNumber(s.uniqueAuthors)}</strong> authors`;
  } catch {
    $('#status-total').textContent = '—';
  }
}

// ── Command palette ─────────────────────────────────────────────────────────
let paletteItems = [];
let paletteIndex = 0;
function isPaletteOpen() { const o = $('#palette'); return o && !o.hidden; }

function commandItems() {
  return [
    { section: 'Navigation', title: 'Go to Library',     icon: 'library',        action: () => switchView('library') },
    { section: 'Navigation', title: 'Go to Ask',         icon: 'sparkles',       action: () => switchView('ask') },
    { section: 'Navigation', title: 'Go to Graph',       icon: 'network',        action: () => switchView('graph') },
    { section: 'Navigation', title: 'Go to Brain',       icon: 'brain-circuit',  action: () => switchView('brain') },
    { section: 'Navigation', title: 'Go to X Feed',      icon: 'bell',           action: () => switchView('xfeed') },
    { section: 'Navigation', title: 'Go to Maintenance', icon: 'shield-check',   action: () => switchView('maintenance') },
    { section: 'Navigation', title: 'Go to Insights',    icon: 'bar-chart-3',    action: () => switchView('insights') },
    { section: 'Actions',    title: 'Grab new bookmarks from X', icon: 'download-cloud', action: runGrab },
    { section: 'Actions',    title: 'Browse wiki',        icon: 'folder',        action: () => openWiki() },
    { section: 'Actions',    title: 'Toggle theme',       icon: 'moon',          action: toggleTheme },
    { section: 'Actions',    title: 'Toggle density',     icon: 'rows-3',        action: toggleDensity },
    { section: 'Actions',    title: 'Keyboard shortcuts', icon: 'circle-help',   action: openHelp },
  ];
}

async function buildPaletteItems(query) {
  const q = query.trim().toLowerCase();
  const commands = commandItems();
  if (!q) return commands;

  const matchesCmd = commands.filter((c) => c.title.toLowerCase().includes(q));
  if (q.length < 2) return matchesCmd;

  const results = [...matchesCmd];

  // Authors
  try {
    const { authors = [] } = await api.authors(q.replace(/^@/, ''));
    for (const a of authors.slice(0, 5)) {
      results.push({
        section: 'Authors',
        title: `@${a.handle}`,
        meta: `${a.count} bookmarks`,
        icon: 'user-round',
        action: () => { switchView('library'); views.library.applyFilter({ author: a.handle }); closePalette(); },
      });
    }
  } catch {}

  // Categories
  try {
    const { categories = [] } = await api.categories();
    for (const c of categories.filter((x) => x.name && String(x.name).toLowerCase().includes(q)).slice(0, 4)) {
      results.push({
        section: 'Categories',
        title: String(c.name),
        meta: `${c.count} bookmarks`,
        icon: 'tag',
        action: () => { switchView('library'); views.library.applyFilter({ category: c.name }); closePalette(); },
      });
    }
  } catch {}

  // Search action (always offer free-text search)
  results.push({
    section: 'Search',
    title: `Search for “${query}”`,
    icon: 'search',
    action: () => { switchView('library'); views.library.applyFilter({ q: query }); closePalette(); },
  });

  return results;
}

function renderPalette(items) {
  const container = $('#palette-results');
  if (!container) return;

  paletteItems = items.filter((i) => i.action);
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));

  let curSection = null;
  const frag = document.createDocumentFragment();
  items.forEach((item, idx) => {
    if (item.section !== curSection) {
      curSection = item.section;
      const h = document.createElement('div');
      h.className = 'palette-section';
      h.textContent = item.section;
      frag.appendChild(h);
    }
    const node = document.createElement('div');
    node.className = 'palette-item' + (idx === paletteIndex ? ' active' : '');
    node.dataset.index = String(idx);
    node.innerHTML = `
      <span class="palette-item-icon" data-icon="${item.icon || 'search'}"></span>
      <span class="palette-item-title">${escapeHtml(item.title)}</span>
      ${item.meta ? `<span class="palette-item-meta">${escapeHtml(item.meta)}</span>` : ''}
    `;
    node.addEventListener('click', () => item.action && item.action());
    frag.appendChild(node);
  });

  container.innerHTML = '';
  container.appendChild(frag);
  renderIcons(container);
}

function openPalette() {
  closeHelp();
  closeWiki();
  const overlay = $('#palette');
  if (!overlay) return;
  overlay.hidden = false;
  const input = $('#palette-input');
  input.value = '';
  paletteIndex = 0;
  buildPaletteItems('').then(renderPalette);
  setTimeout(() => input.focus(), 10);
}
function closePalette() {
  const overlay = $('#palette');
  if (!overlay) return;
  overlay.hidden = true;
  // Release focus so subsequent `inField` checks don't mistake the hidden input for an active field.
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
}
function paletteExecute() {
  const item = paletteItems[paletteIndex];
  if (item && item.action) {
    item.action();
    // Most actions close themselves via closePalette() calls, but navigation commands do not.
    closePalette();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Help ────────────────────────────────────────────────────────────────────
function openHelp()  { closePalette(); closeWiki(); $('#help-overlay').hidden = false; }
function closeHelp() { $('#help-overlay').hidden = true; }
function isHelpOpen() { const o = $('#help-overlay'); return o && !o.hidden; }

// ── Grab (sync new bookmarks) ───────────────────────────────────────────────
async function runGrab() {
  toast('Grabbing new bookmarks…');
  try {
    let addedCount = 0;
    let openedAuthUrl = '';
    const openAuthUrl = (url) => {
      if (!url || openedAuthUrl === url) return;
      openedAuthUrl = url;
      window.open(url, '_blank', 'noopener');
    };
    await api.grabStream((event, data) => {
      if (event === 'progress' && data && typeof data.added === 'number') addedCount = data.added;
      if (event === 'done') {
        toast(addedCount ? `Added ${addedCount} new bookmark${addedCount === 1 ? '' : 's'}` : 'No new bookmarks');
        refreshStatusBar();
        if (views.library && views.library.refresh) views.library.refresh();
      }
      if (event === 'auth_required') {
        openAuthUrl(data && data.url);
        toast((data && data.message) || 'Authorize Xtreme Bookmarks with X, then press Grab again.', 8000);
      }
      if (event === 'error') {
        if (data && data.authUrl) {
          openAuthUrl(data.authUrl);
          toast('Authorization required. Approve X access in the new tab, then press Grab again.', 8000);
        } else {
          toast(`Grab failed: ${data && data.message ? data.message : 'unknown'}`);
        }
      }
    });
  } catch (err) {
    toast(`Grab failed: ${err.message}`);
  }
}

// ── Keyboard shortcuts ──────────────────────────────────────────────────────
let leaderPending = false;
let leaderTimer = null;

function onKeydown(e) {
  const target = e.target;
  const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

  // Ctrl/Cmd+K — palette
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    isPaletteOpen() ? closePalette() : openPalette();
    return;
  }

  // Escape — close overlays
  if (e.key === 'Escape') {
    let closed = false;
    if (isPaletteOpen()) { closePalette(); closed = true; }
    if (isWikiOpen()) { closeWiki(); closed = true; }
    if (isHelpOpen()) { closeHelp(); closed = true; }
    if (closed) return;
    const v = views[currentView];
    if (v && typeof v.onKey === 'function') v.onKey(e);
    return;
  }

  if (isPaletteOpen()) {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteIndex = Math.min(paletteIndex + 1, paletteItems.length - 1); rerenderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIndex = Math.max(paletteIndex - 1, 0); rerenderPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); paletteExecute(); }
    return;
  }

  if (inField) return;

  // Leader key `g`
  if (leaderPending) {
    const key = e.key.toLowerCase();
    const map = { l: 'library', a: 'ask', g: 'graph', b: 'brain', x: 'xfeed', m: 'maintenance', i: 'insights' };
    if (map[key]) {
      e.preventDefault();
      switchView(map[key]);
    }
    leaderPending = false;
    clearTimeout(leaderTimer);
    return;
  }

  if (e.key === 'g') {
    leaderPending = true;
    clearTimeout(leaderTimer);
    leaderTimer = setTimeout(() => { leaderPending = false; }, 800);
    return;
  }

  // Global
  if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); openHelp(); return; }
  if (e.key === 't') { toggleTheme(); return; }
  if (e.key === 'd') { toggleDensity(); return; }
  if (e.key === 'w') { openWiki(); return; }
  if (e.key === '/') {
    if (currentView === 'library' && views.library && views.library.focusSearch) {
      e.preventDefault();
      views.library.focusSearch();
    }
    return;
  }

  // Forward to current view
  const v = views[currentView];
  if (v && typeof v.onKey === 'function') v.onKey(e);
}

function rerenderPalette() {
  // Re-render only active state without rebuilding (cheap)
  const items = $$('#palette-results .palette-item');
  items.forEach((node) => {
    const idx = Number(node.dataset.index);
    node.classList.toggle('active', idx === paletteIndex);
  });
  const active = items[paletteIndex];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

// ── Boot ────────────────────────────────────────────────────────────────────
function boot() {
  applyTheme(localStorage.getItem(LS_THEME) || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  applyDensity(localStorage.getItem(LS_DENSITY) || 'comfortable');
  renderIcons();

  // Tab clicks
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  // Topbar buttons
  $('#grab-btn').addEventListener('click', runGrab);
  $('#palette-btn').addEventListener('click', openPalette);
  $('#density-btn').addEventListener('click', toggleDensity);
  $('#theme-btn').addEventListener('click', toggleTheme);
  $('#help-btn').addEventListener('click', openHelp);

  // Delegated clicks for overlay close buttons and backdrops.
  // Event delegation survives any DOM re-render and handles the case where the
  // actual click target is a child SVG/path instead of the button itself.
  document.addEventListener('click', (e) => {
    if (e.target.closest('#help-close')) { e.preventDefault(); closeHelp(); return; }
    if (e.target.id === 'help-overlay')  { closeHelp(); return; }
    if (e.target.id === 'palette')       { closePalette(); return; }
  });

  // Palette input
  const paletteInput = $('#palette-input');
  const onInput = debounce(async (v) => {
    const items = await buildPaletteItems(v);
    paletteIndex = 0;
    renderPalette(items);
  }, 140);
  paletteInput.addEventListener('input', (e) => onInput(e.target.value));

  // Global shortcuts
  document.addEventListener('keydown', onKeydown);


  // ── Global Notepad / Quick Capture ────────────────────────────────────────
  function setupGlobalNotepad() {
    const fab = $('#fab-capture');
    const modal = $('#notepad-modal');
    const closeBtn = $('#notepad-modal-close');
    const titleInput = $('#global-notepad-title');
    const textInput = $('#global-notepad-text');
    const tagsInput = $('#global-notepad-tags');
    const stateText = $('#global-notepad-state');
    const saveBtn = $('#global-notepad-save');
    const addBtn = $('#global-notepad-add');

    if (!fab || !modal) return;

    function setCaptureState(message) {
      if (stateText) stateText.textContent = message;
    }

    function readDraft() {
      try {
        return JSON.parse(localStorage.getItem('xb.global.notepad.draft') || '{}');
      } catch {
        return {};
      }
    }

    function openModal() {
      const draft = readDraft();
      if (!titleInput.value && draft.title) titleInput.value = draft.title;
      if (!textInput.value && draft.text) textInput.value = draft.text;
      if (tagsInput && !tagsInput.value && draft.tags) tagsInput.value = Array.isArray(draft.tags) ? draft.tags.join(', ') : String(draft.tags);
      modal.hidden = false;
      document.body.classList.add('modal-open');
      setCaptureState(draft.text ? 'Draft restored from this device.' : 'Drafts stay on this device until added.');
      setTimeout(() => (titleInput.value ? textInput : titleInput).focus(), 50);
    }
    function closeModal() {
      modal.hidden = true;
      document.body.classList.remove('modal-open');
      titleInput.value = '';
      textInput.value = '';
      if (tagsInput) tagsInput.value = '';
      setCaptureState('Drafts stay on this device until added.');
    }

    fab.addEventListener('click', openModal);
    closeBtn?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    saveBtn?.addEventListener('click', () => {
      const title = titleInput.value.trim();
      const text = textInput.value.trim();
      const tags = tagsInput ? tagsInput.value.split(',').map(t => t.trim()).filter(Boolean) : [];
      if (!text) return;
      localStorage.setItem('xb.global.notepad.draft', JSON.stringify({ title, text, tags, savedAt: new Date().toISOString() }));
      setCaptureState('Draft saved locally.');
      toast('Draft saved');
    });

    addBtn?.addEventListener('click', async () => {
      const title = titleInput.value.trim();
      const text = textInput.value.trim();
      const tags = tagsInput ? tagsInput.value.split(',').map(t => t.trim()).filter(Boolean) : [];
      
      if (!text) {
        setCaptureState('Write a note before adding it.');
        textInput.focus();
        toast('Please enter some text');
        return;
      }
      addBtn.disabled = true;
      saveBtn.disabled = true;
      setCaptureState('Adding to Brain...');
      try {
        await api.createBrainNote({ title, text, tags });
        localStorage.removeItem('xb.global.notepad.draft');
        toast('Added to Brain');
        closeModal();
      } catch (err) {
        console.error(err);
        localStorage.setItem('xb.global.notepad.draft', JSON.stringify({ title, text, tags, savedAt: new Date().toISOString() }));
        setCaptureState('Could not reach Brain. Draft saved locally.');
        toast('Draft saved locally');
      } finally {
        addBtn.disabled = false;
        saveBtn.disabled = false;
      }
    });

    // Keyboard shortcut: Ctrl/Cmd + Shift + N
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        openModal();
      } else if (e.key === 'Escape' && !modal.hidden) {
        e.preventDefault();
        closeModal();
      }
    });
  }

  setupGlobalNotepad();

  // Start
  const saved = localStorage.getItem(LS_VIEW) || 'library';
  switchView(saved);
  refreshStatusBar();
  setInterval(refreshStatusBar, 60_000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
