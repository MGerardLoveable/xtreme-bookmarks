// Thin API client — wraps /api/* endpoints, no dependencies.

async function req(path, opts = {}) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const msg = data?.error || data?.xError || data?.message || text || res.statusText;
    const err = new Error(`${res.status} ${res.statusText}: ${msg}`);
    err.payload = data;
    throw err;
  }
  return data;
}

export const api = {
  // Bookmarks
  listBookmarks(params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    }
    return req(`/api/bookmarks?${q.toString()}`);
  },
  getBookmark(id) { return req(`/api/bookmarks/${encodeURIComponent(id)}`); },
  saveNote(id, note) {
    return req(`/api/bookmarks/${encodeURIComponent(id)}/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
  },
  setCategory(id, category) {
    return req(`/api/bookmarks/${encodeURIComponent(id)}/category`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    });
  },
  setWiki(id, inWiki) {
    return req(`/api/bookmarks/${encodeURIComponent(id)}/wiki`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inWiki }),
    });
  },
  addCollection(id, collection) {
    return req(`/api/bookmarks/${encodeURIComponent(id)}/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection }),
    });
  },
  removeCollection(id, collection) {
    return req(`/api/bookmarks/${encodeURIComponent(id)}/collections/${encodeURIComponent(collection)}`, {
      method: 'DELETE',
    });
  },
  deleteBookmark(id, fromX = false) {
    return req(`/api/bookmarks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromX }),
    });
  },
  setRead(id, isRead) {
    return req(`/api/bookmarks/${encodeURIComponent(id)}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ read: isRead }),
    });
  },

  // Stats / filters
  stats() { return req('/api/stats'); },
  authors(q = '') { return req(`/api/authors?q=${encodeURIComponent(q)}`); },
  categories() { return req('/api/categories'); },
  domains() { return req('/api/domains'); },
  timeline() { return req('/api/timeline'); },
  collections() { return req('/api/collections'); },
  unreadCount() { return req('/api/unread-count'); },
  analytics() { return req('/api/analytics'); },
  duplicates() { return req('/api/duplicates'); },
  deadLinks() { return req('/api/dead-links'); },

  // Brain
  brainMemory() { return req('/api/brain/memory'); },
  brainGraphStats() { return req('/api/brain/graph'); },
  brainGraphData() { return req('/api/brain/graph/data'); },
  brainConsolidate() { return req('/api/brain/consolidate', { method: 'POST' }); },
  brainHealth() { return req('/api/brain/health', { method: 'POST' }); },
  brainDashboard() { return req('/api/brain/dashboard'); },
  brainEngine() { return req('/api/brain/engine'); },
  brainSpaces() { return req('/api/brain/spaces'); },
  createBrainSpace(payload) {
    return req('/api/brain/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  seedBrainSpace(id) {
    return req(`/api/brain/spaces/${encodeURIComponent(id)}/seed`, { method: 'POST' });
  },
  brainSpaceBookmarks(id) {
    return req(`/api/brain/spaces/${encodeURIComponent(id)}/bookmarks`);
  },
  brainSpaceRepos(id) {
    return req(`/api/brain/spaces/${encodeURIComponent(id)}/repos`);
  },
  addBrainRepo(id, repo) {
    return req(`/api/brain/spaces/${encodeURIComponent(id)}/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    });
  },
  runBrainAgents(target = 'all') {
    return req('/api/brain/run-agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
  },
  brainWorkflows() { return req('/api/brain/workflows'); },
  runBrainWorkflow(workflow, target = 'all') {
    return req('/api/brain/workflows/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow, target }),
    });
  },
  syncBrainMemory() {
    return req('/api/brain/sync-memory', { method: 'POST' });
  },
  createBrainNote(payload) {
    return req('/api/brain/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  brainAgentRuns(limit = 20) { return req(`/api/brain/agents/runs?limit=${encodeURIComponent(limit)}`); },
  brainAgentFindings(limit = 50, open = false) { return req(`/api/brain/agents/findings?limit=${encodeURIComponent(limit)}&open=${open ? 'true' : 'false'}`); },

  // X account monitor
  xWatchlist() { return req('/api/x/watchlist'); },
  addXWatchAccount(handle, backfill = true) {
    return req('/api/x/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, backfill }),
    });
  },
  removeXWatchAccount(handle) {
    return req(`/api/x/watchlist/${encodeURIComponent(handle)}`, { method: 'DELETE' });
  },
  updateXWatchAccount(handle, payload) {
    return req(`/api/x/watchlist/${encodeURIComponent(handle)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  backfillXWatchAccount(handle) {
    return req(`/api/x/watchlist/${encodeURIComponent(handle)}/backfill`, { method: 'POST' });
  },
  backfillAllXWatchAccounts(options = {}) {
    const q = new URLSearchParams();
    if (options.fast) q.set('fast', 'true');
    if (options.async) q.set('async', 'true');
    const suffix = q.toString() ? `?${q.toString()}` : '';
    return req(`/api/x/watchlist/backfill${suffix}`, { method: 'POST' });
  },
  xFeed(limit = 50, type = 'all', account = '') {
    const q = new URLSearchParams({ limit: String(limit), type: String(type) });
    if (account) q.set('account', account);
    return req(`/api/x/feed?${q.toString()}`);
  },
  saveXFeedItemToBookmarks(tweetId) {
    return req(`/api/x/feed/${encodeURIComponent(tweetId)}/bookmark`, { method: 'POST' });
  },
  removeXFeedItem(tweetId) {
    return req(`/api/x/feed/${encodeURIComponent(tweetId)}`, { method: 'DELETE' });
  },
  clearXFeed(account = '') {
    const q = new URLSearchParams();
    if (account) q.set('account', account);
    const suffix = q.toString() ? `?${q.toString()}` : '';
    return req(`/api/x/feed${suffix}`, { method: 'DELETE' });
  },
  xStreamStatus() { return req('/api/x/stream/status'); },
  startXStream() { return req('/api/x/stream/start', { method: 'POST' }); },
  stopXStream() { return req('/api/x/stream/stop', { method: 'POST' }); },
  syncXStreamRule() { return req('/api/x/stream/rules/sync', { method: 'POST' }); },

  // SSE: /api/grab and /api/wiki return text/event-stream via POST
  startAuth() { return req('/api/auth/start', { method: 'POST' }); },
  grabStream(onEvent) {
    return streamPost('/api/grab', onEvent);
  },
  wikiStream(onEvent) {
    return streamPost('/api/wiki', onEvent);
  },
  askStream(question, save, onEvent) {
    return streamPost('/api/ask', onEvent, JSON.stringify({ question, save }));
  },

  // Wiki pages
  listPages() { return req('/api/pages'); },
  getPage(pagePath) { return req(`/api/pages/${encodeURI(pagePath)}`); },
};

async function streamPost(path, onEvent, body) {
  const opts = { method: 'POST' };
  if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = body; }
  const res = await fetch(path, opts);
  if (!res.ok || !res.body) throw new Error(`Stream failed: ${res.status}`);
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
      const lines = part.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      try { onEvent(event, JSON.parse(data)); } catch { onEvent(event, data); }
    }
  }
}

// Formatting helpers
export function fmtNumber(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('en-US');
}

export function fmtRelativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day}d`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Ideas / Notepad API ────────────────────────────────────────────────────
export const ideas = {
  async list() {
    return req('/api/ideas');
  },
  async create(idea) {
    return req('/api/ideas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(idea),
    });
  },
  async update(id, updates) {
    return req(`/api/ideas/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },
  async remove(id) {
    return req(`/api/ideas/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async promote(id) {
    return req(`/api/ideas/${encodeURIComponent(id)}/promote`, { method: 'POST' });
  },
};
