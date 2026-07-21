import { BrainView } from './brain.js';
import { GraphView } from './graph.js';
import { InsightsView } from './insights.js';
import { renderIcons } from '../icons.js';

const PANELS = {
  overview: { label: 'Overview', icon: 'brain-circuit', factory: BrainView },
  map: { label: 'Map', icon: 'network', factory: GraphView },
  signals: { label: 'Signals', icon: 'bar-chart-3', factory: InsightsView },
};

function requestedPanel() {
  if (location.hash.startsWith('#/graph')) return 'map';
  if (location.hash.startsWith('#/insights')) return 'signals';
  const match = location.hash.match(/^#\/topics\/([^?]+)/);
  return PANELS[match?.[1]] ? match[1] : 'overview';
}

export function TopicsView(root) {
  root.innerHTML = `
    <div class="context-view topics-view">
      <header class="context-header">
        <div>
          <div class="brain-kicker">Topics</div>
          <h1 class="display">Turn saved sources into working knowledge.</h1>
          <p>Organize projects, inspect relationships, and follow the signals inside your archive.</p>
        </div>
        <div class="toolbar-segment context-tabs" role="tablist" aria-label="Topic views">
          ${Object.entries(PANELS).map(([key, item]) => `<button class="segment-btn" role="tab" data-topic-panel="${key}" aria-selected="false"><span data-icon="${item.icon}"></span>${item.label}</button>`).join('')}
        </div>
      </header>
      <div class="context-panels">
        ${Object.keys(PANELS).map((key) => `<section class="context-panel" data-topic-content="${key}" hidden></section>`).join('')}
      </div>
    </div>`;
  renderIcons(root);

  const instances = {};
  let active = null;
  function show(panel, updateHash = true) {
    const next = PANELS[panel] ? panel : 'overview';
    if (active === next) return;
    if (active) instances[active]?.onHide?.();
    root.querySelectorAll('[data-topic-content]').forEach((node) => { node.hidden = node.dataset.topicContent !== next; });
    root.querySelectorAll('[data-topic-panel]').forEach((button) => {
      const selected = button.dataset.topicPanel === next;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    const mount = root.querySelector(`[data-topic-content="${next}"]`);
    if (!instances[next]) instances[next] = PANELS[next].factory(mount);
    active = next;
    instances[next]?.onShow?.();
    if (updateHash && location.hash !== `#/topics/${next}`) history.pushState(null, '', `#/topics/${next}`);
  }

  root.querySelector('.context-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-topic-panel]');
    if (button) show(button.dataset.topicPanel);
  });
  root.querySelector('.context-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const keys = Object.keys(PANELS);
    let index = keys.indexOf(active);
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = keys.length - 1;
    else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
    show(keys[index]);
    root.querySelector(`[data-topic-panel="${keys[index]}"]`)?.focus();
  });

  return {
    onShow() { show(requestedPanel(), false); },
    onHide() { instances[active]?.onHide?.(); },
    onRoute() { show(requestedPanel(), false); },
    onKey(event) { instances[active]?.onKey?.(event); },
  };
}
