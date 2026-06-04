// X Feed view — browser-session watchlist and saved posts/replies.

import { api, fmtDate, fmtNumber, fmtRelativeTime } from '../api.js';
import { $, debounce, escape, linkify, toast } from '../util.js';
import { renderIcons } from '../icons.js';

export function XFeedView(root) {
  let accounts = [];
  let items = [];
  let status = null;
  let filter = 'all';
  let selectedAccount = '';
  let timer = null;
  let suggestions = [];
  let activeSuggestion = 0;
  let actionError = '';
  let lastWarningToastAt = '';
  let lastDelayedToastKey = '';

  root.innerHTML = `
    <div class="xfeed">
      <aside class="xfeed-side">
        <div class="xfeed-brand">
          <div class="xfeed-mark"><span data-icon="bell"></span></div>
          <div>
            <h2>X Feed</h2>
            <p>Watch selected accounts for new posts and replies.</p>
          </div>
        </div>

        <form class="xfeed-add" id="xfeed-add">
          <label for="xfeed-handle">Add account</label>
          <div class="xfeed-add-row">
            <input class="input" id="xfeed-handle" placeholder="@account" autocomplete="off" spellcheck="false">
            <button class="btn btn-primary" type="submit"><span data-icon="plus"></span>Add</button>
          </div>
          <div class="xfeed-suggestions" id="xfeed-suggestions" hidden></div>
        </form>

        <div class="xfeed-actions">
          <button class="btn" id="xfeed-start"><span data-icon="zap"></span>Auto update</button>
          <button class="btn" id="xfeed-stop"><span data-icon="x"></span>Stop</button>
          <button class="btn" id="xfeed-backfill"><span data-icon="download-cloud"></span>Check now</button>
        </div>

        <section class="xfeed-panel">
          <div class="xfeed-panel-title">Watcher status</div>
          <div id="xfeed-status" class="xfeed-status"></div>
        </section>

        <section class="xfeed-panel">
          <div class="xfeed-panel-title">Watchlist</div>
          <div id="xfeed-watchlist" class="xfeed-watchlist"></div>
        </section>
      </aside>

      <main class="xfeed-main">
        <header class="xfeed-toolbar">
          <div>
            <h1>Account notifications</h1>
            <p>Saved with your browser session. Posts, replies, and reposts are included.</p>
          </div>
          <div class="xfeed-toolbar-actions">
            <button class="btn btn-primary" id="xfeed-fresh-update" type="button">
              <span data-icon="refresh-cw"></span>Fresh update
            </button>
            <button class="btn btn-danger-ghost" id="xfeed-clear-feed" type="button">
              <span data-icon="trash"></span>Clear feed
            </button>
            <div class="toolbar-segment" role="group" aria-label="Feed filter">
              <button class="segment-btn active" data-filter="all">All</button>
              <button class="segment-btn" data-filter="post">Posts</button>
              <button class="segment-btn" data-filter="reply">Replies</button>
            </div>
          </div>
        </header>
        <div class="xfeed-rule" id="xfeed-rule"></div>
        <div class="xfeed-account-filter" id="xfeed-account-filter" hidden></div>
        <div class="xfeed-list" id="xfeed-list"></div>
      </main>
    </div>
  `;

  renderIcons(root);

  function statusText() {
    if (status?.pollerInFlight) return 'Checking now';
    if (status?.pollDelayed && status?.pollCooldownUntil) return 'Paused by X';
    if (status?.pollWaiting || status?.pollDelayed) return 'Waiting to resume';
    if (status?.pollerRunning) return 'Auto updating';
    if (status.connecting) return 'Connecting';
    if (status.running) return 'Live';
    if (status.lastPollError || status.lastError) return 'Stopped with error';
    return 'Ready';
  }

  function retryLabel(iso) {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'soon';
    const minutes = Math.ceil(ms / 60000);
    return minutes <= 1 ? 'in 1 minute' : `in ${minutes} minutes`;
  }

  function renderStatus() {
    const el = $('#xfeed-status', root);
    const state = statusText();
    const tone = status?.running || status?.pollerRunning || status?.pollerInFlight ? 'good' : status?.lastPollError || status?.lastError ? 'bad' : 'quiet';
    const hasActiveQueue = Boolean(status?.pollerInFlight || status?.pollWaiting || status?.pollDelayed);
    const pollTotal = Number(status?.pollTotal || 0);
    const checked = Number(status?.pollChecked ?? status?.lastPollChecked ?? 0);
    const waiting = Number(status?.pollWaiting || 0);
    const delayed = Number(status?.pollDelayed || 0);
    const failed = Number(status?.pollFailed || status?.lastPollFailed || 0);
    const saved = Number(status?.pollSaved ?? status?.lastPollSaved ?? 0);
    const delayedPreview = (status?.pollDelayedAccounts || []).slice(0, 5).map((item) => `@${escape(item.handle)}`).join(', ');
    const delayedMore = delayed > 5 ? ` and ${delayed - 5} more` : '';
    const delayedNotice = delayed ? `${delayed} account(s) delayed by X rate limiting${delayedPreview ? `: ${delayedPreview}${delayedMore}` : ''}. They will retry ${escape(retryLabel(status?.pollCooldownUntil) || 'soon')}.` : '';
    const meta = hasActiveQueue ? [
      status?.pollRunStartedAt ? `Started ${escape(fmtRelativeTime(status.pollRunStartedAt) || fmtDate(status.pollRunStartedAt))}` : 'Current update',
      pollTotal ? `checked ${checked} of ${pollTotal}` : '',
      waiting ? `${waiting} waiting` : '',
      delayed ? `${delayed} delayed` : '',
      failed ? `${failed} missed` : '',
      saved ? `${saved} new this update` : '0 new this update',
      status?.pollCurrentHandle ? `checking @${escape(status.pollCurrentHandle)}` : '',
      status?.pollCooldownUntil ? `retry ${escape(retryLabel(status.pollCooldownUntil))}` : '',
    ].filter(Boolean).join(' · ') : [
      status?.lastPollAt ? `Last checked ${escape(fmtRelativeTime(status.lastPollAt) || fmtDate(status.lastPollAt))}` : status?.lastConnectedAt ? `Connected ${escape(fmtDate(status.lastConnectedAt))}` : 'Not checked yet',
      status?.nextPollAt ? `next ${escape(retryLabel(status.nextPollAt))}` : '',
      typeof status?.lastPollChecked === 'number' ? `checked ${status.lastPollChecked}` : '',
      typeof status?.lastPollSaved === 'number' ? `${status.lastPollSaved} new last check` : '',
      failed ? `${failed} missed` : '',
      status?.reconnects ? `${status.reconnects} reconnects` : '',
      status?.nextRetryAt ? `retry ${escape(retryLabel(status.nextRetryAt))}` : '',
    ].filter(Boolean).join(' · ');
    el.innerHTML = `
      <div class="xfeed-status-line">
        <span class="xfeed-dot ${tone}"></span>
        <strong>${escape(state)}</strong>
      </div>
      <div class="xfeed-status-meta">${meta}</div>
      ${delayedNotice ? `<div class="xfeed-warning"><span data-icon="clock"></span>${delayedNotice}</div>` : ''}
      ${status?.lastPollWarning ? `<div class="xfeed-warning"><span data-icon="alert-triangle"></span>${escape(status.lastPollWarning)}</div>` : ''}
      ${status?.lastPollError ? `<div class="xfeed-error">${escape(status.lastPollError)}</div>` : ''}
      ${status?.lastError ? `<div class="xfeed-error">${escape(status.lastError)}</div>` : ''}
      ${actionError && status?.sourceMode === 'api' ? `
        <div class="xfeed-token-alert">
          <strong>${escape(actionError)}</strong>
          <a href="/setup-x.html" target="_blank" rel="noreferrer">Open X API setup</a>
        </div>
      ` : ''}
    `;
    renderIcons(el);
  }

  function renderWatchlist() {
    const el = $('#xfeed-watchlist', root);
    if (!accounts.length) {
      el.innerHTML = `<div class="empty-state compact"><p>No accounts yet.</p></div>`;
      return;
    }
    el.innerHTML = accounts.map((account) => `
      <div class="xfeed-account ${selectedAccount === account.handle ? 'selected' : ''}" data-select-account="${escape(account.handle)}" title="Show only @${escape(account.handle)}">
        <button class="xfeed-account-main" type="button" data-select-account="${escape(account.handle)}" title="Show only @${escape(account.handle)}">
          <div class="xfeed-avatar">${account.profileImageUrl ? `<img src="${escape(account.profileImageUrl)}" alt="">` : escape(account.handle.slice(0, 1).toUpperCase())}</div>
          <div class="xfeed-account-copy">
            <strong>@${escape(account.handle)}</strong>
            <span>${escape(account.name || account.userId)}</span>
          </div>
        </button>
        <div class="xfeed-account-controls">
          <div class="xfeed-account-modes" role="group" aria-label="Collection mode for @${escape(account.handle)}">
            <button
              type="button"
              class="xfeed-mode-btn ${account.includeReplies ? '' : 'active'}"
              data-mode-handle="${escape(account.handle)}"
              data-include-replies="false"
              title="Collect only original posts from @${escape(account.handle)}"
            >Posts</button>
            <button
              type="button"
              class="xfeed-mode-btn ${account.includeReplies ? 'active' : ''}"
              data-mode-handle="${escape(account.handle)}"
              data-include-replies="true"
              title="Collect posts and replies from @${escape(account.handle)}"
            >Posts + Replies</button>
          </div>
          <button class="icon-btn xfeed-remove-account" data-remove="${escape(account.handle)}" title="Remove @${escape(account.handle)}" aria-label="Remove @${escape(account.handle)}">
            <span data-icon="trash"></span>
          </button>
        </div>
      </div>
    `).join('');
    renderIcons(el);
  }

  function watchedHandles() {
    return new Set(accounts.map((account) => account.handle.toLowerCase()));
  }

  function hideSuggestions() {
    const el = $('#xfeed-suggestions', root);
    suggestions = [];
    activeSuggestion = 0;
    el.hidden = true;
    el.innerHTML = '';
  }

  function selectSuggestion(handle) {
    const input = $('#xfeed-handle', root);
    input.value = `@${handle}`;
    hideSuggestions();
    input.focus();
  }

  function renderSuggestions() {
    const el = $('#xfeed-suggestions', root);
    if (!suggestions.length) {
      hideSuggestions();
      return;
    }
    el.hidden = false;
    el.innerHTML = suggestions.map((author, index) => `
      <button type="button" class="xfeed-suggestion ${index === activeSuggestion ? 'active' : ''}" data-suggest="${escape(author.handle)}">
        <div class="xfeed-suggestion-avatar">${escape(author.handle.slice(0, 1).toUpperCase())}</div>
        <div class="xfeed-suggestion-main">
          <strong>@${escape(author.handle)}</strong>
          <span>${escape(author.name || 'Bookmarked account')}</span>
        </div>
        <span class="xfeed-suggestion-count">${Number(author.count || 0).toLocaleString()}</span>
      </button>
    `).join('');
  }

  const loadSuggestions = debounce(async () => {
    const input = $('#xfeed-handle', root);
    const q = input.value.trim().replace(/^@+/, '');
    if (!q) {
      hideSuggestions();
      return;
    }
    try {
      const result = await api.authors(q);
      const watched = watchedHandles();
      suggestions = (result.authors || [])
        .filter((author) => author.handle && !watched.has(String(author.handle).toLowerCase()))
        .slice(0, 8);
      activeSuggestion = 0;
      renderSuggestions();
    } catch {
      hideSuggestions();
    }
  }, 160);

  function renderRule() {
    const el = $('#xfeed-rule', root);
    const rule = status?.activeRule;
    el.innerHTML = rule
      ? `<span data-icon="radar"></span><code>${escape(rule)}</code>`
      : `<span data-icon="radar"></span><span>Browser watcher checks saved accounts automatically while the app is open.</span>`;
    renderIcons(el);
  }

  function renderAccountFilter() {
    const el = $('#xfeed-account-filter', root);
    if (!selectedAccount) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const account = accounts.find((item) => item.handle === selectedAccount);
    el.hidden = false;
    el.innerHTML = `
      <span data-icon="user"></span>
      <strong>@${escape(selectedAccount)}</strong>
      <span>${escape(account?.name || 'Selected account')}</span>
      <div class="xfeed-account-filter-actions">
        <button class="btn btn-sm btn-danger-ghost" type="button" id="xfeed-clear-account-feed">
          <span data-icon="trash"></span>Remove @${escape(selectedAccount)} items
        </button>
        <button class="btn btn-sm" type="button" id="xfeed-clear-account">All accounts</button>
      </div>
    `;
    renderIcons(el);
  }

  function tweetUrl(item) {
    return `https://x.com/${encodeURIComponent(item.username)}/status/${encodeURIComponent(item.tweetId)}`;
  }

  function rawTweet(item) {
    const data = item.rawJson?.data;
    return Array.isArray(data) ? data.find((tweet) => String(tweet.id) === String(item.tweetId)) || data[0] : data || {};
  }

  function rawAuthor(item) {
    const tweet = rawTweet(item);
    return (item.rawJson?.includes?.users || []).find((user) => String(user.id) === String(tweet.author_id || item.authorId)) || {};
  }

  function metrics(item) {
    return rawTweet(item).public_metrics || {};
  }

  function itemKind(item) {
    const refs = rawTweet(item).referenced_tweets || [];
    if (refs.some((ref) => ref?.type === 'retweeted')) return 'repost';
    if (item.itemType === 'reply') return 'reply';
    return 'post';
  }

  function kindLabel(item) {
    return ({ repost: 'Repost', reply: 'Reply', post: 'Post' })[itemKind(item)] || 'Post';
  }

  function kindIcon(item) {
    return ({ repost: 'refresh-cw', reply: 'message-circle', post: 'check-circle-2' })[itemKind(item)] || 'check-circle-2';
  }

  function displayName(item) {
    return rawAuthor(item).name || item.username;
  }

  function avatar(item) {
    return rawAuthor(item).profile_image_url || '';
  }

  function avatarFallback(item) {
    return (displayName(item) || item.username || '?').trim().slice(0, 1).toUpperCase();
  }

  function isVerified(item) {
    return rawAuthor(item).verified === true;
  }

  function replyContext(item) {
    if (item.itemType !== 'reply') return '';
    const tweet = rawTweet(item);
    const replyTo = tweet.in_reply_to_user_id ? `Reply target ${escape(tweet.in_reply_to_user_id)}` : 'Part of a conversation';
    return `<div class="xfeed-reply-context"><span data-icon="message-circle"></span>${replyTo}</div>`;
  }

  function mediaItems(item) {
    const tweet = rawTweet(item);
    const keys = mediaKeysForTweet(item, tweet);
    if (!keys.length) return [];
    const media = item.rawJson?.includes?.media || [];
    return media
      .filter((entry) => keys.includes(String(entry.media_key)))
      .map((entry) => ({
        type: entry.type || 'photo',
        url: entry.url || entry.preview_image_url || '',
        preview: entry.preview_image_url || entry.url || '',
        alt: entry.alt_text || 'Post media',
      }))
      .filter((entry) => entry.url || entry.preview)
      .slice(0, 4);
  }

  function mediaKeysForTweet(item, tweet) {
    const direct = Array.isArray(tweet.attachments?.media_keys) ? tweet.attachments.media_keys.map(String) : [];
    if (direct.length) return direct;
    const retweetedId = (tweet.referenced_tweets || []).find((ref) => ref?.type === 'retweeted')?.id;
    if (!retweetedId) return [];
    const data = item.rawJson?.data;
    const tweets = Array.isArray(data) ? data : data ? [data] : [];
    const original = tweets.find((candidate) => String(candidate?.id) === String(retweetedId));
    return Array.isArray(original?.attachments?.media_keys) ? original.attachments.media_keys.map(String) : [];
  }

  function renderMedia(item) {
    const media = mediaItems(item);
    if (!media.length) return '';
    return `
      <div class="xfeed-media-grid count-${media.length}">
        ${media.map((entry) => `
          <a class="xfeed-media" href="${tweetUrl(item)}" target="_blank" rel="noreferrer">
            <img src="${escape(entry.url || entry.preview)}" alt="${escape(entry.alt)}" loading="lazy">
            ${entry.type !== 'photo' ? `<span class="xfeed-media-badge">${escape(entry.type)}</span>` : ''}
          </a>
        `).join('')}
      </div>
    `;
  }

  function renderFeed() {
    const el = $('#xfeed-list', root);
    if (!items.length) {
      el.innerHTML = `
        <div class="empty-state">
          <h3>No saved items yet</h3>
          <p>Add an account, then use Check now or Auto update to collect matching posts and replies.</p>
        </div>
      `;
      return;
    }
    el.innerHTML = items.map((item) => `
      <article class="xfeed-item ${item.itemType} ${itemKind(item)}">
        <div class="xfeed-tweet-avatar">
          ${avatar(item)
            ? `<img src="${escape(avatar(item))}" alt="">`
            : `<span>${escape(avatarFallback(item))}</span>`}
        </div>
        <div class="xfeed-tweet-body">
          <header class="xfeed-tweet-head">
            <div class="xfeed-author-stack">
              <div class="xfeed-tweet-author">
                <strong>${escape(displayName(item))}</strong>
                ${isVerified(item) ? '<span class="xfeed-verified" title="Verified">✓</span>' : ''}
                <span>@${escape(item.username)}</span>
              </div>
              <div class="xfeed-tweet-meta">
                <span class="xfeed-kind-pill ${itemKind(item)}"><span data-icon="${kindIcon(item)}"></span>${kindLabel(item)}</span>
                <time title="${escape(fmtDate(item.createdAt))}">${escape(fmtRelativeTime(item.createdAt) || fmtDate(item.createdAt))}</time>
                ${item.sourceAccount ? `<span>Watch: @${escape(item.sourceAccount)}</span>` : ''}
              </div>
            </div>
            <a class="icon-btn" href="${tweetUrl(item)}" target="_blank" rel="noreferrer" title="Open on X" aria-label="Open on X">
              <span data-icon="external-link"></span>
            </a>
          </header>
          ${replyContext(item)}
          <div class="xfeed-tweet-text">${linkify(item.text || '')}</div>
          ${renderMedia(item)}
          <footer class="xfeed-tweet-metrics">
            <span title="Replies"><span data-icon="message-circle"></span>${fmtNumber(metrics(item).reply_count || 0)}</span>
            <span title="Reposts"><span data-icon="refresh-cw"></span>${fmtNumber(metrics(item).retweet_count || 0)}</span>
            <span title="Likes"><span data-icon="heart"></span>${fmtNumber(metrics(item).like_count || 0)}</span>
            <span title="Views"><span data-icon="bar-chart-3"></span>${fmtNumber(metrics(item).impression_count || 0)}</span>
          </footer>
          <div class="xfeed-card-footer">
            <div class="xfeed-tweet-source">
              <span>${kindLabel(item)}</span>
              ${item.conversationId ? `<span>Conversation ${escape(item.conversationId)}</span>` : ''}
            </div>
            <div class="xfeed-tweet-actions">
              <button class="btn btn-sm xfeed-save-btn" type="button" data-save-bookmark="${escape(item.tweetId)}">
                <span data-icon="bookmark"></span>Save to Library
              </button>
              <button class="btn btn-sm btn-danger-ghost xfeed-remove-btn" type="button" data-remove-feed-item="${escape(item.tweetId)}" title="Remove from this feed">
                <span data-icon="trash"></span>Remove
              </button>
            </div>
          </div>
        </div>
      </article>
    `).join('');
    renderIcons(el);
  }

  function syncFilterButtons() {
    root.querySelectorAll('[data-filter]').forEach((el) => el.classList.toggle('active', el.dataset.filter === filter));
  }

  async function refresh() {
    const feedLimit = selectedAccount ? 200 : 80;
    const [watchlist, streamStatus, feed] = await Promise.all([
      api.xWatchlist(),
      api.xStreamStatus(),
      api.xFeed(feedLimit, filter, selectedAccount),
    ]);
    accounts = watchlist.accounts || [];
    if (selectedAccount && !accounts.some((account) => account.handle === selectedAccount)) selectedAccount = '';
    status = streamStatus;
    items = feed.items || [];
    renderStatus();
    if (status?.lastPollWarning && status?.lastPollAt && status.lastPollAt !== lastWarningToastAt) {
      lastWarningToastAt = status.lastPollAt;
      toast(status.lastPollWarning, 9000);
    }
    const delayedToastKey = status?.pollDelayed ? `${status.pollRunId || ''}:${status.pollDelayed}:${status.pollCooldownUntil || ''}` : '';
    if (delayedToastKey && delayedToastKey !== lastDelayedToastKey) {
      lastDelayedToastKey = delayedToastKey;
      toast(`${status.pollDelayed} X account(s) delayed by rate limiting. They will retry ${retryLabel(status.pollCooldownUntil) || 'soon'}.`, 7000);
    }
    renderWatchlist();
    renderRule();
    renderAccountFilter();
    renderFeed();
  }

  async function withBusy(button, label, fn, options = {}) {
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = label;
    try {
      actionError = '';
      await fn();
      if (options.refresh !== false) await refresh();
    } catch (err) {
      actionError = err.payload?.userMessage || err.message || 'X Feed action failed';
      if (typeof options.onError === 'function') options.onError(err);
      renderStatus();
      toast(actionError, 4200);
    } finally {
      button.disabled = false;
      button.innerHTML = original;
      renderIcons(button);
    }
  }

  $('#xfeed-add', root).addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#xfeed-handle', root);
    const handle = input.value.trim();
    if (!handle) return;
    await withBusy(event.submitter, 'Adding...', async () => {
      await api.addXWatchAccount(handle, true);
      input.value = '';
      hideSuggestions();
      toast(`Watching ${handle}`);
    });
  });

  $('#xfeed-handle', root).addEventListener('input', loadSuggestions);
  $('#xfeed-handle', root).addEventListener('focus', loadSuggestions);
  $('#xfeed-handle', root).addEventListener('blur', () => setTimeout(hideSuggestions, 140));
  $('#xfeed-handle', root).addEventListener('keydown', (event) => {
    if (!suggestions.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeSuggestion = Math.min(activeSuggestion + 1, suggestions.length - 1);
      renderSuggestions();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeSuggestion = Math.max(activeSuggestion - 1, 0);
      renderSuggestions();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      selectSuggestion(suggestions[activeSuggestion].handle);
    } else if (event.key === 'Escape') {
      hideSuggestions();
    }
  });

  $('#xfeed-suggestions', root).addEventListener('mousedown', (event) => {
    const button = event.target.closest('[data-suggest]');
    if (!button) return;
    event.preventDefault();
    selectSuggestion(button.dataset.suggest);
  });

  $('#xfeed-start', root).addEventListener('click', (event) => withBusy(event.currentTarget, 'Starting...', () => api.startXStream()));
  $('#xfeed-stop', root).addEventListener('click', (event) => withBusy(event.currentTarget, 'Stopping...', () => api.stopXStream()));
  $('#xfeed-backfill', root).addEventListener('click', (event) => withBusy(event.currentTarget, 'Checking...', async () => {
    const result = await api.backfillAllXWatchAccounts({ fast: true, async: true });
    toast(result.alreadyRunning ? 'X Feed is already checking. New items will appear as it finishes.' : 'X Feed check started. New items will appear as accounts finish.');
  }));
  $('#xfeed-fresh-update', root).addEventListener('click', (event) => withBusy(event.currentTarget, 'Checking...', async () => {
    const result = await api.backfillAllXWatchAccounts({ fast: true, async: true });
    toast(result.alreadyRunning ? 'Fresh update is already running. The feed will keep refreshing.' : 'Fresh update started. The feed will refresh while it checks your watchlist.');
  }));
  $('#xfeed-clear-feed', root).addEventListener('click', (event) => withBusy(event.currentTarget, 'Clearing...', async () => {
    const label = selectedAccount ? `@${selectedAccount}` : 'the whole X Feed';
    if (!confirm(`Remove all saved items from ${label}? Fresh updates will keep them removed.`)) return;
    const result = await api.clearXFeed(selectedAccount);
    toast(selectedAccount ? `Removed ${result.removed || 0} items from @${selectedAccount}` : `Removed ${result.removed || 0} X Feed items`);
  }));

  $('#xfeed-watchlist', root).addEventListener('click', async (event) => {
    const modeButton = event.target.closest('[data-mode-handle]');
    if (modeButton) {
      event.preventDefault();
      event.stopPropagation();
      const handle = modeButton.dataset.modeHandle;
      const includeReplies = modeButton.dataset.includeReplies === 'true';
      const previousAccounts = accounts.map((account) => ({ ...account }));
      accounts = accounts.map((account) => (
        account.handle === handle ? { ...account, includeReplies } : account
      ));
      renderWatchlist();
      await withBusy(modeButton, '', async () => {
        const result = await api.updateXWatchAccount(handle, { includeReplies });
        if (result?.account) {
          accounts = accounts.map((account) => (
            account.handle === handle ? { ...account, ...result.account } : account
          ));
        }
        renderWatchlist();
        toast(includeReplies ? `Watching posts and replies from @${handle}` : `Watching posts only from @${handle}`);
      }, {
        refresh: false,
        onError: () => {
          accounts = previousAccounts;
          renderWatchlist();
        },
      });
      return;
    }

    const selectButton = event.target.closest('[data-select-account]');
    if (selectButton && !event.target.closest('.xfeed-account-controls')) {
      const nextAccount = selectButton.dataset.selectAccount || '';
      selectedAccount = selectedAccount === nextAccount ? '' : nextAccount;
      filter = 'all';
      syncFilterButtons();
      await refresh();
      return;
    }

    const button = event.target.closest('[data-remove]');
    if (!button) return;
    await withBusy(button, '', async () => {
      await api.removeXWatchAccount(button.dataset.remove);
      toast(`Removed @${button.dataset.remove}`);
    });
  });

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    filter = button.dataset.filter || 'all';
    syncFilterButtons();
    await refresh();
  });

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('#xfeed-clear-account');
    if (!button) return;
    selectedAccount = '';
    await refresh();
  });

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('#xfeed-clear-account-feed');
    if (!button || !selectedAccount) return;
    await withBusy(button, 'Removing...', async () => {
      if (!confirm(`Remove all saved X Feed items from @${selectedAccount}? Fresh updates will keep them removed.`)) return;
      const result = await api.clearXFeed(selectedAccount);
      toast(`Removed ${result.removed || 0} items from @${selectedAccount}`);
    });
  });

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-save-bookmark]');
    if (!button) return;
    event.preventDefault();
    await withBusy(button, 'Saving...', async () => {
      const result = await api.saveXFeedItemToBookmarks(button.dataset.saveBookmark);
      toast(result.saved ? 'Saved to Library' : 'Already in Library');
    });
  });

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove-feed-item]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const tweetId = button.dataset.removeFeedItem;
    if (!tweetId) return;
    const original = button.innerHTML;
    const previousItems = items;
    items = items.filter((item) => String(item.tweetId) !== String(tweetId));
    renderFeed();
    button.disabled = true;
    button.textContent = 'Removing...';
    try {
      const result = await api.removeXFeedItem(tweetId);
      toast(result.removed ? 'Removed from X Feed' : 'That item was already removed');
    } catch (err) {
      items = previousItems;
      renderFeed();
      actionError = err.payload?.userMessage || err.message || 'Could not remove X Feed item';
      renderStatus();
      toast(actionError, 4200);
    } finally {
      button.disabled = false;
      button.innerHTML = original;
      renderIcons(button);
    }
  });

  function startPolling() {
    if (timer) return;
    timer = setInterval(() => refresh().catch(() => {}), 15_000);
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  refresh().catch((err) => toast(err.message || 'Could not load X Feed'));

  return {
    onShow() {
      refresh().catch(() => {});
      startPolling();
    },
    onHide() {
      stopPolling();
    },
    refresh,
  };
}
