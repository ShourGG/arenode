import { state } from '../state/index.js';
import { closeActionPopovers } from '../components/action-menu.js';
import { $, $$ } from './dom.js';

export function syncWorkbenchLayout() {
  const compact = window.matchMedia('(max-width: 900px)').matches;
  for (const layout of $$('.workbench-layout')) {
    const rail = $('.workbench-rail', layout); const main = $('.workbench-main, .data-workbench-main', layout);
    if (!rail || !main) continue;
    if (layout.classList.contains('data-workbench')) {
      layout.style.width = '100%'; layout.style.gridTemplateColumns = 'minmax(0, 1fr)';
      rail.hidden = true; rail.style.setProperty('display', 'none', 'important');
      main.style.width = '100%'; main.style.minWidth = '0'; main.style.gridColumn = '1';
      continue;
    }
    const contextRailVisible = rail.id !== 'resourceContextRail' || ['certs', 'dnsapis'].includes(state.resourceKind);
    layout.style.width = '100%'; layout.style.gridTemplateColumns = contextRailVisible && !compact ? '220px minmax(0, 1fr)' : 'minmax(0, 1fr)';
    rail.hidden = !contextRailVisible; rail.classList.toggle('hidden', !contextRailVisible); rail.style.setProperty('display', contextRailVisible ? 'grid' : 'none', 'important'); rail.style.gridColumn = '1';
    main.style.width = '100%'; main.style.minWidth = '0'; main.style.gridColumn = compact ? '1' : '2';
    if (!contextRailVisible) main.style.gridColumn = '1';
  }
}

window.addEventListener('resize', () => { syncWorkbenchLayout(); closeActionPopovers(); });

$('#dismissAnnouncement').addEventListener('click', () => {
  const dialog = $('#announcementDialog'); if (dialog.dataset.dismissible === 'true') localStorage.setItem(dialog.dataset.storageKey, 'dismissed'); dialog.close();
});

$('#closeAppAnnouncement').addEventListener('click', event => {
  const banner = event.currentTarget.closest('#appAnnouncement'); if (banner.dataset.storageKey) localStorage.setItem(banner.dataset.storageKey, 'dismissed'); banner.classList.add('hidden');
});

function announcementHomeVisible() {
  if (!state.me) return true;
  return state.me.user.role === 'admin' ? state.currentView === 'admin-overview' : state.currentView === 'overview';
}

export function renderAnnouncement(settings = state.authConfig) {
  const banner = state.me ? $('#appAnnouncement') : $('#publicAnnouncement'); const dialog = $('#announcementDialog');
  for (const item of [$('#appAnnouncement'), $('#publicAnnouncement')]) item?.classList.add('hidden');
  if (!settings?.announcementEnabled || !announcementHomeVisible()) {
    if (dialog?.open) dialog.close();
    return;
  }
  const severity = settings.announcementSeverity || 'info';
  const storageKey = `announcement:${settings.announcementVersion || settings.announcementTitle}`;
  if (settings.announcementDismissible && localStorage.getItem(storageKey) === 'dismissed') return;
  if (settings.announcementMode === 'banner' && banner) {
    banner.className = `${state.me ? 'app-announcement' : 'public-announcement'} announcement-${severity}`;
    $('strong', banner).textContent = settings.announcementTitle; $('p', banner).textContent = settings.announcementBody;
    banner.dataset.storageKey = storageKey;
    $('#closeAppAnnouncement')?.classList.toggle('hidden', !settings.announcementDismissible);
  }
  if (settings.announcementMode === 'modal' && dialog) {
    dialog.dataset.storageKey = storageKey; dialog.dataset.dismissible = String(Boolean(settings.announcementDismissible));
    $('#announcementDialogTitle').textContent = settings.announcementTitle; $('#announcementDialogBody').textContent = settings.announcementBody;
    $('[data-close="announcementDialog"]').classList.toggle('hidden', !settings.announcementDismissible);
    queueMicrotask(() => { if (announcementHomeVisible() && !dialog.open) dialog.showModal(); });
  }
}

export function applyPublicSettings(settings) {
  if (!settings) return;
  state.authConfig = settings;
  $$('[data-site-name]').forEach(element => { element.textContent = settings.siteName || 'Arenode'; });
  $$('[data-site-subtitle]').forEach(element => { element.textContent = settings.siteSubtitle || ''; });
  document.title = `${settings.siteName || 'Arenode'} 控制台`;
  $('#showRegister').classList.toggle('hidden', !settings.registrationEnabled);
  $('#inviteCodeField').classList.toggle('hidden', !settings.inviteOnly);
  $('#registerForm').elements.inviteCode.required = Boolean(settings.inviteOnly);
  $('#legalConsentField').classList.toggle('hidden', !settings.legalConsentRequired);
  $('#registerForm').elements.legalConsent.required = Boolean(settings.legalConsentRequired);
  renderAnnouncement(settings);
}

$('#menuButton').addEventListener('click', () => $('.sidebar').classList.toggle('open'));

function updateSystemClock() {
  $('#systemClock').textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
}

updateSystemClock();

setInterval(updateSystemClock, 1000);
