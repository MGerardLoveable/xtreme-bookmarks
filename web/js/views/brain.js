// Xtreme Brain command center: topic spaces, memory cards, and friendly workflows.

import { api, fmtNumber, fmtRelativeTime } from '../api.js';
import { renderIcons } from '../icons.js';
import { $, escape, toast } from '../util.js';

const STARTERS = [
  {
    name: 'AI Research',
    keywords: 'ai, research, agents, autoresearch, karpathy, gbrain, gstack',
    project: 'karpathy/autoresearch, garrytan/gbrain, garrytan/gstack',
    icon: 'sparkles',
  },
  {
    name: 'Useful Tools',
    keywords: 'tool, github, open source, cli, app, workflow',
    project: '',
    icon: 'wrench',
  },
  {
    name: 'Security Watch',
    keywords: 'security, cve, vulnerability, exploit, privacy',
    project: '',
    icon: 'shield-check',
  },
];

const WORKFLOW_TOASTS = {
  capture: 'Cleaning up new saves...',
  distill: 'Distilling source-backed claims...',
  connect: 'Finding connections...',
  watch: 'Updating watchlists...',
  review: 'Reviewing weak spots...',
  repair: 'Repairing memory indexes...',
  publish: 'Updating Brain pages...',
};

export function BrainView(root) {
  const state = {
    dashboard: null,
    engine: null,
    selectedTopicId: null,
    bookmarks: [],
    projects: [],
    busyWorkflow: null,
  };

  root.innerHTML = `
    <div class="brain brain-friendly brain-x">
      <header class="brain-header brain-hero brain-command">
        <div>
          <div class="brain-kicker">Xtreme Brain</div>
          <h1 class="display">Make your saves usable.</h1>
          <p class="brain-subtitle">Capture bookmarks, X Feed items, notes, repos, and updates into topic spaces with citations, connections, and simple workflows.</p>
        </div>
        <div class="brain-hero-actions">
          <div class="brain-ai-status" id="brain-ai-status">
            <span data-icon="sparkles"></span>
            <span>Checking AI helper...</span>
          </div>
          <button class="btn" id="brain-refresh"><span data-icon="refresh-cw"></span>Refresh</button>
          <button class="btn btn-primary" data-workflow="watch"><span data-icon="radar"></span>Fresh update</button>
        </div>
      </header>

      <section class="brain-command-grid">
        <div class="brain-memory-panel">
          <div class="brain-section-title">Living memory</div>
          <div class="brain-memory-stats" id="brain-memory-stats"><div class="placeholder">Loading...</div></div>
          <div class="brain-entity-strip" id="brain-entities"></div>
        </div>
        <div class="brain-workflow-panel">
          <div class="brain-section-title">One-click workflows</div>
          <div class="brain-workflows" id="brain-workflows"><div class="placeholder">Loading...</div></div>
        </div>
      </section>

      <section class="brain-notepad brain-guided-save">
        <div>
          <div class="brain-section-title">Quick capture</div>
          <p>Drop an idea, claim, or source note here. Xtreme turns it into a memory card and links it to a matching topic when it can.</p>
        </div>
        <div class="notepad">
          <input type="text" class="input notepad-title" id="notepad-title" placeholder="Optional title">
          <input type="text" class="input" id="notepad-tags" placeholder="Tags, people, repos, or topics">
          <textarea class="notepad-textarea" id="notepad-text" placeholder="What should the Brain remember?" rows="4"></textarea>
          <div class="notepad-actions">
            <button class="btn btn-primary" id="notepad-add-to-brain"><span data-icon="brain-circuit"></span>Save to Brain</button>
            <button class="btn btn-ghost" id="notepad-clear">Clear</button>
          </div>
        </div>
      </section>

      <div class="brain-guide" id="brain-guide">
        <section class="brain-create-panel">
          <div class="brain-section-title">Create a topic</div>
          <form id="brain-create" class="brain-create-form">
            <label class="brain-field">
              <span>Topic name</span>
              <input class="input" name="name" placeholder="AI Research" required>
            </label>
            <label class="brain-field">
              <span>Words to watch</span>
              <input class="input" name="keywords" placeholder="ai, agents, papers">
            </label>
            <label class="brain-field">
              <span>GitHub projects</span>
              <input class="input" name="repo" placeholder="garrytan/gbrain, karpathy/autoresearch">
            </label>
            <button class="btn btn-primary brain-create-submit" type="submit"><span data-icon="plus"></span>Create topic</button>
          </form>
          <div class="brain-starters" id="brain-starters"></div>
        </section>

        <section class="brain-status-panel">
          <div class="brain-section-title">At a glance</div>
          <div class="brain-metric-grid" id="brain-metrics"><div class="placeholder">Loading...</div></div>
          <div id="brain-next-step" class="brain-next-step"></div>
        </section>
      </div>

      <div class="brain-workspace-grid">
        <section class="brain-topic-list-panel">
          <div class="brain-section-title">Topics</div>
          <div id="brain-topics" class="brain-topic-list"><div class="placeholder">Loading...</div></div>
        </section>

        <section class="brain-topic-detail-panel">
          <div class="brain-section-title">Topic details</div>
          <div id="brain-detail" class="brain-detail-panel"><div class="placeholder">Choose a topic.</div></div>
        </section>

        <section class="brain-updates-panel">
          <div class="brain-section-title">Updates and weak spots</div>
          <div id="brain-findings" class="brain-update-list"><div class="placeholder">Loading...</div></div>
        </section>
      </div>
    </div>
  `;

  function topicById(id) {
    return (state.dashboard?.spaces || []).find((space) => space.id === id);
  }

  function labelAgent(agentType) {
    if (agentType === 'repo_watcher') return 'Project update';
    if (agentType === 'research_scout') return 'New discovery';
    if (agentType === 'memory_curator') return 'Brain review';
    return 'Update';
  }

  function renderAiStatus() {
    const status = $('#brain-ai-status', root);
    const engine = state.engine;
    if (!engine) {
      status.innerHTML = '<span data-icon="sparkles"></span><span>AI helper offline</span>';
      status.className = 'brain-ai-status muted';
      renderIcons(status);
      return;
    }
    const defaultName = engine.defaultEngine || engine.engines?.[0] || null;
    if (engine.superGrokOauthAvailable || engine.grokApiConfigured) {
      status.innerHTML = `<span data-icon="check-circle-2"></span><span>AI helper ready${defaultName ? ` · ${escape(defaultName)}` : ''}</span>`;
      status.className = 'brain-ai-status ready';
    } else {
      status.innerHTML = `<span data-icon="sparkles"></span><span>${defaultName ? `Using ${escape(defaultName)}` : 'AI helper optional'}</span>`;
      status.className = 'brain-ai-status';
    }
    renderIcons(status);
  }

  function renderStarters() {
    $('#brain-starters', root).innerHTML = STARTERS.map((starter, index) => `
      <button class="brain-starter" type="button" data-starter="${index}">
        <span class="brain-starter-icon" data-icon="${starter.icon}"></span>
        <span>${escape(starter.name)}</span>
      </button>
    `).join('');
    root.querySelectorAll('[data-starter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const starter = STARTERS[Number(btn.dataset.starter)];
        const form = $('#brain-create', root);
        form.elements.name.value = starter.name;
        form.elements.keywords.value = starter.keywords;
        form.elements.repo.value = starter.project;
        form.elements.name.focus();
      });
    });
    renderIcons($('#brain-starters', root));
  }

  function renderMemory() {
    const memory = state.dashboard?.memory || {};
    $('#brain-memory-stats', root).innerHTML = [
      { label: 'Memory cards', value: memory.artifactCount || 0, icon: 'bookmark' },
      { label: 'Entities', value: memory.entityCount || 0, icon: 'tag' },
      { label: 'Connections', value: memory.edgeCount || 0, icon: 'network' },
      { label: 'Claims', value: memory.claimCount || 0, icon: 'check-circle-2' },
    ].map((item) => `
      <div class="brain-memory-stat">
        <span data-icon="${item.icon}"></span>
        <strong>${fmtNumber(item.value)}</strong>
        <small>${escape(item.label)}</small>
      </div>
    `).join('');

    const entities = memory.topEntities || [];
    $('#brain-entities', root).innerHTML = entities.length
      ? entities.slice(0, 8).map((entity) => `<span class="brain-entity-chip">${escape(entity.name)} <small>${escape(entity.kind)}</small></span>`).join('')
      : '<span class="brain-muted">Run Clean up new saves to build entity memory.</span>';
  }

  function renderWorkflows() {
    const workflows = state.dashboard?.workflows || [];
    $('#brain-workflows', root).innerHTML = workflows.map((workflow) => `
      <button class="brain-workflow ${state.busyWorkflow === workflow.id ? 'busy' : ''}" data-workflow="${escape(workflow.id)}" title="${escape(workflow.description)}">
        <span class="brain-workflow-icon" data-icon="${escape(workflow.icon || 'sparkles')}"></span>
        <span>
          <strong>${escape(workflow.name)}</strong>
          <small>${escape(workflow.lastRunAt ? `last run ${fmtRelativeTime(workflow.lastRunAt)} ago` : workflow.description)}</small>
        </span>
      </button>
    `).join('');
    root.querySelectorAll('.brain-workflow[data-workflow], .brain-hero-actions [data-workflow]').forEach((btn) => {
      btn.addEventListener('click', () => runWorkflow(btn.dataset.workflow));
    });
    renderIcons($('#brain-workflows', root));
    renderIcons($('.brain-hero-actions', root));
  }

  function renderDashboard() {
    const spaces = state.dashboard?.spaces || [];
    const findings = state.dashboard?.findings || [];
    const repoCount = state.dashboard?.repoCount || 0;
    const stale = state.dashboard?.staleSpaces || [];
    const memory = state.dashboard?.memory || {};

    renderMemory();
    renderWorkflows();

    $('#brain-metrics', root).innerHTML = [
      { label: 'Topics', value: spaces.length, icon: 'folder-kanban' },
      { label: 'Projects watched', value: repoCount, icon: 'github' },
      { label: 'Open updates', value: findings.length, icon: 'bell' },
      { label: 'Memory cards', value: memory.artifactCount || 0, icon: 'layers' },
    ].map((item) => `
      <div class="brain-metric">
        <span class="brain-metric-icon" data-icon="${item.icon}"></span>
        <span class="brain-metric-label">${escape(item.label)}</span>
        <strong>${fmtNumber(item.value)}</strong>
      </div>
    `).join('');

    const nextStep = spaces.length === 0
      ? 'Create one topic. AI Research is already filled in for you.'
      : (memory.artifactCount || 0) === 0
        ? 'Run Clean up new saves to create memory cards from your existing sources.'
        : findings.length > 0
          ? 'Review open updates and weak spots before they get buried.'
          : stale.length > 0
            ? 'Some topics need a fresh watchlist update.'
            : 'Your Brain has source-backed memory and is ready to ask.';
    $('#brain-next-step', root).innerHTML = `
      <span data-icon="${spaces.length === 0 ? 'arrow-up-right' : findings.length > 0 ? 'bell' : 'check-circle-2'}"></span>
      <span>${escape(nextStep)}</span>
    `;

    $('#brain-topics', root).innerHTML = spaces.length ? spaces.map((space) => `
      <button class="brain-topic-card ${state.selectedTopicId === space.id ? 'active' : ''}" data-topic-id="${escape(space.id)}">
        <span class="brain-topic-avatar">${escape(space.name.slice(0, 1).toUpperCase())}</span>
        <span class="brain-topic-main">
          <strong>${escape(space.name)}</strong>
          <span>${fmtNumber(space.bookmarkCount)} bookmarks · ${fmtNumber(space.repoCount)} projects · ${fmtNumber(space.openFindings)} updates</span>
          <small>${escape((space.keywords || []).slice(0, 5).join(', ') || space.description || 'No watch words yet')}</small>
        </span>
      </button>
    `).join('') : `
      <div class="brain-empty">
        <span data-icon="folder-plus"></span>
        <strong>No topics yet</strong>
        <p>Create one topic and Xtreme will gather matching bookmarks and updates.</p>
      </div>
    `;

    $('#brain-findings', root).innerHTML = findings.length ? findings.map((finding) => `
      <article class="brain-update-card ${finding.severity === 'warning' ? 'warning' : ''}">
        <div class="brain-update-type">${escape(labelAgent(finding.agentType))}</div>
        <h3>${escape(finding.title)}</h3>
        <p>${escape((finding.detail || '').slice(0, 220))}</p>
        <div class="brain-update-footer">
          <span>${escape(finding.spaceName || finding.spaceId)}</span>
          ${finding.url ? `<a class="btn btn-sm btn-ghost" href="${escape(finding.url)}" target="_blank" rel="noopener"><span data-icon="external-link"></span>Open</a>` : ''}
        </div>
      </article>
    `).join('') : `
      <div class="brain-empty compact">
        <span data-icon="check-circle-2"></span>
        <strong>No open updates</strong>
        <p>Run Review or Fresh update when you want a new scan.</p>
      </div>
    `;

    root.querySelectorAll('[data-topic-id]').forEach((btn) => {
      btn.addEventListener('click', () => selectTopic(btn.dataset.topicId));
    });
    renderIcons(root);
  }

  async function selectTopic(id) {
    state.selectedTopicId = id;
    renderDashboard();
    await loadDetail();
  }

  async function loadDetail() {
    const topic = topicById(state.selectedTopicId);
    if (!topic) {
      $('#brain-detail', root).innerHTML = '<div class="brain-empty compact"><span data-icon="mouse-pointer-2"></span><strong>Choose a topic</strong><p>Your memory cards, bookmarks, and watched projects will appear here.</p></div>';
      renderIcons($('#brain-detail', root));
      return;
    }

    $('#brain-detail', root).innerHTML = '<div class="placeholder">Loading topic...</div>';
    try {
      const [{ bookmarks }, { repos }] = await Promise.all([
        api.brainSpaceBookmarks(topic.id),
        api.brainSpaceRepos(topic.id),
      ]);
      state.bookmarks = bookmarks || [];
      state.projects = repos || [];
      renderDetail(topic);
    } catch (err) {
      $('#brain-detail', root).innerHTML = `<div class="placeholder">Failed: ${escape(err.message)}</div>`;
    }
  }

  function renderDetail(topic) {
    const recentMemory = (state.dashboard?.memory?.recentArtifacts || []).filter((item) => item.spaceId === topic.id).slice(0, 5);
    $('#brain-detail', root).innerHTML = `
      <div class="brain-topic-detail-header">
        <div>
          <h2>${escape(topic.name)}</h2>
          <p>${escape(topic.description || (topic.keywords || []).join(', ') || 'This topic is ready for bookmarks, notes, and watched projects.')}</p>
        </div>
        <div class="brain-topic-actions">
          <button class="btn" id="topic-seed"><span data-icon="wand-sparkles"></span>Gather bookmarks</button>
          <button class="btn btn-primary" data-workflow-topic="watch"><span data-icon="radar"></span>Fresh update</button>
        </div>
      </div>

      <div class="brain-topic-actions-row">
        <button class="btn btn-sm" data-workflow-topic="capture"><span data-icon="inbox"></span>Clean up saves</button>
        <button class="btn btn-sm" data-workflow-topic="connect"><span data-icon="network"></span>Find connections</button>
        <button class="btn btn-sm" data-workflow-topic="review"><span data-icon="clock-3"></span>Review topic</button>
        <button class="btn btn-sm" data-workflow-topic="publish"><span data-icon="folder"></span>Update page</button>
      </div>

      <form id="topic-project-form" class="brain-project-form">
        <label class="brain-field">
          <span>Add GitHub project to watch</span>
          <input class="input" name="repo" placeholder="github.com/owner/project">
        </label>
        <button class="btn" type="submit"><span data-icon="plus"></span>Add</button>
      </form>

      <div class="brain-detail-columns">
        <section>
          <div class="brain-section-title">Memory cards</div>
          <div class="brain-mini-list">
            ${recentMemory.length ? recentMemory.map((item) => `
              <a class="brain-bookmark-row brain-memory-row" href="${escape(item.url || '#')}" target="_blank" rel="noopener">
                <strong>${escape(item.title)}</strong>
                <span>${escape((item.body || '').slice(0, 130))}</span>
                <small>${escape(item.sourceLabel || item.sourceType)}${item.author ? ` · ${escape(item.author)}` : ''}</small>
              </a>
            `).join('') : '<div class="placeholder">Run Clean up saves to make memory cards for this topic.</div>'}
          </div>
        </section>

        <section>
          <div class="brain-section-title">Watched projects</div>
          <div class="brain-mini-list">
            ${state.projects.length ? state.projects.map((project) => `
              <div class="brain-mini-row">
                <span data-icon="github"></span>
                <strong>${escape(project.repo)}</strong>
                <small>${escape(project.lastCheckedAt ? `checked ${fmtRelativeTime(project.lastCheckedAt)} ago` : 'new')}</small>
              </div>
            `).join('') : '<div class="placeholder">No projects yet.</div>'}
          </div>
        </section>

        <section>
          <div class="brain-section-title">Best matching bookmarks</div>
          <div class="brain-mini-list">
            ${state.bookmarks.length ? state.bookmarks.slice(0, 8).map((bookmark) => `
              <a class="brain-bookmark-row" href="${escape(bookmark.url || '#')}" target="_blank" rel="noopener">
                <strong>${escape(bookmark.authorHandle ? '@' + bookmark.authorHandle : bookmark.authorName || 'Bookmark')}</strong>
                <span>${escape((bookmark.text || '').slice(0, 120))}</span>
              </a>
            `).join('') : '<div class="placeholder">No bookmarks gathered yet.</div>'}
          </div>
        </section>
      </div>
    `;

    $('#topic-seed', root).addEventListener('click', async () => {
      toast('Gathering matching bookmarks...');
      try {
        const result = await api.seedBrainSpace(topic.id);
        toast(`Gathered ${result.added} new bookmarks`, 2500);
        await runWorkflow('capture', topic.id, false);
      } catch (err) {
        toast(`Could not gather bookmarks: ${err.message}`);
      }
    });

    root.querySelectorAll('[data-workflow-topic]').forEach((btn) => {
      btn.addEventListener('click', () => runWorkflow(btn.dataset.workflowTopic, topic.id));
    });

    $('#topic-project-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const repo = String(new FormData(event.currentTarget).get('repo') || '').trim();
      if (!repo) return;
      try {
        await api.addBrainRepo(topic.id, repo);
        event.currentTarget.reset();
        toast('Project added');
        await loadDetail();
      } catch (err) {
        toast(`Could not add project: ${err.message}`);
      }
    });
    renderIcons($('#brain-detail', root));
  }

  async function runWorkflow(workflow, target = 'all', showToast = true) {
    if (!workflow || state.busyWorkflow) return;
    state.busyWorkflow = workflow;
    if (showToast) toast(WORKFLOW_TOASTS[workflow] || 'Running Brain workflow...', 4000);
    renderDashboard();
    try {
      const result = await api.runBrainWorkflow(workflow, target);
      toast(result.summary || 'Brain workflow finished', 3500);
      await load();
      if (state.selectedTopicId) await loadDetail();
    } catch (err) {
      toast(`Brain workflow failed: ${err.message}`);
    } finally {
      state.busyWorkflow = null;
      renderDashboard();
    }
  }

  function setupNotepad() {
    const titleInput = $('#notepad-title', root);
    const textInput = $('#notepad-text', root);
    const tagsInput = $('#notepad-tags', root);
    const addBtn = $('#notepad-add-to-brain', root);
    const clearBtn = $('#notepad-clear', root);

    clearBtn.addEventListener('click', () => {
      titleInput.value = '';
      textInput.value = '';
      tagsInput.value = '';
    });

    addBtn.addEventListener('click', async () => {
      const text = textInput.value.trim();
      if (!text) {
        toast('Write a note first');
        return;
      }
      const tags = tagsInput.value.split(',').map((tag) => tag.trim()).filter(Boolean);
      try {
        await api.createBrainNote({
          title: titleInput.value.trim(),
          text,
          tags,
          spaceId: state.selectedTopicId,
        });
        titleInput.value = '';
        textInput.value = '';
        tagsInput.value = '';
        toast('Saved to Brain');
        await load();
      } catch (err) {
        toast(`Could not save note: ${err.message}`);
      }
    });
  }

  async function load() {
    try {
      const [dashboard, engine] = await Promise.all([
        api.brainDashboard(),
        api.brainEngine().catch(() => null),
      ]);
      state.dashboard = dashboard;
      state.engine = engine;
      if (!state.selectedTopicId && dashboard.spaces?.length) state.selectedTopicId = dashboard.spaces[0].id;
      if (state.selectedTopicId && !topicById(state.selectedTopicId)) state.selectedTopicId = dashboard.spaces?.[0]?.id || null;
      renderStarters();
      renderAiStatus();
      renderDashboard();
      await loadDetail();
    } catch (err) {
      $('#brain-topics', root).innerHTML = `<div class="placeholder">Failed: ${escape(err.message)}</div>`;
    }
  }

  $('#brain-refresh', root).addEventListener('click', load);

  $('#brain-create', root).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    if (!name) return;
    const repos = String(data.get('repo') || '')
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    try {
      const result = await api.createBrainSpace({
        name,
        keywords: String(data.get('keywords') || '').split(',').map((k) => k.trim()).filter(Boolean),
        repos,
      });
      await api.seedBrainSpace(result.space.id);
      form.reset();
      state.selectedTopicId = result.space.id;
      toast('Topic created');
      await runWorkflow('capture', result.space.id, false);
    } catch (err) {
      toast(`Could not create topic: ${err.message}`);
    }
  });

  setupNotepad();
  renderIcons(root);

  let loaded = false;
  return {
    onShow() {
      if (loaded) return;
      loaded = true;
      load();
    },
    onHide() {},
    onKey() {},
  };
}
