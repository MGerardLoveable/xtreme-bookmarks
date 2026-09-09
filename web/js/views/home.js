import { api, fmtNumber, fmtRelativeTime } from '../api.js';
import { renderIcons } from '../icons.js';
import { escape, toast } from '../util.js';

function navigate(view, extra = {}) {
  document.dispatchEvent(new CustomEvent('xb:navigate', {
    detail: { view, ...extra },
  }));
}

function authorAvatar(bookmark) {
  const label = bookmark.authorName || bookmark.authorHandle || 'Saved source';
  if (bookmark.authorProfileImageUrl) {
    return `<img class="home-source-avatar" src="${escape(bookmark.authorProfileImageUrl)}" alt="" loading="lazy">`;
  }
  return `<span class="home-source-avatar home-source-avatar-fallback" aria-hidden="true">${escape(label.slice(0, 1).toUpperCase())}</span>`;
}

function recallCard(item, workspaces) {
  const bookmark = item.bookmark || {};
  const activation = bookmark.activation || {};
  const profile = activation.profile || {};
  const enrichment = activation.enrichment || {};
  const author = bookmark.authorName || (bookmark.authorHandle ? `@${bookmark.authorHandle}` : 'Saved source');
  const handle = bookmark.authorHandle ? `@${bookmark.authorHandle}` : '';
  const age = fmtRelativeTime(bookmark.bookmarkedAt || bookmark.postedAt);
  const why = profile.whySaved || enrichment.whyItMatters || item.reasonDetail;
  const summary = enrichment.summary || bookmark.text || 'Open the source to review it.';
  const chips = (item.supportingReasons || []).slice(0, 3);
  const existingProjects = new Set((activation.projects || []).map((project) => project.id));
  const choices = (workspaces || []).filter((workspace) => !existingProjects.has(workspace.id));

  return `
    <article class="home-recall-item" data-recall-id="${escape(item.queueId)}" data-bookmark-id="${escape(item.bookmarkId)}">
      <div class="home-recall-rule" aria-hidden="true"></div>
      <div class="home-recall-body">
        <div class="home-recall-topline">
          <span class="home-reason"><span data-icon="sparkles"></span>${escape(item.reasonLabel)}</span>
          <button class="icon-btn home-dismiss" data-recall-action="dismiss" title="Show fewer items like this" aria-label="Show fewer items like this">
            <span data-icon="x"></span>
          </button>
        </div>

        <div class="home-source-line">
          ${authorAvatar(bookmark)}
          <span class="home-source-person">
            <strong>${escape(author)}</strong>
            ${handle && author !== handle ? `<small>${escape(handle)}</small>` : ''}
          </span>
          ${age ? `<span class="home-source-age">${escape(age)} ago</span>` : ''}
        </div>

        <p class="home-recall-text">${escape(summary)}</p>
        <div class="home-recall-why">
          <span>Why it is here</span>
          <p>${escape(why)}</p>
        </div>

        ${chips.length ? `<div class="home-recall-signals">${chips.map((chip) => `<span>${escape(chip)}</span>`).join('')}</div>` : ''}

        <div class="home-recall-actions">
          <button class="btn btn-sm btn-primary" data-open-source="${escape(item.bookmarkId)}">
            <span data-icon="external-link"></span>Open source
          </button>
          <button class="btn btn-sm" data-ask-source="${escape(item.bookmarkId)}">
            <span data-icon="sparkles"></span>Ask about it
          </button>
          <button class="btn btn-sm" data-recall-action="done">
            <span data-icon="check"></span>Mark used
          </button>
          <button class="btn btn-sm btn-ghost" data-recall-action="snooze">
            <span data-icon="clock-3"></span>Later
          </button>
        </div>

        ${workspaces?.length ? `
          <div class="home-file-row">
            <label for="home-workspace-${escape(item.queueId)}">File into workspace</label>
            <select id="home-workspace-${escape(item.queueId)}" class="input" data-workspace-select>
              <option value="">Choose workspace...</option>
              ${choices.map((workspace) => `<option value="${escape(workspace.id)}">${escape(workspace.name)}</option>`).join('')}
            </select>
            <button class="icon-btn" data-file-source title="Add to workspace" aria-label="Add to workspace"><span data-icon="plus"></span></button>
          </div>
        ` : ''}
      </div>
    </article>
  `;
}

function practiceCard(item, index, total) {
  if (!item) return '';
  return `
    <article class="home-practice-card" data-practice-id="${escape(item.queueId)}" data-recall-id="${escape(item.queueId)}">
      <div class="home-practice-progress" aria-label="Recall session progress">
        <div><strong>${index + 1}</strong><span>of ${total}</span></div>
        <div class="home-practice-track"><span style="width:${Math.round(((index + 1) / total) * 100)}%"></span></div>
      </div>
      <div class="home-practice-prompt">
        <span class="home-reason"><span data-icon="brain-circuit"></span>Retrieval practice</span>
        <h3>${escape(item.cue)}</h3>
        <p>Explain it in your own words first. This stays on your computer and helps you notice what you actually remember.</p>
        <label class="home-practice-response">
          <span>What I remember</span>
          <textarea class="input" data-practice-response rows="4" placeholder="Type the idea, evidence, and why it matters..."></textarea>
        </label>
        <button class="btn btn-primary" type="button" data-practice-reveal><span data-icon="eye"></span>Compare with source</button>
      </div>
      <div class="home-practice-answer" data-practice-answer hidden>
        <div class="home-practice-answer-label">Source-backed answer</div>
        <p>${escape(item.answer)}</p>
        ${item.whyItMatters ? `<div class="home-practice-why"><strong>Why it matters</strong><span>${escape(item.whyItMatters)}</span></div>` : ''}
        <div class="home-practice-source">From ${escape(item.author)}</div>
        <div class="home-practice-rating-label">How well did you recall it?</div>
        <div class="home-practice-actions">
          <button class="btn" type="button" data-recall-action="again"><span data-icon="rotate-ccw"></span>Again<span>tomorrow</span></button>
          <button class="btn" type="button" data-recall-action="hard"><span data-icon="brain"></span>Almost<span>in 4 days</span></button>
          <button class="btn btn-primary" type="button" data-recall-action="remembered"><span data-icon="check"></span>Got it<span>interval grows</span></button>
          <button class="btn btn-ghost" type="button" data-open-source="${escape(item.bookmarkId)}"><span data-icon="external-link"></span>Open source</button>
        </div>
      </div>
    </article>
  `;
}

function practiceComplete(results) {
  const remembered = results.filter((result) => result === 'remembered').length;
  const hard = results.filter((result) => result === 'hard').length;
  const again = results.filter((result) => result === 'again').length;
  return `
    <article class="home-practice-complete">
      <span class="home-practice-complete-icon" data-icon="check-circle-2"></span>
      <div>
        <span class="home-practice-answer-label">Session complete</span>
        <h3>You brought ${results.length} idea${results.length === 1 ? '' : 's'} back into reach.</h3>
        <p>${remembered} solid · ${hard} almost there · ${again} scheduled for tomorrow</p>
      </div>
      <button class="btn" type="button" data-practice-more><span data-icon="refresh-cw"></span>Practice more</button>
    </article>
  `;
}

function workspaceRow(workspace) {
  const freshness = workspace.lastAgentRunAt
    ? `updated ${fmtRelativeTime(workspace.lastAgentRunAt)} ago`
    : 'ready for its first update';
  return `
    <button class="home-workspace-row" data-open-workspaces="${escape(workspace.id)}">
      <span class="home-workspace-mark" data-kind="${escape(workspace.kind || 'project')}">${escape((workspace.name || 'W').slice(0, 1).toUpperCase())}</span>
      <span class="home-workspace-copy">
        <strong>${escape(workspace.name)}</strong>
        <small>${escape(workspace.focusQuestion || workspace.description || freshness)}</small>
        ${workspace.understanding?.nextStep ? `<small><b>${workspace.understanding.outcome ? 'Result' : 'Next experiment'}:</b> ${escape(workspace.understanding.outcome || workspace.understanding.nextStep)}</small>` : ''}
      </span>
      <span class="home-workspace-counts">
        <strong>${fmtNumber(workspace.bookmarkCount)}</strong>
        <small>sources</small>
      </span>
      <span data-icon="chevron-right" aria-hidden="true"></span>
    </button>
  `;
}

function attentionRow(item) {
  return `
    <article class="home-attention-row" data-tone="${escape(item.tone || 'neutral')}">
      <span class="home-attention-icon" data-icon="${escape(item.icon || 'info')}"></span>
      <div>
        <strong>${escape(item.title)}</strong>
        <p>${escape(item.detail)}</p>
        ${item.action ? `<button class="home-text-action" data-attention-id="${escape(item.id)}">${escape(item.action.label)}<span data-icon="arrow-right"></span></button>` : ''}
      </div>
    </article>
  `;
}

function progressRow(item) {
  const icons = {
    asked: 'sparkles',
    copied: 'copy',
    highlighted: 'edit-3',
    knowledge_update: 'brain-circuit',
    made: 'file-text',
    note_updated: 'file-text',
    profile_updated: 'bookmark',
    project_added: 'folder-plus',
    read: 'book-open',
    recall_again: 'rotate-ccw',
    reviewed: 'check',
    sync: 'refresh-cw',
    today_done: 'check',
  };
  const age = item.occurredAt ? fmtRelativeTime(item.occurredAt) : '';
  return `
    <article class="home-progress-row">
      <span class="home-progress-icon" data-icon="${escape(icons[item.type] || 'activity')}"></span>
      <div>
        <strong>${escape(item.title)}</strong>
        <p>${escape(item.detail || '')}</p>
      </div>
      ${age ? `<time datetime="${escape(item.occurredAt)}">${escape(age)} ago</time>` : ''}
    </article>
  `;
}

export function HomeView(root) {
  const state = {
    data: null,
    loading: false,
    loadVersion: 0,
    practiceIndex: 0,
    practiceResults: [],
  };

  root.innerHTML = `
    <div class="home-view">
      <header class="home-header">
        <div>
          <div class="home-kicker">Second brain</div>
          <h1>What deserves your attention?</h1>
          <p>Recall useful sources, continue active work, and turn what you saved into something you can use.</p>
        </div>
        <div class="home-health" id="home-health" aria-live="polite"></div>
      </header>
      <div class="home-import-status">
        <span id="home-import-message" role="status">Your latest saves are in the Library.</span>
        <button class="btn btn-sm" type="button" data-latest-saves><span data-icon="bookmark"></span>Latest saves</button>
      </div>

      <section class="home-ask-band" aria-labelledby="home-ask-title">
        <div>
          <span class="home-section-index">01</span>
          <div>
            <h2 id="home-ask-title">Ask your archive</h2>
            <p>Get an answer with exact saved sources, gaps, and next steps.</p>
          </div>
        </div>
        <form id="home-ask-form" class="home-ask-form">
          <span data-icon="sparkles" aria-hidden="true"></span>
          <input id="home-ask-input" type="text" placeholder="What do I know about..." autocomplete="off">
          <button class="btn btn-primary" type="submit">Ask<span data-icon="arrow-right"></span></button>
        </form>
        <div class="home-prompt-row" id="home-prompts"></div>
      </section>

      <div class="home-layout">
        <main class="home-primary">
          <section class="home-section" aria-labelledby="home-practice-title" id="home-practice-section" hidden>
            <header class="home-section-header">
              <div>
                <span class="home-section-index">02</span>
                <div>
                  <h2 id="home-practice-title">Recall session</h2>
                  <p>Five focused minutes to turn saved information into knowledge you can call back without searching.</p>
                </div>
              </div>
            </header>
            <div id="home-practice"></div>
          </section>

          <section class="home-section" aria-labelledby="home-recall-title">
            <header class="home-section-header">
              <div>
                <span class="home-section-index">03</span>
                <div>
                  <h2 id="home-recall-title">Worth bringing back</h2>
                  <p>A short, explainable queue from your archive. Use it, file it, or teach Xtreme what is not useful.</p>
                </div>
              </div>
              <button class="icon-btn" id="home-refresh" title="Refresh Home" aria-label="Refresh Home"><span data-icon="refresh-cw"></span></button>
            </header>
            <div class="home-recall-list" id="home-recall-list">
              <div class="home-loading"><span class="spinner"></span>Finding useful threads...</div>
            </div>
          </section>
        </main>

        <aside class="home-secondary">
          <section class="home-section home-side-section" aria-labelledby="home-workspaces-title">
            <header class="home-section-header compact">
              <div>
                <span class="home-section-index">04</span>
                <div><h2 id="home-workspaces-title">Continue working</h2><p>Your durable research contexts.</p></div>
              </div>
              <button class="icon-btn" data-open-workspaces title="Open Workspaces" aria-label="Open Workspaces"><span data-icon="arrow-up-right"></span></button>
            </header>
            <div id="home-workspaces" class="home-workspace-list"></div>
          </section>

          <section class="home-section home-side-section" aria-labelledby="home-attention-title">
            <header class="home-section-header compact">
              <div>
                <span class="home-section-index">05</span>
                <div><h2 id="home-attention-title">Needs attention</h2><p>Gaps, stale knowledge, and open updates.</p></div>
              </div>
            </header>
            <div id="home-attention" class="home-attention-list"></div>
          </section>

          <section class="home-section home-side-section" aria-labelledby="home-progress-title">
            <header class="home-section-header compact">
              <div>
                <span class="home-section-index">06</span>
                <div><h2 id="home-progress-title">Recent progress</h2><p>What changed in your second brain.</p></div>
              </div>
            </header>
            <div id="home-progress" class="home-progress-list"></div>
          </section>
        </aside>
      </div>
    </div>
  `;

  function render() {
    const data = state.data;
    if (!data) return;
    const status = data.status || {};
    const syncAge = status.lastSyncAt ? fmtRelativeTime(status.lastSyncAt) : '';
    const knowledgePct = status.total > 0 ? Math.round((Number(status.enriched || 0) / Number(status.total)) * 100) : 0;
    root.querySelector('#home-health').innerHTML = `
      <div><span data-icon="database"></span><strong>${fmtNumber(status.total)}</strong><small>saved sources</small></div>
      <div><span data-icon="sparkles"></span><strong>${knowledgePct}%</strong><small>compiled</small></div>
      <div><span data-icon="refresh-cw"></span><strong>${syncAge || 'not yet'}</strong><small>${syncAge ? 'since sync' : 'sync status'}</small></div>
    `;

    root.querySelector('#home-prompts').innerHTML = (data.prompts || []).map((prompt) => `
      <button type="button" data-home-prompt="${escape(prompt.prompt)}">${escape(prompt.label)}</button>
    `).join('');

    const practiceSection = root.querySelector('#home-practice-section');
    const session = data.practiceSession || (data.practice ? [data.practice] : []);
    practiceSection.hidden = !session.length;
    root.querySelector('#home-practice').innerHTML = state.practiceIndex >= session.length
      ? practiceComplete(state.practiceResults)
      : practiceCard(session[state.practiceIndex], state.practiceIndex, session.length);

    const recallItems = (data.recall || []).filter((item) => !session.some(practice => practice.queueId === item.queueId));
    root.querySelector('#home-recall-list').innerHTML = recallItems.length
      ? recallItems.map((item) => recallCard(item, data.workspaces || [])).join('')
      : `<div class="home-empty"><span data-icon="check-circle-2"></span><strong>You are caught up.</strong><p>Xtreme will bring back another useful source as your archive and workspaces evolve.</p></div>`;

    root.querySelector('#home-workspaces').innerHTML = (data.workspaces || []).length
      ? data.workspaces.map(workspaceRow).join('')
      : `<button class="home-empty home-empty-action" data-open-workspaces><span data-icon="folder-plus"></span><strong>Create your first workspace</strong><p>Give saved research a project, question, person, or topic to support.</p></button>`;

    root.querySelector('#home-attention').innerHTML = (data.attention || []).length
      ? data.attention.map(attentionRow).join('')
      : `<div class="home-empty compact"><span data-icon="check-circle-2"></span><strong>Nothing urgent.</strong><p>Your knowledge and workspaces are in good shape.</p></div>`;

    root.querySelector('#home-progress').innerHTML = (data.recentProgress || []).length
      ? data.recentProgress.map(progressRow).join('')
      : `<div class="home-empty compact"><span data-icon="activity"></span><strong>No recent changes.</strong><p>Sync, review, or ask about a source to start the trail.</p></div>`;
    renderIcons(root);
  }

  async function load() {
    if (state.loading) return;
    const version = ++state.loadVersion;
    state.loading = true;
    root.querySelector('#home-refresh')?.classList.add('is-spinning');
    try {
      const data = await api.home();
      if (version !== state.loadVersion) return;
      state.data = data;
      state.practiceIndex = 0;
      state.practiceResults = [];
      render();
    } catch (error) {
      root.querySelector('#home-recall-list').innerHTML = `
        <div class="home-empty error"><span data-icon="triangle-alert"></span><strong>Home could not load.</strong><p>${escape(error.message)}</p><button class="btn" id="home-retry">Try again</button></div>`;
      root.querySelector('#home-retry')?.addEventListener('click', load);
      renderIcons(root.querySelector('#home-recall-list'));
    } finally {
      state.loading = false;
      root.querySelector('#home-refresh')?.classList.remove('is-spinning');
    }
  }

  function ask(prompt) {
    if (!prompt?.trim()) return;
    navigate('ask', { ask: { question: prompt.trim() } });
  }

  async function actOnRecall(card, action) {
    const queueId = Number(card.dataset.recallId);
    if (!Number.isFinite(queueId)) return;
    if (card.dataset.saving) return;
    card.dataset.saving = 'true';
    card.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      await api.homeRecallAction(queueId, action, null, card.querySelector('[data-practice-response]')?.value || '');
      toast(action === 'done' ? 'Marked as used' : action === 'snooze' ? 'Saved for later' : 'Feedback saved');
      if (card.dataset.practiceId) {
        state.practiceResults.push(action);
        state.practiceIndex += 1;
        render();
      } else await load();
    } catch (error) {
      delete card.dataset.saving;
      card.querySelectorAll('button').forEach(button => { button.disabled = false; });
      toast(`Could not update recall: ${error.message}`, 5000);
    }
  }

  root.querySelector('#home-ask-form').addEventListener('submit', (event) => {
    event.preventDefault();
    ask(root.querySelector('#home-ask-input').value);
  });
  root.querySelector('#home-refresh').addEventListener('click', load);

  root.addEventListener('click', async (event) => {
    if (event.target.closest('[data-latest-saves]')) {
      navigate('library', { latestSaved: true });
      return;
    }
    const promptButton = event.target.closest('[data-home-prompt]');
    if (event.target.closest('[data-practice-more]')) { await load(); return; }
    if (promptButton) { ask(promptButton.dataset.homePrompt); return; }

    const workspaceButton = event.target.closest('[data-open-workspaces]');
    if (workspaceButton) { navigate('topics', { workspaceId: workspaceButton.dataset.openWorkspaces }); return; }

    const revealButton = event.target.closest('[data-practice-reveal]');
    if (revealButton) {
      const practiceCard = revealButton.closest('[data-practice-id]');
      const answer = practiceCard?.querySelector('[data-practice-answer]');
      if (answer) {
        answer.hidden = false;
        revealButton.hidden = true;
        answer.querySelector('button')?.focus();
      }
      return;
    }

    const card = event.target.closest('[data-recall-id]');
    const actionButton = event.target.closest('[data-recall-action]');
    if (card && actionButton) {
      await actOnRecall(card, actionButton.dataset.recallAction);
      return;
    }

    const openButton = event.target.closest('[data-open-source]');
    if (card && openButton) {
      const item = (state.data?.recall || []).find((entry) => String(entry.bookmarkId) === openButton.dataset.openSource);
      const url = item?.bookmark?.url;
      if (url) {
        api.recordEvent(item.bookmarkId, 'opened_from_home').catch(() => {});
        window.open(url, '_blank', 'noopener');
      }
      return;
    }

    const askButton = event.target.closest('[data-ask-source]');
    if (card && askButton) {
      const item = (state.data?.recall || []).find((entry) => String(entry.bookmarkId) === askButton.dataset.askSource);
      if (item) {
        const author = item.bookmark?.authorHandle ? `@${item.bookmark.authorHandle}` : item.bookmark?.authorName || 'this source';
        ask(`Help me put this saved source from ${author} to work: "${item.bookmark?.text || ''}". Explain the key idea, connect it to related saved knowledge, identify gaps or risks, and recommend concrete next steps.`);
      }
      return;
    }

    const fileButton = event.target.closest('[data-file-source]');
    if (card && fileButton) {
      const select = card.querySelector('[data-workspace-select]');
      const workspaceId = select?.value;
      if (!workspaceId) { toast('Choose a workspace first'); select?.focus(); return; }
      try {
        fileButton.disabled = true;
        await api.addBookmarkProject(card.dataset.bookmarkId, workspaceId, 'evidence');
        toast('Added to workspace');
        await load();
      } catch (error) {
        toast(`Could not add source: ${error.message}`, 5000);
      } finally {
        fileButton.disabled = false;
      }
      return;
    }

    const attentionButton = event.target.closest('[data-attention-id]');
    if (attentionButton) {
      const item = (state.data?.attention || []).find((entry) => entry.id === attentionButton.dataset.attentionId);
      const action = item?.action;
      if (!action) return;
      if (action.type === 'ask') { ask(action.prompt); return; }
      if (action.type === 'navigate') { navigate(action.view || 'topics'); return; }
      if (action.type === 'brain-cycle') {
        attentionButton.disabled = true;
        attentionButton.textContent = 'Updating...';
        try {
          const result = await api.runBrainCycle(75);
          toast(result?.result?.summary || 'Knowledge updated', 4000);
          await load();
        } catch (error) {
          toast(`Knowledge update failed: ${error.message}`, 5000);
          render();
        }
      }
    }
  });

  function updateImportStatus(status) {
    if (!status || status.state === 'idle') return;
    root.querySelector('#home-import-message').textContent = status.message;
  }
  document.addEventListener('xb:grab-status', event => updateImportStatus(event.detail));
  updateImportStatus(window.__xbGrabStatus);
  renderIcons(root);
  return {
    onShow() { load(); },
    refresh() { load(); },
    onKey(event) {
      if (event.key === '/') {
        event.preventDefault();
        root.querySelector('#home-ask-input')?.focus();
      }
    },
  };
}
