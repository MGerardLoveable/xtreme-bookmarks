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
          <h1 class="display">Interrogate your archive.</h1>
          <p class="brain-subtitle">Answers are grounded in your wiki pages and raw bookmarks. Sources are cited inline.</p>
        </header>

        <div class="ask-transcript" id="ask-transcript">
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
  };

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
      <button class="rail-item" data-h="${i}" title="${escape(h.question)}">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape(h.question.slice(0, 60))}</span>
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

    const updates = (turn.wikiUpdates && turn.wikiUpdates.length) ? `
      <div class="detail-section-title" style="margin-top:12px">Suggested wiki updates</div>
      <ul style="font-size:12px;color:var(--fg-2);padding-left:18px;display:grid;gap:4px">
        ${turn.wikiUpdates.map((u) => `<li>${escape(u)}</li>`).join('')}
      </ul>
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
            ${updates}
            ${footer}
          </div>
        </div>
      </article>
    `;
  }

  // Streaming SSE fetch
  async function streamAsk(question, save, turn) {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, save }),
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
          turn.pending = false;
          turn.status = '';
          turn.answer = parsed.answer || '';
          turn.pagesRead = parsed.pagesRead || [];
          turn.wikiUpdates = parsed.wikiUpdates || [];
          turn.savedAs = parsed.savedAs;
          turn.engine = parsed.engine;
          renderConversation(conversation);
        } else if (event === 'error') {
          turn.pending = false;
          turn.status = '';
          turn.answer = `⚠︎ ${parsed.message || 'Unknown error'}`;
          renderConversation(conversation);
          throw new Error(parsed.message || 'Ask failed');
        }
      }
    }
  }

  async function submit() {
    const question = els.input.value.trim();
    if (!question) return;
    const save = els.save.checked;

    els.input.value = '';
    autoGrow();
    els.send.disabled = true;

    const turn = { question, answer: '', pagesRead: [], wikiUpdates: [], pending: true, status: 'Thinking…' };
    conversation.push(turn);
    renderConversation(conversation);

    try {
      await streamAsk(question, save, turn);
      // Push to history
      history.unshift({ question, ts: Date.now() });
      saveHistory(history);
      renderHistory();
    } catch (err) {
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
    conversation = [];
    renderConversation(conversation);
    els.input.focus();
  });

  return {
    onShow() { setTimeout(() => els.input.focus(), 40); },
    onHide() {},
    onKey() {},
  };
}
