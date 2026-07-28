// Ask view — streaming LLM Q&A over the knowledge base.
//
// Calls POST /api/ask (SSE). Progress events become a status line.
// The final `done` event contains { answer, pagesRead, savedAs?, wikiUpdates, engine }.

import { api } from '../api.js';
import { renderIcons } from '../icons.js';
import { $, $$, el, escape, debounce, toast, copy, linkify } from '../util.js';
import { openWiki } from '../wiki.js';

const SUGGESTIONS = [
  'What are the most interesting patterns in my bookmarks this month?',
  'Which authors should I follow more closely?',
  'Summarize everything I\'ve saved about AI agents.',
  'What are contradictions or tensions in my saved material?',
  'Which tools do I reference most often?',
];

const LS_HISTORY = 'xb.v2.ask.history';

function safeExternalUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); } catch { return []; }
}
function saveHistory(list) {
  try { localStorage.setItem(LS_HISTORY, JSON.stringify(list.slice(0, 20))); } catch {}
}

export function AskView(root) {
  root.innerHTML = `
    <div class="ask-view">
      <aside class="ask-sidebar">
        <div class="ask-sidebar-header">
          <button class="btn btn-primary btn-block" id="ask-new">
            <span data-icon="plus"></span>New question
          </button>
        </div>
        <div class="ask-sidebar-section">
          <div class="rail-title">Recent</div>
          <div class="rail-list" id="ask-history"><div class="placeholder" style="font-size:11px;padding:6px">No questions yet</div></div>
        </div>
        <div class="ask-sidebar-section">
          <div class="rail-title">Try asking</div>
          <div class="rail-list" id="ask-suggestions"></div>
        </div>
      </aside>

      <section class="ask-main">
        <header class="ask-header">
          <div class="brain-kicker">Ask</div>
          <h1 class="display">Ask your research.</h1>
          <p class="brain-subtitle">Trace an idea across saved sources, your notes, and active workspaces.</p>
        </header>

        <div class="ask-transcript" id="ask-transcript" aria-live="polite" aria-busy="false">
          <div class="empty-state">
            <span class="empty-icon" data-icon="message-circle"></span>
            <h3>No conversation yet</h3>
            <p>Type a question below, or pick a suggestion from the sidebar.</p>
          </div>
        </div>

        <div class="ask-composer">
          <div class="ask-composer-inner">
            <textarea class="ask-input" id="ask-input" rows="1" placeholder="Ask anything about your bookmarks…" autocomplete="off" spellcheck="true"></textarea>
            <div class="ask-composer-actions">
              <label class="ask-scope">
                <span data-icon="target"></span>
                <select id="ask-scope" aria-label="Answer scope">
                  <option value="all">All sources</option>
                </select>
              </label>
              <label class="ask-save">
                <input type="checkbox" id="ask-save"> <span>Save as concept page</span>
              </label>
              <button class="btn btn-primary" id="ask-send">
                <span data-icon="zap"></span>Ask
                <kbd style="margin-left:6px">Ctrl↵</kbd>
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  `;
  renderIcons(root);

  const els = {
    input: $('#ask-input', root),
    send: $('#ask-send', root),
    save: $('#ask-save', root),
    transcript: $('#ask-transcript', root),
    history: $('#ask-history', root),
    suggestions: $('#ask-suggestions', root),
    newBtn: $('#ask-new', root),
    scope: $('#ask-scope', root),
  };
  let askController = null;
  let pendingTopicId = null;
  let scopesPromise = null;

  async function loadScopes() {
    if (scopesPromise) return scopesPromise;
    scopesPromise = (async () => {
      try {
        const data = await api.brainSpaces();
        const spaces = (data.spaces || []).filter((space) => space.status !== 'archived');
        const desiredValue = pendingTopicId ? `topic:${pendingTopicId}` : els.scope.value;
        els.scope.innerHTML = `
          <option value="all">All sources</option>
          ${spaces.map((space) => `<option value="topic:${escape(space.id)}">${escape(space.name)} · ${escape(space.kind || 'project')}</option>`).join('')}
        `;
        if ([...els.scope.options].some((option) => option.value === desiredValue)) {
          els.scope.value = desiredValue;
          if (pendingTopicId && desiredValue === `topic:${pendingTopicId}`) pendingTopicId = null;
        }
      } catch {
        els.scope.innerHTML = '<option value="all">All sources</option>';
      }
    })().finally(() => { scopesPromise = null; });
    return scopesPromise;
  }

  // Auto-grow textarea
  function autoGrow() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(200, els.input.scrollHeight) + 'px';
  }
  els.input.addEventListener('input', autoGrow);

  // Suggestions
  els.suggestions.innerHTML = SUGGESTIONS.map((s) => `<button class="rail-item" data-s="${escape(s)}"><span>${escape(s)}</span></button>`).join('');
  $$('.rail-item', els.suggestions).forEach((btn) => btn.addEventListener('click', () => {
    els.input.value = btn.dataset.s;
    autoGrow();
    els.input.focus();
  }));

  // History
  let history = loadHistory();
  function renderHistory() {
    if (!history.length) {
      els.history.innerHTML = '<div class="placeholder" style="font-size:11px;padding:6px">No questions yet</div>';
      return;
    }
    els.history.innerHTML = history.map((h, i) => `
      <button class="rail-item ask-history-item" data-h="${i}" title="${escape(h.question)}">
        <strong>${escape(h.question.slice(0, 60))}</strong>
        <small>${h.answer ? escape(h.answer.replace(/\s+/g, ' ').slice(0, 72)) : 'Answer unavailable from an older session'}</small>
      </button>
    `).join('');
    $$('.rail-item', els.history).forEach((btn) => btn.addEventListener('click', () => {
      const item = history[Number(btn.dataset.h)];
      if (item) renderConversation([item]);
    }));
  }
  renderHistory();

  // Transcript state
  let conversation = []; // array of { question, answer, pagesRead, wikiUpdates, engine, status?, pending? }

  function renderConversation(convo) {
    conversation = convo;
    els.transcript.setAttribute('aria-busy', String(convo.some((turn) => turn.pending)));
    if (!convo.length) {
      els.transcript.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon" data-icon="message-circle"></span>
          <h3>No conversation yet</h3>
          <p>Type a question below, or pick a suggestion from the sidebar.</p>
        </div>
      `;
      renderIcons(els.transcript);
      return;
    }
    els.transcript.innerHTML = convo.map((turn, idx) => renderTurn(turn, idx)).join('');
    renderIcons(els.transcript);
    // Wire up per-turn actions
    $$('.ask-copy', els.transcript).forEach((btn) => btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      copy(convo[i].answer || '').then(() => toast('Copied answer'));
    }));
    $$('.ask-source', els.transcript).forEach((btn) => btn.addEventListener('click', () => {
      openWiki(btn.dataset.page);
    }));
    $$('[data-ask-evidence]', els.transcript).forEach((btn) => btn.addEventListener('click', () => {
      const item = convo.flatMap((turn) => turn.evidence || []).find((entry) => entry.itemId === btn.dataset.askEvidence);
      if (!item) return;
      document.dispatchEvent(new CustomEvent('xb:navigate', {
        detail: { view: 'library', filter: { q: String(item.excerpt || item.title || '').slice(0, 120) } },
      }));
    }));
    $$('.ask-make-action', els.transcript).forEach((btn) => btn.addEventListener('click', async () => {
      const turn = convo[Number(btn.dataset.i)];
      if (!turn) return;
      btn.disabled = true;
      const topicId = turn.scope?.startsWith('topic:') ? turn.scope.slice('topic:'.length) : null;
      try {
        const result = await api.makeArtifact({
          type: btn.dataset.type,
          query: turn.question,
          title: `${turn.question.slice(0, 72)} · ${btn.textContent.trim()}`,
          topicId,
          synthesis: turn.answer,
          limit: 16,
        });
        turn.madeArtifact = {
          id: result.savedArtifact?.id,
          title: result.title,
          markdown: result.markdown,
          type: result.type,
        };
        renderConversation(convo);
        toast(`${result.type.replace('_', ' ')} saved`);
      } catch (err) {
        btn.disabled = false;
        toast(`Make failed: ${err.message}`);
      }
    }));
    $$('.ask-made-copy', els.transcript).forEach((btn) => btn.addEventListener('click', () => {
      const turn = convo[Number(btn.dataset.i)];
      copy(turn?.madeArtifact?.markdown || '').then(() => toast('Artifact copied'));
    }));
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }

  function renderTurn(turn, idx) {
    const statusLine = turn.pending ? `
      <div class="ask-status"><div class="spinner"></div><span>${escape(turn.status || 'Thinking…')}</span></div>
    ` : '';

    const answerBlock = turn.answer ? `
      <div class="ask-answer">${linkify(turn.answer)}</div>
    ` : '';

    const sources = (turn.pagesRead && turn.pagesRead.length) ? `
      <div class="detail-section-title" style="margin-top:12px">Sources</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${turn.pagesRead.map((p) => `<button class="chip chip-removable ask-source" data-page="${escape(p)}" title="Open ${escape(p)}"><span data-icon="folder"></span>${escape(p)}</button>`).join('')}
      </div>
    ` : '';

    const evidence = (turn.evidence && turn.evidence.length) ? `
      <div class="ask-evidence">
        <div class="detail-section-title">Evidence</div>
        <div class="ask-evidence-list">
          ${turn.evidence.slice(0, 10).map((item, evidenceIndex) => {
            const safeUrl = safeExternalUrl(item.url);
            return `
            ${safeUrl ? `<a href="${escape(safeUrl)}" target="_blank" rel="noopener">` : `<button data-ask-evidence="${escape(item.itemId)}">`}
              <span>${escape(item.provenance?.sourceLabel || item.title || item.kind)}</span>
              <small>${escape(String(item.excerpt || '').slice(0, 170))}</small>
              <em>[${evidenceIndex + 1}] ${escape(item.kind)}</em>
            ${safeUrl ? '</a>' : '</button>'}
          `;
          }).join('')}
        </div>
      </div>
    ` : '';

    const updates = (turn.wikiUpdates && turn.wikiUpdates.length) ? `
      <div class="detail-section-title" style="margin-top:12px">Suggested wiki updates</div>
      <ul style="font-size:12px;color:var(--fg-2);padding-left:18px;display:grid;gap:4px">
        ${turn.wikiUpdates.map((u) => `<li>${escape(u)}</li>`).join('')}
      </ul>
    ` : '';

    const makeBar = turn.answer ? `
      <div class="ask-make">
        <span>Make</span>
        ${[
          ['brief', 'Brief'],
          ['checklist', 'Checklist'],
          ['decision', 'Decision'],
          ['experiment', 'Experiment'],
          ['context_pack', 'Context pack'],
          ['flashcards', 'Flashcards'],
        ].map(([type, label]) => `<button class="btn btn-sm btn-ghost ask-make-action" data-i="${idx}" data-type="${type}">${label}</button>`).join('')}
      </div>
    ` : '';

    const made = turn.madeArtifact ? `
      <div class="ask-made">
        <div class="ask-made-heading">
          <span><span data-icon="check-circle"></span>${escape(turn.madeArtifact.title)}</span>
          <button class="btn btn-sm btn-ghost ask-made-copy" data-i="${idx}"><span data-icon="copy"></span>Copy</button>
        </div>
        <pre>${escape(turn.madeArtifact.markdown)}</pre>
      </div>
    ` : '';

    const footer = turn.answer ? `
      <div class="ask-turn-footer">
        <span class="muted" style="font-size:11px">${turn.engine ? `via ${escape(turn.engine)}` : ''}${turn.savedAs ? ' · saved' : ''}</span>
        <button class="btn btn-sm btn-ghost ask-copy" data-i="${idx}">
          <span data-icon="copy"></span>Copy
        </button>
      </div>
    ` : '';

    return `
      <article class="ask-turn">
        <div class="ask-question">
          <div class="ask-question-avatar" aria-hidden="true" data-icon="user-round"></div>
          <div class="ask-question-text">${escape(turn.question)}</div>
        </div>
        <div class="ask-answer-wrap">
          <div class="ask-answer-avatar" aria-hidden="true" data-icon="sparkles"></div>
          <div style="flex:1;min-width:0">
            ${statusLine}
            ${answerBlock}
            ${sources}
            ${evidence}
            ${updates}
            ${makeBar}
            ${made}
            ${footer}
          </div>
        </div>
      </article>
    `;
  }

  // Streaming SSE fetch
  async function streamAsk(question, save, scope, turn) {
    askController?.abort();
    const controller = new AbortController();
    askController = controller;
    let completed = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 90_000);
    const topicId = scope?.startsWith('topic:') ? scope.slice('topic:'.length) : null;
    const priorTurns = conversation
      .filter((entry) => entry !== turn && entry.answer)
      .slice(-6)
      .flatMap((entry) => [
        { role: 'user', content: entry.question },
        { role: 'assistant', content: entry.answer },
      ]);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, save, scope, topicId, conversation: priorTurns }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          let event = 'message';
          let data = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = { message: data }; }
          if (event === 'status') {
            turn.status = parsed.message || '';
            renderConversation(conversation);
          } else if (event === 'done') {
            completed = true;
            turn.pending = false;
            turn.status = '';
            turn.answer = parsed.answer || '';
            turn.pagesRead = parsed.pagesRead || [];
            turn.wikiUpdates = parsed.wikiUpdates || [];
            turn.savedAs = parsed.savedAs;
            turn.engine = parsed.engine;
            turn.evidence = parsed.evidence || [];
            turn.savedArtifact = parsed.savedArtifact || null;
            renderConversation(conversation);
            return;
          } else if (event === 'error') {
            completed = true;
            turn.pending = false;
            turn.status = '';
            turn.answer = `⚠︎ ${parsed.message || 'Unknown error'}`;
            renderConversation(conversation);
            throw new Error(parsed.message || 'Ask failed');
          }
        }
      }
      if (!completed) throw new Error('Ask stopped before an answer was returned. Please try again.');
    } catch (err) {
      if (timedOut && err.name === 'AbortError') {
        throw new Error('Ask timed out before an answer was returned. Please try again.');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      if (askController === controller) askController = null;
    }
  }

  async function submit() {
    const question = els.input.value.trim();
    if (!question) return;
    const save = els.save.checked;
    const scope = els.scope.value;

    els.input.value = '';
    autoGrow();
    els.send.disabled = true;

    const turn = { question, scope, answer: '', pagesRead: [], wikiUpdates: [], pending: true, status: 'Thinking…' };
    conversation.push(turn);
    renderConversation(conversation);

    try {
      await streamAsk(question, save, scope, turn);
      history.unshift({ ...turn, pending: false, ts: Date.now() });
      saveHistory(history);
      renderHistory();
    } catch (err) {
      turn.pending = false;
      turn.status = '';
      if (err.name === 'AbortError') {
        renderConversation(conversation);
        return;
      }
      if (!turn.answer) turn.answer = `⚠︎ ${err.message || 'Ask failed'}`;
      renderConversation(conversation);
      toast(`Ask failed: ${err.message}`);
    } finally {
      els.send.disabled = false;
    }
  }

  els.send.addEventListener('click', submit);
  els.input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  els.newBtn.addEventListener('click', () => {
    askController?.abort();
    conversation = [];
    renderConversation(conversation);
    els.input.focus();
  });

  function prefill(payload = {}) {
    if (payload.question) {
      els.input.value = payload.question;
      autoGrow();
    }
    if (payload.topicId) {
      const option = [...els.scope.options].find((entry) => entry.value === `topic:${payload.topicId}`);
      if (option) els.scope.value = option.value;
      else pendingTopicId = payload.topicId;
    }
    setTimeout(() => {
      els.input.focus();
      els.input.setSelectionRange(els.input.value.length, els.input.value.length);
    }, 40);
  }

  return {
    onShow() { void loadScopes(); setTimeout(() => els.input.focus(), 40); },
    onHide() { askController?.abort(); },
    onKey() {},
    prefill,
  };
}
