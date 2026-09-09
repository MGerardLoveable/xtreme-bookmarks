// Topic workspace: source spaces, memory cards, and guided workflows.

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
  publish: 'Updating topic pages...',
};

export function BrainView(root) {
  const state = {
    dashboard: null,
    engine: null,
    selectedTopicId: null,
    bookmarks: [],
    projects: [],
    brief: null,
    findings: null,
    findingFilter: 'open',
    busyWorkflow: null,
  };
  let loadVersion = 0;
  let detailVersion = 0;

  root.innerHTML = `
    <div class="brain brain-friendly brain-x">
      <header class="brain-header brain-hero brain-command">
        <div>
          <div class="brain-kicker">Knowledge workspaces</div>
          <h1 class="display">Turn signals into work.</h1>
          <p class="brain-subtitle">Projects, open questions, dossiers, and durable topics built from source-backed memory.</p>
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
          <textarea class="notepad-textarea" id="notepad-text" placeholder="What should this topic remember?" rows="4"></textarea>
          <div class="notepad-actions">
            <button class="btn btn-primary" id="notepad-add-to-brain"><span data-icon="brain-circuit"></span>Save to Topics</button>
            <button class="btn btn-ghost" id="notepad-clear">Clear</button>
          </div>
        </div>
      </section>

      <div class="brain-guide" id="brain-guide">
        <section class="brain-create-panel">
          <div class="brain-section-title">Create a workspace</div>
          <form id="brain-create" class="brain-create-form">
            <label class="brain-field">
              <span>Type</span>
              <select class="input" name="kind">
                <option value="project">Project</option>
                <option value="question">Open question</option>
                <option value="dossier">Dossier</option>
                <option value="topic">Topic</option>
              </select>
            </label>
            <label class="brain-field">
              <span>Name</span>
              <input class="input" name="name" placeholder="AI Research" required>
            </label>
            <label class="brain-field brain-field-wide">
              <span>Focus question</span>
              <input class="input" name="focusQuestion" placeholder="What decision or outcome should this workspace support?">
            </label>
            <label class="brain-field">
              <span>Words to watch</span>
              <input class="input" name="keywords" placeholder="ai, agents, papers">
            </label>
            <label class="brain-field">
              <span>GitHub projects</span>
              <input class="input" name="repo" placeholder="garrytan/gbrain, karpathy/autoresearch">
            </label>
            <button class="btn btn-primary brain-create-submit" type="submit"><span data-icon="plus"></span>Create workspace</button>
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
          <div class="brain-section-title">Workspaces</div>
          <div id="brain-topics" class="brain-topic-list"><div class="placeholder">Loading...</div></div>
        </section>

        <section class="brain-topic-detail-panel">
          <div class="brain-section-title">Workspace details</div>
          <div id="brain-detail" class="brain-detail-panel"><div class="placeholder">Choose a topic.</div></div>
        </section>

        <section class="brain-updates-panel">
          <div class="brain-updates-heading">
            <div class="brain-section-title">Review queue</div>
            <div class="brain-finding-filters" role="tablist" aria-label="Update history">
              <button type="button" data-finding-filter="open" role="tab">Open</button>
              <button type="button" data-finding-filter="accepted" role="tab">Accepted</button>
              <button type="button" data-finding-filter="dismissed" role="tab">Dismissed</button>
            </div>
          </div>
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
    if (agentType === 'memory_curator') return 'Topic review';
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
    const findings = state.findings ?? state.dashboard?.findings ?? [];
    const openFindingCount = spaces.reduce((total, space) => total + Number(space.openFindings || 0), 0);
    const repoCount = state.dashboard?.repoCount || 0;
    const stale = state.dashboard?.staleSpaces || [];
    const memory = state.dashboard?.memory || {};

    renderMemory();
    renderWorkflows();

    $('#brain-metrics', root).innerHTML = [
      { label: 'Workspaces', value: spaces.length, icon: 'folder-kanban' },
      { label: 'Projects watched', value: repoCount, icon: 'github' },
      { label: 'Open updates', value: openFindingCount, icon: 'bell' },
      { label: 'Memory cards', value: memory.artifactCount || 0, icon: 'layers' },
    ].map((item) => `
      <div class="brain-metric">
        <span class="brain-metric-icon" data-icon="${item.icon}"></span>
        <span class="brain-metric-label">${escape(item.label)}</span>
        <strong>${fmtNumber(item.value)}</strong>
      </div>
    `).join('');

    const nextStep = spaces.length === 0
      ? 'Create one workspace. AI Research is already filled in for you.'
      : (memory.artifactCount || 0) === 0
        ? 'Run Clean up new saves to create memory cards from your existing sources.'
        : openFindingCount > 0
          ? 'Review open updates and weak spots before they get buried.'
          : stale.length > 0
            ? 'Some topics need a fresh watchlist update.'
            : 'Your workspaces have source-backed memory and are ready to ask.';
    $('#brain-next-step', root).innerHTML = `
      <span data-icon="${spaces.length === 0 ? 'arrow-up-right' : openFindingCount > 0 ? 'bell' : 'check-circle-2'}"></span>
      <span>${escape(nextStep)}</span>
    `;

    $('#brain-topics', root).innerHTML = spaces.length ? spaces.map((space) => `
      <button class="brain-topic-card ${state.selectedTopicId === space.id ? 'active' : ''}" data-topic-id="${escape(space.id)}">
        <span class="brain-topic-avatar">${escape(space.name.slice(0, 1).toUpperCase())}</span>
        <span class="brain-topic-main">
          <strong>${escape(space.name)} <em class="workspace-kind">${escape(space.kind || 'project')}</em></strong>
          <span>${fmtNumber(space.bookmarkCount)} bookmarks · ${fmtNumber(space.repoCount)} projects · ${fmtNumber(space.openFindings)} updates</span>
          <small>${escape(space.focusQuestion || (space.keywords || []).slice(0, 5).join(', ') || space.description || 'No focus question yet')}</small>
        </span>
      </button>
    `).join('') : `
      <div class="brain-empty">
        <span data-icon="folder-plus"></span>
        <strong>No workspaces yet</strong>
        <p>Create one workspace and Xtreme will gather matching bookmarks and updates.</p>
      </div>
    `;

    root.querySelectorAll('[data-finding-filter]').forEach((button) => {
      const active = button.dataset.findingFilter === state.findingFilter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    $('#brain-findings', root).innerHTML = findings.length ? findings.map((finding) => `
      <article class="brain-update-card ${finding.severity === 'warning' ? 'warning' : ''}" data-finding-id="${escape(finding.id)}">
        <div class="brain-update-type">${finding.resolved ? escape(finding.decision === 'accepted' ? 'Accepted into memory' : 'Dismissed') : escape(labelAgent(finding.agentType))}</div>
        <h3>${escape(finding.title)}</h3>
        <p>${escape((finding.detail || '').slice(0, 220))}</p>
        ${finding.resolved && finding.decisionNote ? `<p class="brain-decision-note"><strong>Your note</strong>${escape(finding.decisionNote)}</p>` : ''}
        <div class="brain-update-footer">
          <span>${escape(finding.spaceName || finding.spaceId)}${finding.decidedAt ? ` · ${escape(fmtRelativeTime(finding.decidedAt))} ago` : ''}</span>
          <div class="brain-update-actions">
            ${finding.url ? `<a class="icon-btn" href="${escape(finding.url)}" target="_blank" rel="noopener" title="Open source" aria-label="Open source"><span data-icon="external-link"></span></a>` : ''}
            ${finding.resolved ? '' : `
              <button class="btn btn-sm btn-ghost" type="button" data-finding-edit><span data-icon="edit-3"></span>Edit</button>
              <button class="btn btn-sm" type="button" data-finding-quick="dismissed"><span data-icon="x"></span>Dismiss</button>
              <button class="btn btn-sm btn-primary" type="button" data-finding-quick="accepted"><span data-icon="check"></span>Accept</button>
            `}
          </div>
        </div>
        ${finding.resolved ? '' : `<form class="brain-finding-review" hidden>
          <label><span>Title</span><input class="input" name="title" value="${escape(finding.title)}" required></label>
          <label><span>What should this workspace remember?</span><textarea class="input" name="detail" rows="4" required>${escape(finding.detail || '')}</textarea></label>
          <label><span>Private review note <em>optional</em></span><textarea class="input" name="note" rows="2" placeholder="Why this matters, what to verify, or how you expect to use it"></textarea></label>
          <div class="brain-finding-review-actions">
            <button class="btn btn-sm btn-ghost" type="button" data-finding-cancel>Cancel</button>
            <button class="btn btn-sm" type="submit" data-finding-decision="dismissed"><span data-icon="x"></span>Dismiss</button>
            <button class="btn btn-sm btn-primary" type="submit" data-finding-decision="accepted"><span data-icon="check"></span>Accept into memory</button>
          </div>
        </form>`}
      </article>
    `).join('') : `
      <div class="brain-empty compact">
        <span data-icon="check-circle-2"></span>
        <strong>No ${escape(state.findingFilter)} updates</strong>
        <p>${state.findingFilter === 'open' ? 'Run Review or Fresh update when you want a new scan.' : 'Reviewed updates will remain available here as a durable decision history.'}</p>
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
    const version = ++detailVersion;
    const topic = topicById(state.selectedTopicId);
    if (!topic) {
      $('#brain-detail', root).innerHTML = '<div class="brain-empty compact"><span data-icon="mouse-pointer-2"></span><strong>Choose a topic</strong><p>Your memory cards, bookmarks, and watched projects will appear here.</p></div>';
      renderIcons($('#brain-detail', root));
      return;
    }

    $('#brain-detail', root).innerHTML = '<div class="placeholder">Loading topic...</div>';
    try {
      const [{ bookmarks }, { repos }, { brief }] = await Promise.all([
        api.brainSpaceBookmarks(topic.id),
        api.brainSpaceRepos(topic.id),
        api.brainSpaceBrief(topic.id),
      ]);
      if (version !== detailVersion || state.selectedTopicId !== topic.id) return;
      state.bookmarks = bookmarks || [];
      state.projects = repos || [];
      state.brief = brief || null;
      renderDetail(topic);
    } catch (err) {
      $('#brain-detail', root).innerHTML = `<div class="placeholder">Failed: ${escape(err.message)}</div>`;
    }
  }

  function renderDetail(topic) {
    const brief = state.brief || {};
    const keyIdeas = brief.keyIdeas || [];
    const practice = brief.practice || null;
    const nextActions = brief.nextActions || [];
    const openQuestions = brief.openQuestions || [];
    const recentMemory = brief.recentEvidence || [];
    const history = brief.understanding || [];
    const understanding = history[0] || {};
    const understandingFields = [
      ['conclusion', 'My current conclusion', 'What do you believe, and why?'],
      ['challenge', 'What would change my mind?', 'A counterexample, missing evidence, or an assumption to test'],
      ['nextStep', 'Next experiment', 'One concrete action you can take'],
      ['successMeasure', 'Success looks like', 'What observable result will tell you it worked?'],
      ['outcome', 'What actually happened', 'Results, surprises, and what you would do differently'],
    ];
    const evidenceIds = [...new Set([...keyIdeas.map(idea => idea.bookmarkId), ...(understanding.evidenceIds || [])])];
    $('#brain-detail', root).innerHTML = `
      <div class="brain-topic-detail-header">
        <div>
          <div class="workspace-detail-label">${escape(topic.kind || 'project')} · ${escape(topic.status || 'active')}</div>
          <h2>${escape(topic.name)}</h2>
          <p>${escape(topic.focusQuestion || topic.description || (topic.keywords || []).join(', ') || 'This workspace is ready for bookmarks, notes, and watched projects.')}</p>
        </div>
        <div class="brain-topic-actions">
          <button class="btn" id="topic-ask"><span data-icon="sparkles"></span>Ask this workspace</button>
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

      <section class="brain-current-picture">
        <div class="brain-section-title">Current picture</div>
        <p>${escape(brief.overview || topic.focusQuestion || topic.description || 'Gather sources to build a current picture.')}</p>
        <form id="topic-focus-form" class="brain-focus-form">
          <input class="input" name="focusQuestion" value="${escape(topic.focusQuestion || '')}" placeholder="What should this workspace help you answer or decide?">
          <button class="btn btn-sm" type="submit"><span data-icon="check"></span>Save focus</button>
        </form>
      </section>

      <section class="brain-understanding" aria-labelledby="understanding-title">
        <header><h3 id="understanding-title">Working understanding</h3><span>${history.length ? `Updated ${escape(new Date(understanding.savedAt).toLocaleDateString())}` : 'Your perspective'}</span></header>
        <form id="understanding-form">
          <div class="understanding-fields">${understandingFields.map(([name, label, placeholder]) => `
            <label><span>${label}</span><textarea class="input" name="${name}" rows="3" maxlength="6000" placeholder="${placeholder}">${escape(understanding[name] || '')}</textarea></label>
          `).join('')}</div>
          <fieldset class="understanding-evidence"><legend>Supporting or challenging evidence</legend>
            ${evidenceIds.length ? evidenceIds.map(id => {
              const idea = keyIdeas.find(item => item.bookmarkId === id);
              return `<label><input type="checkbox" name="evidenceIds" value="${escape(id)}" ${(understanding.evidenceIds || []).includes(id) ? 'checked' : ''}><span>${escape(idea?.title || `Saved source ${id}`)}</span><button type="button" class="icon-btn" data-open-bookmark="${escape(id)}" aria-label="Open evidence" title="Open evidence"><span data-icon="external-link"></span></button></label>`;
            }).join('') : '<p>No workspace sources yet.</p>'}
          </fieldset>
          <footer><button class="btn btn-primary" type="submit"><span data-icon="save"></span>Save understanding</button><span role="status" id="understanding-status"></span></footer>
        </form>
        ${history.length ? `<details class="understanding-history"><summary>Thinking history (${history.length}${history.length === 20 ? ' most recent' : ''})</summary>${history.map(record => `<article><time>${escape(new Date(record.savedAt).toLocaleString())}</time>${understandingFields.filter(([name]) => record[name]).map(([name,label]) => `<h4>${label}</h4><p>${escape(record[name])}</p>`).join('')}<small>${record.evidenceIds.length} linked sources</small></article>`).join('')}</details>` : ''}
      </section>

      ${practice ? `<section class="brain-study-strip" data-study-bookmark="${escape(practice.bookmarkId)}">
        <div class="brain-study-copy">
          <div class="brain-section-title">Recall and apply</div>
          <h3>${escape(practice.cue)}</h3>
          <textarea class="input brain-study-response" rows="3" placeholder="Explain it from memory in 1–3 sentences"></textarea>
        </div>
        <div class="brain-study-actions">
          <button class="btn" type="button" data-study-reveal><span data-icon="eye"></span>Reveal answer</button>
          <button class="btn btn-primary" type="button" data-study-schedule><span data-icon="brain-circuit"></span>Practice on Home</button>
        </div>
        <div class="brain-study-answer" data-study-answer hidden>
          <strong>Source-backed answer</strong>
          <p>${escape(practice.answer)}</p>
          ${practice.whyItMatters ? `<small><b>Why it matters</b>${escape(practice.whyItMatters)}</small>` : ''}
          <div class="brain-study-application"><span data-icon="arrow-right"></span><span>${escape(practice.applicationPrompt)}</span></div>
          <button class="btn btn-sm btn-ghost" type="button" data-open-bookmark="${escape(practice.bookmarkId)}"><span data-icon="external-link"></span>Open source</button>
        </div>
      </section>` : ''}

      <div class="brain-brief-grid">
        <section>
          <div class="brain-section-title">What you know</div>
          <div class="brain-idea-list">
            ${keyIdeas.length ? keyIdeas.map((idea, index) => `
              <button class="brain-idea-row" type="button" data-open-bookmark="${escape(idea.bookmarkId)}">
                <span class="brain-idea-index">${String(index + 1).padStart(2, '0')}</span>
                <span><strong>${escape(idea.title)}</strong><small>${escape(idea.whyItMatters || idea.author ? `${idea.whyItMatters || ''}${idea.whyItMatters && idea.author ? ' · ' : ''}${idea.author ? '@' + idea.author.replace(/^@/, '') : ''}` : idea.detail.slice(0, 160))}</small></span>
              </button>
            `).join('') : '<div class="placeholder">Run Clean up saves to distill the strongest ideas.</div>'}
          </div>
        </section>
        <section>
          <div class="brain-section-title">Next moves</div>
          <div class="brain-action-list">
            ${nextActions.length ? nextActions.map((item) => `
              <button class="brain-action-row" type="button" data-open-bookmark="${escape(item.bookmarkId)}">
                <span data-icon="arrow-right"></span><span><strong>${escape(item.action)}</strong><small>Based on ${escape(item.sourceTitle)}</small></span>
              </button>
            `).join('') : '<div class="placeholder">No source-backed actions yet. Ask this workspace for a practical plan.</div>'}
          </div>
        </section>
        <section>
          <div class="brain-section-title">Needs review</div>
          <div class="brain-question-list">
            ${openQuestions.length ? openQuestions.map((item) => `
              <${item.url ? `a href="${escape(item.url)}" target="_blank" rel="noopener"` : 'div'} class="brain-question-row ${escape(item.severity)}">
                <strong>${escape(item.title)}</strong><small>${escape(item.detail.slice(0, 180))}</small>
              </${item.url ? 'a' : 'div'}>
            `).join('') : '<div class="brain-clear-state"><span data-icon="check-circle-2"></span><span>No open gaps have been flagged.</span></div>'}
          </div>
        </section>
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
          <div class="brain-section-title">Project intelligence</div>
          <div class="brain-mini-list brain-project-list">
            ${state.projects.length ? state.projects.map((project) => `
              <article class="brain-project-card">
                <div class="brain-project-heading">
                  <span data-icon="github"></span>
                  <div>
                    <a href="${escape(project.htmlUrl || `https://github.com/${project.repo}`)}" target="_blank" rel="noopener"><strong>${escape(project.repo)}</strong></a>
                    <small>${escape(project.lastCheckedAt ? `Checked ${fmtRelativeTime(project.lastCheckedAt)} ago` : 'Waiting for first update')}</small>
                  </div>
                  ${project.stars ? `<span class="brain-project-stat"><span data-icon="star"></span>${Number(project.stars).toLocaleString()}</span>` : ''}
                </div>
                <p>${escape(project.description || 'Run Fresh update to build a plain-English project brief.')}</p>
                ${project.topics?.length ? `<div class="brain-project-topics">${project.topics.slice(0, 5).map((topic) => `<span>${escape(topic)}</span>`).join('')}</div>` : ''}
                ${project.latestCommitTitle || project.latestReleaseName ? `
                  <div class="brain-project-latest">
                    <span>${escape(project.latestReleaseName ? 'Latest release' : 'Latest change')}</span>
                    <a href="${escape(project.latestReleaseUrl || project.latestCommitUrl || project.htmlUrl)}" target="_blank" rel="noopener">${escape(project.latestReleaseName || project.latestCommitTitle)}</a>
                    ${project.latestCommitAt && !project.latestReleaseName ? `<small>${escape(project.latestCommitAuthor || 'Contributor')} · ${escape(fmtRelativeTime(project.latestCommitAt))} ago</small>` : ''}
                  </div>
                ` : ''}
                ${project.recommendedAction ? `
                  <div class="brain-project-action">
                    <span data-icon="arrow-right-circle"></span>
                    <div><small>Next useful move</small><strong>${escape(project.recommendedAction)}</strong></div>
                  </div>
                ` : ''}
              </article>
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

    $('#topic-ask', root).addEventListener('click', () => {
      const question = topic.focusQuestion
        ? `Using only my ${topic.name} workspace, help me answer: ${topic.focusQuestion}`
        : `Synthesize my ${topic.name} workspace. Explain what I know, what is uncertain, and the highest-value next actions.`;
      document.dispatchEvent(new CustomEvent('xb:navigate', {
        detail: { view: 'ask', ask: { question, topicId: topic.id } },
      }));
    });

    root.querySelectorAll('[data-open-bookmark]').forEach((button) => {
      button.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('xb:navigate', {
          detail: { view: 'library', bookmarkId: button.dataset.openBookmark },
        }));
      });
    });

    const studyStrip = root.querySelector('[data-study-bookmark]');
    studyStrip?.querySelector('[data-study-reveal]')?.addEventListener('click', (event) => {
      const answer = studyStrip.querySelector('[data-study-answer]');
      answer.hidden = false;
      event.currentTarget.hidden = true;
    });
    studyStrip?.querySelector('[data-study-schedule]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await api.scheduleBrainPractice(topic.id, studyStrip.dataset.studyBookmark);
        button.innerHTML = '<span data-icon="check"></span>Added to Home';
        toast('Added to your recall practice');
        renderIcons(button);
      } catch (err) {
        button.disabled = false;
        toast(`Could not schedule practice: ${err.message}`);
      }
    });

    $('#understanding-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('[type="submit"]');
      if (button.disabled) return;
      const values = new FormData(form);
      const payload = Object.fromEntries(understandingFields.map(([name]) => [name, String(values.get(name) || '')]));
      payload.evidenceIds = values.getAll('evidenceIds');
      button.disabled = true;
      try {
        await api.saveUnderstanding(topic.id, payload);
        toast('Understanding saved with its evidence');
        await loadDetail();
      } catch (err) {
        $('#understanding-status', root).textContent = err.message;
        button.disabled = false;
      }
    });

    $('#topic-focus-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const focusQuestion = String(new FormData(event.currentTarget).get('focusQuestion') || '').trim();
      try {
        const { space } = await api.updateBrainSpace(topic.id, { focusQuestion });
        const index = state.dashboard.spaces.findIndex((item) => item.id === topic.id);
        if (index >= 0) state.dashboard.spaces[index] = space;
        toast(focusQuestion ? 'Workspace focus saved' : 'Workspace focus cleared');
        renderDashboard();
        await loadDetail();
      } catch (err) {
        toast(`Could not save focus: ${err.message}`);
      }
    });

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
    if (showToast) toast(WORKFLOW_TOASTS[workflow] || 'Running topic workflow...', 4000);
    renderDashboard();
    try {
      const result = await api.runBrainWorkflow(workflow, target);
      toast(result.summary || 'Topic workflow finished', 3500);
      await load();
      if (state.selectedTopicId) await loadDetail();
    } catch (err) {
      toast(`Topic workflow failed: ${err.message}`);
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
        toast('Saved to Topics');
        await load();
      } catch (err) {
        toast(`Could not save note: ${err.message}`);
      }
    });
  }

  async function load() {
    const version = ++loadVersion;
    try {
      const [dashboard, engine, filteredFindings] = await Promise.all([
        api.brainDashboard(),
        api.brainEngine().catch(() => null),
        api.brainAgentFindings(50, state.findingFilter === 'open', state.findingFilter),
      ]);
      if (version !== loadVersion) return;
      state.dashboard = dashboard;
      state.engine = engine;
      state.findings = filteredFindings.findings || [];
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

  root.querySelector('.brain-finding-filters').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-finding-filter]');
    if (!button || button.dataset.findingFilter === state.findingFilter) return;
    state.findingFilter = button.dataset.findingFilter;
    state.findings = [];
    $('#brain-findings', root).innerHTML = '<div class="placeholder">Loading update history...</div>';
    await load();
  });

  $('#brain-findings', root).addEventListener('click', async (event) => {
    const card = event.target.closest('[data-finding-id]');
    if (!card) return;
    const form = card.querySelector('.brain-finding-review');
    if (event.target.closest('[data-finding-edit]')) {
      form.hidden = false;
      form.querySelector('[name="title"]').focus();
      return;
    }
    if (event.target.closest('[data-finding-cancel]')) {
      form.hidden = true;
      return;
    }
    const quick = event.target.closest('[data-finding-quick]');
    if (!quick) return;
    await reviewFinding(card, { decision: quick.dataset.findingQuick });
  });

  $('#brain-findings', root).addEventListener('submit', async (event) => {
    const form = event.target.closest('.brain-finding-review');
    if (!form) return;
    event.preventDefault();
    const card = form.closest('[data-finding-id]');
    const data = new FormData(form);
    await reviewFinding(card, {
      decision: event.submitter?.dataset.findingDecision,
      title: String(data.get('title') || '').trim(),
      detail: String(data.get('detail') || '').trim(),
      note: String(data.get('note') || '').trim(),
    });
  });

  async function reviewFinding(card, payload) {
    if (!card || !payload.decision) return;
    card.classList.add('is-busy');
    try {
      const result = await api.decideBrainFinding(card.dataset.findingId, payload);
      const accepted = payload.decision === 'accepted';
      toast(accepted
        ? (result.watchedRepo ? `Added ${result.watchedRepo} to workspace memory and watchlist` : 'Accepted into workspace memory')
        : 'Dismissed from the review queue');
      await load();
    } catch (err) {
      card.classList.remove('is-busy');
      toast(`Could not review update: ${err.message}`);
    }
  }

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
        kind: String(data.get('kind') || 'project'),
        focusQuestion: String(data.get('focusQuestion') || '').trim(),
        keywords: String(data.get('keywords') || '').split(',').map((k) => k.trim()).filter(Boolean),
        repos,
      });
      await api.seedBrainSpace(result.space.id);
      form.reset();
      state.selectedTopicId = result.space.id;
      toast('Workspace created');
      await runWorkflow('capture', result.space.id, false);
    } catch (err) {
      toast(`Could not create topic: ${err.message}`);
    }
  });

  setupNotepad();
  renderIcons(root);

  let loaded = false;
  return {
    async openWorkspace(id) {
      state.selectedTopicId = id;
      await load();
    },
    onShow() {
      if (loaded) return;
      loaded = true;
      load();
    },
    onHide() { loadVersion += 1; detailVersion += 1; },
    onKey() {},
  };
}
