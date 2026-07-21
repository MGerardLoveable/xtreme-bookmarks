// Insights view — merged Stats + Analytics.

import { api, fmtNumber, fmtDate } from '../api.js';
import { renderIcons } from '../icons.js';
import { $, $$, escape } from '../util.js';

export function InsightsView(root) {
  root.innerHTML = `
    <div class="insights">
      <header style="margin-bottom:18px">
        <div class="brain-kicker">Insights</div>
        <h1 class="display">Know your archive.</h1>
        <p class="brain-subtitle">Who you read, what you care about, and how your bookmarking shape shifts over time.</p>
      </header>

      <div class="kpi-grid" id="kpis"><div class="placeholder">Loading…</div></div>

      <div class="insights-row">
        <div class="card">
          <div class="card-header"><div class="card-title">Top authors</div></div>
          <div id="top-authors" class="bar-list"><div class="placeholder">—</div></div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">Top categories</div></div>
          <div id="top-categories" class="bar-list"><div class="placeholder">—</div></div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">Top domains</div></div>
          <div id="top-domains" class="bar-list"><div class="placeholder">—</div></div>
        </div>
      </div>

      <div class="insights-row" style="margin-top:18px">
        <div class="card" style="grid-column:1 / -1">
          <div class="card-header">
            <div class="card-title">Bookmarking over time</div>
            <div class="muted" id="timeline-range" style="font-size:12px"></div>
          </div>
          <svg id="sparkline" class="sparkline" role="img" aria-label="Bookmark activity over time" width="100%" height="80" preserveAspectRatio="none" viewBox="0 0 800 80"></svg>
        </div>
      </div>
    </div>
  `;
  renderIcons(root);

  function renderBars(containerId, items, labelKey, countKey, formatLabel) {
    const c = $('#' + containerId, root);
    if (!items || !items.length) { c.innerHTML = '<div class="placeholder">No data</div>'; return; }
    const max = items[0][countKey] || 1;
    c.innerHTML = items.slice(0, 10).map((it) => {
      const label = formatLabel ? formatLabel(it[labelKey]) : String(it[labelKey]);
      return `
        <button class="bar-row" data-insight-kind="${containerId}" data-insight-value="${escape(String(it[labelKey]))}" title="Open in Library">
          <div class="bar-label" title="${escape(label)}">${escape(label)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(it[countKey] / max) * 100}%"></div></div>
          <div class="bar-count">${fmtNumber(it[countKey])}</div>
        </button>
      `;
    }).join('');
  }

  function renderSparkline(timeline) {
    const svg = $('#sparkline', root);
    if (!timeline.length) { svg.innerHTML = '<text x="400" y="40" text-anchor="middle" fill="var(--fg-3)" font-size="13">No timeline data</text>'; return; }

    const W = 800, H = 80, pad = 4;
    const max = Math.max(...timeline.map((t) => t.count), 1);
    const step = (W - pad * 2) / Math.max(1, timeline.length - 1);

    const pts = timeline.map((t, i) => [pad + i * step, H - pad - (t.count / max) * (H - pad * 2)]);
    const d = pts.map((p, i) => (i === 0 ? `M${p[0]} ${p[1]}` : `L${p[0]} ${p[1]}`)).join(' ');
    const area = `${d} L${pts[pts.length - 1][0]} ${H} L${pts[0][0]} ${H} Z`;

    svg.innerHTML = `
      <defs>
        <linearGradient id="spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--brand)" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="var(--brand)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#spark-grad)"/>
      <path d="${d}" fill="none" stroke="var(--brand)" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>
    `;

    const first = String(timeline[0].period || '');
    const last = String(timeline[timeline.length - 1].period || '');
    const range = first.startsWith('chunk-') ? 'Import order' : `${first} → ${last}`;
    const total = fmtNumber(timeline.reduce((s, t) => s + t.count, 0));
    $('#timeline-range', root).textContent = `${range} · ${total} total`;
    svg.setAttribute('aria-label', `Bookmark activity: ${range}, ${total} bookmarks total`);
  }

  async function load() {
    try {
      const [stats, timeline] = await Promise.all([api.stats(), api.timeline().catch(() => ({ timeline: [] }))]);

      const kpis = [
        { label: 'Bookmarks', value: fmtNumber(stats.totalBookmarks), note: '' },
        { label: 'Authors', value: fmtNumber(stats.uniqueAuthors), note: '' },
        { label: 'Categories', value: fmtNumber(stats.categoriesCount), note: 'classified' },
        { label: 'Domains', value: fmtNumber(stats.domainsCount), note: 'distinct sources' },
        {
          label: 'Date range',
          value: stats.dateRange?.earliest ? fmtDate(stats.dateRange.earliest) : '—',
          note: stats.dateRange?.latest ? `→ ${fmtDate(stats.dateRange.latest)}` : '',
        },
      ];
      $('#kpis', root).innerHTML = kpis.map((k) => `
        <div class="kpi">
          <div class="kpi-label">${escape(k.label)}</div>
          <div class="kpi-value">${escape(k.value)}</div>
          ${k.note ? `<div class="kpi-note">${escape(k.note)}</div>` : ''}
        </div>
      `).join('');

      renderBars('top-authors', stats.topAuthors, 'handle', 'count', (h) => '@' + h);
      renderBars('top-categories', stats.topCategories, 'name', 'count');
      renderBars('top-domains', stats.topDomains, 'name', 'count');
      renderSparkline(timeline.timeline || []);
      root.querySelectorAll('[data-insight-kind]').forEach((button) => button.addEventListener('click', () => {
        const map = { 'top-authors': 'author', 'top-categories': 'category', 'top-domains': 'domain' };
        document.dispatchEvent(new CustomEvent('xb:navigate', { detail: { view: 'library', filter: { [map[button.dataset.insightKind]]: button.dataset.insightValue } } }));
      }));
    } catch (err) {
      $('#kpis', root).innerHTML = `<div class="placeholder">Failed: ${escape(err.message)}</div>`;
    }
  }

  let loaded = false;
  return {
    onShow() { if (!loaded) { load(); loaded = true; } },
    onHide() {},
    onKey() {},
  };
}
