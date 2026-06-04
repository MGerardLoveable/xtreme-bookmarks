// Graph view — interactive knowledge graph powered by Cytoscape.js.

import { api, fmtNumber } from '../api.js';
import { renderIcons } from '../icons.js';
import { $, $$, escape } from '../util.js';

const CY_CDN = 'https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.umd.js';

const NODE_COLORS = {
  category: '#245c73',
  domain:   '#ba5f7d',
  entity:   '#c48a2e',
  concept:  '#3a9b6e',
  tool:     '#85506f',
};

let cytoscapePromise = null;
function loadCytoscape() {
  if (cytoscapePromise) return cytoscapePromise;
  cytoscapePromise = new Promise((resolve, reject) => {
    if (window.cytoscape) return resolve(window.cytoscape);
    const script = document.createElement('script');
    script.src = CY_CDN;
    script.async = true;
    script.onload = () => resolve(window.cytoscape);
    script.onerror = () => reject(new Error('Failed to load Cytoscape'));
    document.head.appendChild(script);
  });
  return cytoscapePromise;
}

export function GraphView(root) {
  root.innerHTML = `
    <div class="graph-view">
      <div class="graph-canvas">
        <div class="graph-hud">
          <button class="btn btn-sm" id="graph-refresh"><span data-icon="refresh-cw"></span>Refresh</button>
          <button class="btn btn-sm btn-ghost" id="graph-fit"><span data-icon="layers"></span>Fit</button>
          <button class="btn btn-sm btn-ghost" id="graph-focus-off" hidden><span data-icon="x"></span>Clear focus</button>
        </div>
        <div id="cy"></div>
        <div class="empty-state" id="graph-empty" hidden>
          <span class="empty-icon" data-icon="network"></span>
          <h3>No graph yet</h3>
          <p>Build your wiki with <code>ft wiki</code> to populate the knowledge graph.</p>
        </div>
      </div>
      <aside class="graph-sidebar">
        <div>
          <h3 style="margin-bottom:6px">Knowledge graph</h3>
          <p class="muted" style="font-size:12px">Entities extracted from your bookmarks, linked by typed relationships.</p>
        </div>
        <div class="card" style="padding:14px">
          <div class="detail-section-title">At a glance</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px;font-size:13px">
            <div><strong id="stat-nodes">0</strong> nodes</div>
            <div><strong id="stat-edges">0</strong> edges</div>
            <div><strong id="stat-clusters">0</strong> clusters</div>
            <div><strong id="stat-contradictions">0</strong> contradictions</div>
          </div>
        </div>
        <div>
          <div class="detail-section-title">Legend</div>
          <div class="graph-legend">
            <div class="graph-legend-item"><span class="graph-legend-dot" style="background:${NODE_COLORS.category}"></span>Category</div>
            <div class="graph-legend-item"><span class="graph-legend-dot" style="background:${NODE_COLORS.domain}"></span>Domain</div>
            <div class="graph-legend-item"><span class="graph-legend-dot" style="background:${NODE_COLORS.entity}"></span>Entity</div>
            <div class="graph-legend-item"><span class="graph-legend-dot" style="background:${NODE_COLORS.concept}"></span>Concept</div>
            <div class="graph-legend-item"><span class="graph-legend-dot" style="background:${NODE_COLORS.tool}"></span>Tool</div>
          </div>
        </div>
        <div id="node-detail"></div>
        <div>
          <div class="detail-section-title">Top connected</div>
          <div id="top-connected" class="bar-list"><div class="placeholder" style="font-size:11px">—</div></div>
        </div>
      </aside>
    </div>
  `;

  renderIcons(root);

  let cy = null;
  let data = { nodes: [], edges: [] };
  let focusedNode = null;

  async function load() {
    try {
      const [graph, stats] = await Promise.all([
        api.brainGraphData(),
        api.brainGraphStats().catch(() => ({ totalNodes: 0, totalEdges: 0, clusters: 0, contradictions: 0, topConnected: [] })),
      ]);
      data = graph;

      $('#stat-nodes', root).textContent = fmtNumber(stats.totalNodes || 0);
      $('#stat-edges', root).textContent = fmtNumber(stats.totalEdges || 0);
      $('#stat-clusters', root).textContent = fmtNumber(stats.clusters || 0);
      $('#stat-contradictions', root).textContent = fmtNumber(stats.contradictions || 0);

      const top = stats.topConnected || [];
      const max = top[0]?.connections || 1;
      $('#top-connected', root).innerHTML = top.length
        ? top.map((t) => `
          <div class="bar-row">
            <div class="bar-label" title="${escape(t.id)}">${escape(t.id)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${(t.connections / max) * 100}%"></div></div>
            <div class="bar-count">${t.connections}</div>
          </div>
        `).join('')
        : '<div class="placeholder" style="font-size:11px">—</div>';

      if (!data.nodes.length && !data.edges.length) {
        $('#graph-empty', root).hidden = false;
        $('#cy', root).style.display = 'none';
        return;
      }
      $('#graph-empty', root).hidden = true;
      $('#cy', root).style.display = '';

      await renderGraph();
    } catch (err) {
      console.error(err);
      $('#graph-empty', root).hidden = false;
      $('#graph-empty h3', root).textContent = 'Failed to load graph';
      $('#graph-empty p', root).textContent = err.message;
    }
  }

  async function renderGraph() {
    const cytoscape = await loadCytoscape();

    // Derive nodes from edges if the nodes array is sparse (older data)
    const seen = new Set();
    const nodes = [];
    for (const n of data.nodes || []) {
      seen.add(n.id);
      nodes.push({
        data: {
          id: n.id,
          label: n.label || n.id,
          type: n.type || 'entity',
          mentions: n.mentionCount || 1,
        },
      });
    }
    for (const e of data.edges || []) {
      for (const ep of [e.source, e.target]) {
        if (!seen.has(ep)) {
          seen.add(ep);
          nodes.push({ data: { id: ep, label: ep, type: 'entity', mentions: 1 } });
        }
      }
    }

    const edges = (data.edges || []).map((e, i) => ({
      data: {
        id: `e${i}`,
        source: e.source,
        target: e.target,
        relation: e.relation,
        confidence: e.confidence ?? 0.5,
      },
    }));

    if (cy) { cy.destroy(); cy = null; }

    cy = cytoscape({
      container: $('#cy', root),
      elements: { nodes, edges },
      wheelSensitivity: 0.22,
      minZoom: 0.2,
      maxZoom: 3,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': (el) => NODE_COLORS[el.data('type')] || NODE_COLORS.entity,
            'label': 'data(label)',
            'font-family': 'Inter, system-ui, sans-serif',
            'font-size': 11,
            'font-weight': 500,
            'color': 'var(--fg)',
            'text-valign': 'bottom',
            'text-margin-y': 4,
            'text-outline-color': 'var(--bg)',
            'text-outline-width': 2,
            'width': (el) => Math.min(42, 12 + Math.sqrt(el.data('mentions') || 1) * 4),
            'height': (el) => Math.min(42, 12 + Math.sqrt(el.data('mentions') || 1) * 4),
            'border-width': 0,
          },
        },
        {
          selector: 'edge',
          style: {
            'curve-style': 'bezier',
            'width': (el) => 1 + (el.data('confidence') || 0.5) * 2,
            'line-color': 'rgba(120,130,150,0.4)',
            'target-arrow-color': 'rgba(120,130,150,0.5)',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.7,
            'label': 'data(relation)',
            'font-size': 9,
            'color': 'var(--fg-3)',
            'text-rotation': 'autorotate',
            'text-background-color': 'var(--bg)',
            'text-background-opacity': 0.8,
            'text-background-padding': 2,
          },
        },
        {
          selector: 'edge[relation = "contradicts"]',
          style: { 'line-color': 'rgba(209,75,75,0.7)', 'target-arrow-color': 'rgba(209,75,75,0.8)' },
        },
        {
          selector: '.faded',
          style: { 'opacity': 0.15, 'text-opacity': 0 },
        },
        {
          selector: '.highlighted',
          style: { 'border-width': 3, 'border-color': 'var(--brand)' },
        },
      ],
      layout: {
        name: 'cose',
        animate: true,
        animationDuration: 500,
        nodeRepulsion: 7000,
        idealEdgeLength: 90,
        padding: 40,
      },
    });

    cy.on('tap', 'node', (evt) => {
      const node = evt.target;
      focusNode(node);
    });
    cy.on('tap', (evt) => {
      if (evt.target === cy) clearFocus();
    });
  }

  function focusNode(node) {
    if (!cy) return;
    focusedNode = node.id();
    cy.elements().addClass('faded');
    const neighborhood = node.closedNeighborhood();
    neighborhood.removeClass('faded');
    node.addClass('highlighted');

    const id = node.data('id');
    const type = node.data('type') || 'entity';
    const deg = node.degree();

    const neighbors = neighborhood.nodes().not(node).map((n) => ({ id: n.data('id'), type: n.data('type') }));

    $('#node-detail', root).innerHTML = `
      <div class="card" style="padding:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span class="graph-legend-dot" style="background:${NODE_COLORS[type] || NODE_COLORS.entity};width:12px;height:12px"></span>
          <strong style="font-size:14px">${escape(node.data('label'))}</strong>
        </div>
        <div class="muted" style="font-size:12px">${escape(type)} · ${deg} connection${deg === 1 ? '' : 's'}</div>
        ${neighbors.length ? `
          <div class="detail-section-title" style="margin-top:12px">Connected to</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px">
            ${neighbors.slice(0, 16).map((n) => `<span class="chip">${escape(n.id)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
    $('#graph-focus-off', root).hidden = false;
  }

  function clearFocus() {
    if (!cy) return;
    cy.elements().removeClass('faded');
    cy.elements().removeClass('highlighted');
    focusedNode = null;
    $('#node-detail', root).innerHTML = '';
    $('#graph-focus-off', root).hidden = true;
  }

  $('#graph-refresh', root).addEventListener('click', load);
  $('#graph-fit', root).addEventListener('click', () => cy && cy.fit(undefined, 40));
  $('#graph-focus-off', root).addEventListener('click', clearFocus);

  let loaded = false;
  return {
    onShow() {
      if (!loaded) { load(); loaded = true; }
      else if (cy) setTimeout(() => { cy.resize(); cy.fit(undefined, 40); }, 30);
    },
    onHide() {},
    onKey() {},
  };
}
