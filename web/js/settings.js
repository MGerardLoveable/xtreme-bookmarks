import { api, fmtNumber, fmtRelativeTime, fmtDate } from './api.js';
import { MaintenanceView } from './views/maintenance.js';
import { renderIcons } from './icons.js';
import { escape, toast } from './util.js';

let maintenance = null;
let returnFocus = null;

export function isSettingsOpen() {
  const overlay = document.querySelector('#settings-overlay');
  return Boolean(overlay && !overlay.hidden);
}

async function refreshSummary() {
  const node = document.querySelector('#settings-summary');
  if (!node) return;
  node.innerHTML = '<div class="spinner"></div><span>Checking local services…</span>';
  try {
    const [stats, unread, system, backups] = await Promise.all([
      api.stats(), api.unreadCount(), api.systemStatus(), api.systemBackups(),
    ]);
    const sync = system.sync || {};
    const integrity = system.database || {};
    const lastSync = sync.running ? 'Running now' : sync.lastSucceededAt ? `${fmtRelativeTime(sync.lastSucceededAt)} ago` : 'Not yet';
    node.innerHTML = `
      <div class="health-pill ${system.ok ? 'good' : 'bad'}"><span></span>${integrity.ok ? 'Database healthy' : 'Integrity check failed'}</div>
      <div><strong>${fmtNumber(stats.totalBookmarks)}</strong><small>bookmarks</small></div>
      <div><strong>${lastSync}</strong><small>last sync</small></div>
      <div><strong>${fmtNumber(system.backups ?? backups.backups?.length ?? 0)}</strong><small>backups</small></div>
      ${sync.lastError ? `<p class="settings-sync-error">${escape(sync.lastError)}</p>` : ''}`;
    renderBackups(backups.backups || []);
  } catch {
    node.innerHTML = '<div class="health-pill bad"><span></span>Local server unavailable</div><p>Restart Xtreme Bookmarks, then refresh this page.</p>';
  }
}

function renderBackups(backups) {
  const copy = document.querySelector('#settings-backup-copy');
  if (!copy) return;
  const latest = backups[0];
  copy.textContent = latest
    ? `${backups.length} retained · latest ${fmtDate(latest.createdAt)} at ${new Date(latest.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'No backups yet. Create one before making major changes.';
}

export function openSettings() {
  const overlay = document.querySelector('#settings-overlay');
  if (!overlay) return;
  returnFocus = document.activeElement;
  overlay.hidden = false;
  document.body.classList.add('modal-open');
  if (!maintenance) maintenance = MaintenanceView(document.querySelector('#settings-maintenance'));
  maintenance.onShow?.();
  refreshSummary();
  setTimeout(() => document.querySelector('#settings-close')?.focus(), 0);
}

export function closeSettings() {
  const overlay = document.querySelector('#settings-overlay');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  document.body.classList.remove('modal-open');
  maintenance?.onHide?.();
  returnFocus?.focus?.();
}

export function setupSettings() {
  renderIcons(document.querySelector('#settings-overlay'));
  document.querySelector('#settings-btn')?.addEventListener('click', openSettings);
  document.querySelector('#settings-close')?.addEventListener('click', closeSettings);
  document.querySelector('#settings-overlay')?.addEventListener('click', (event) => {
    if (event.target.id === 'settings-overlay') closeSettings();
  });
  document.querySelector('.settings-panel')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const panel = event.currentTarget;
    const focusable = Array.from(panel.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  document.querySelector('#settings-backup-now')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = '<span class="spinner spinner-inline"></span>Backing up…';
    try {
      const result = await api.createSystemBackup();
      toast('Backup created');
      const backups = await api.systemBackups();
      renderBackups(backups.backups || (result.backup ? [result.backup] : []));
      await refreshSummary();
    } catch (error) {
      toast(`Backup failed: ${error.message}`, 6000);
    } finally {
      button.disabled = false;
      button.innerHTML = '<span data-icon="database-backup"></span>Back up now';
      renderIcons(button);
    }
  });
}
