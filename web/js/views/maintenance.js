// Maintenance view — unified Duplicates + Health + Dead-links.

import { api, fmtNumber } from '../api.js';
import { renderIcons } from '../icons.js';
import { $, $$, escape, toast } from '../util.js';

export function MaintenanceView(root) {
  root.innerHTML = `
    <div class="maintenance">
      <header style="margin-bottom:8px">
        <div class="brain-kicker">Maintenance</div>
        <h1 class="display">Keep the archive clean.</h1>
        <p class="brain-subtitle">Find duplicates, scan for broken links, and check overall wiki health — all in one place.</p>
      </header>

      <div class="maintenance-grid">
        <!-- Duplicates -->
        <div class="card">
          <div class="card-header">
            <span class="card-icon" data-icon="copy"></span>
            <div class="card-title">Duplicates</div>
            <button class="btn btn-sm" id="dupes-refresh"><span data-icon="refresh-cw"></span>Refresh</button>
          </div>
          <div id="dupes-body"><div class="placeholder">Scanning…</div></div>
        </div>

        <!-- Dead links -->
        <div class="card">
          <div class="card-header">
            <span class="card-icon" data-icon="link-2-off"></span>
            <div class="card-title">Dead links</div>
            <button class="btn btn-sm" id="dead-refresh"><span data-icon="refresh-cw"></span>Refresh</button>
          </div>
          <div id="dead-body"><div class="placeholder">Loading…</div></div>
        </div>

        <!-- Health -->
        <div class="card">
          <div class="card-header">
            <span class="card-icon" data-icon="shield-check"></span>
            <div class="card-title">Wiki health</div>
            <button class="btn btn-sm btn-primary" id="health-run"><span data-icon="zap"></span>Run scan</button>
          </div>
          <div id="health-body">
            <div class="placeholder">Scan to measure link integrity, metadata completeness, and classification coverage.</div>
          </div>
        </div>
      </div>
    </div>
  `;
  renderIcons(root);

  async function loadDupes() {
    $('#dupes-body', root).innerHTML = '<div class="placeholder">Scanning…</div>';
    try {
      const res = await api.duplicates();
      const groups = [
        ...(res.textGroups || []).map((g) => ({ ...g, type: 'similar_text' })),
        ...(res.linkGroups || []).map((g) => ({ ...g, type: 'same_link' })),
      ];
      if (!groups.length) {
        $('#dupes-body', root).innerHTML = '<div class="placeholder">No duplicates detected.</div>';
        return;
      }
      $('#dupes-body', root).innerHTML = `
        <div class="muted" style="font-size:12px;margin-bottom:8px">
          ${fmtNumber(groups.length)} groups · ${fmtNumber(groups.reduce((s, g) => s + (g.ids?.length || 0), 0))} items
        </div>
        ${groups.slice(0, 20).map((g) => `
          <div class="dupe-group">
            <div class="dupe-preview">${escape(g.preview || g.sample_url || '(no preview)')}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <span class="chip">${g.type === 'similar_text' ? 'Similar text' : 'Same link'}</span>
              <span class="chip">${g.ids?.length || 0} items</span>
            </div>
          </div>
        `).join('')}
      `;
    } catch (err) {
      $('#dupes-body', root).innerHTML = `<div class="placeholder">Failed: ${escape(err.message)}</div>`;
    }
  }

  async function loadDead() {
    $('#dead-body', root).innerHTML = '<div class="placeholder">Loading…</div>';
    try {
      const { deadLinks } = await api.deadLinks();
      if (!deadLinks.length) {
        $('#dead-body', root).innerHTML = `
          <div class="placeholder" style="font-size:12px">No dead links recorded.</div>
          <button class="btn btn-block btn-sm" id="dead-check" style="margin-top:10px"><span data-icon="zap"></span>Check 50 now</button>
        `;
        renderIcons($('#dead-body', root));
        $('#dead-check', root).addEventListener('click', runDeadCheck);
        return;
      }
      $('#dead-body', root).innerHTML = `
        <div class="muted" style="font-size:12px;margin-bottom:8px">${fmtNumber(deadLinks.length)} broken · last checked ${escape((deadLinks[0].checkedAt || '').slice(0, 10))}</div>
        <div style="display:grid;gap:6px;font-size:12px">
          ${deadLinks.slice(0, 10).map((d) => `
            <div style="display:flex;align-items:center;gap:8px">
              <span class="chip" style="background:rgba(209,75,75,0.1);border-color:rgba(209,75,75,0.3);color:var(--accent-red)">${escape(String(d.status || '?'))}</span>
              <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape(d.bookmarkId)}</span>
            </div>
          `).join('')}
        </div>
        <button class="btn btn-block btn-sm" id="dead-check" style="margin-top:10px"><span data-icon="zap"></span>Check 50 more</button>
      `;
      renderIcons($('#dead-body', root));
      $('#dead-check', root).addEventListener('click', runDeadCheck);
    } catch (err) {
      $('#dead-body', root).innerHTML = `<div class="placeholder">Failed: ${escape(err.message)}</div>`;
    }
  }

  async function runDeadCheck() {
    toast('Checking links…');
    try {
      await fetch('/api/check-links', { method: 'POST' });
      toast('Link check complete');
      loadDead();
    } catch (err) { toast(`Failed: ${err.message}`); }
  }

  async function runHealth() {
    $('#health-body', root).innerHTML = '<div class="placeholder"><div class="spinner" style="margin:0 auto"></div></div>';
    try {
      const { report } = await api.brainHealth();
      const score = report?.score ?? report?.healthScore ?? null;
      const items = report?.items || report?.issues || [];
      $('#health-body', root).innerHTML = `
        <div style="display:flex;align-items:baseline;gap:6px;font-family:var(--font-display);font-size:2rem;font-weight:600">
          ${score != null ? Math.round(score) : '—'}<span style="font-size:0.9rem;color:var(--fg-3)">/100</span>
        </div>
        <div style="font-size:12px;color:var(--fg-3);margin-top:10px">Issues flagged</div>
        <div style="display:grid;gap:6px;font-size:12px;margin-top:6px">
          ${items.length ? items.slice(0, 10).map((it) => `<div>· ${escape(typeof it === 'string' ? it : (it.message || JSON.stringify(it)))}</div>`).join('') : '<div class="muted">None.</div>'}
        </div>
      `;
    } catch (err) {
      $('#health-body', root).innerHTML = `<div class="placeholder">Failed: ${escape(err.message)}</div>`;
    }
  }

  $('#dupes-refresh', root).addEventListener('click', loadDupes);
  $('#dead-refresh', root).addEventListener('click', loadDead);
  $('#health-run', root).addEventListener('click', runHealth);

  let loaded = false;
  return {
    onShow() {
      if (loaded) return;
      loaded = true;
      loadDupes();
      loadDead();
    },
    onHide() {},
    onKey() {},
  };
}
