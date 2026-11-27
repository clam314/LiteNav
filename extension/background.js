// The extension's background worker:
// - 云同步 whenever this browser saves a change, another device's change
//   arrives, Chrome starts, and every 5 minutes (how a server's changes arrive);
// - service monitoring on an alarm, with the offline count on the toolbar icon;
// - 网址体检 jobs, so leaving the page does not stop them;
// - 检查更新 once a day, also shown on the toolbar icon, and a tab that says so
//   after the extension's files were replaced with a newer build;
// - 添加到轻航 from the right-click menu (the toolbar popup does the rest);
// - the address bar: "ln" and a space searches 轻航's sites.
import { createWorkerParts } from './extension-runtime.js';
import { STATE_KEY, PREFS_KEY } from './local-store.js';
import { META_KEY } from './sync-chrome.js';
import { HEALTH_KEY } from './monitor.js';
import { watchNetErrors } from './net-errors.js';
import { UPDATE_KEY } from './extension-update.js';
import { JUST_UPDATED_KEY } from './local-backend.js';
import { searchableLinks, omniboxSuggestions, omniboxTarget } from './omnibox.js';
import { createUsageStore } from './usage.js';

const { area, store, sync, monitor, linkChecker, update } = createWorkerParts();
const UPDATE_ALARM = 'litenav-update';
const usage = createUsageStore(area);
// Where the popup finds a right-clicked page or link (popup.js reads it).
const PENDING_KEY = 'litenav.pendingSave';
const SYNC_ALARM = 'litenav-sync';
const MONITOR_ALARM = 'litenav-monitor';

let syncTimer;
// Changes come in bursts (dragging to sort saves each step): wait for a pause.
// chrome.storage.sync allows 120 writes a minute.
function scheduleSync(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { sync.run().catch(() => {}); }, delay);
}

// Creating an alarm restarts its countdown: only (re)create it when missing
// or when its period changed.
async function ensureAlarm(name, periodInMinutes) {
  const existing = await chrome.alarms.get(name);
  if (!periodInMinutes) { if (existing) await chrome.alarms.clear(name); return; }
  if (existing?.periodInMinutes === periodInMinutes) return;
  await chrome.alarms.create(name, { periodInMinutes, delayInMinutes: Math.min(periodInMinutes, 0.5) });
}

// Chrome runs alarms at most every 30 seconds.
async function scheduleMonitor() {
  const state = await store.state();
  const watched = state.links.some((link) => link.kind === 'service' && link.monitorEnabled);
  await ensureAlarm(MONITOR_ALARM, watched ? Math.max(0.5, state.settings.checkInterval / 60) : 0);
}

// Offline services come first; otherwise a newer build is announced.
async function updateBadge() {
  const offline = await monitor.offline();
  const newer = offline ? null : await update.status();
  await chrome.action.setBadgeBackgroundColor({ color: offline ? '#e5484d' : '#3564ed' });
  await chrome.action.setBadgeText({ text: offline ? String(offline) : newer?.available ? '↑' : '' });
  await chrome.action.setTitle({ title: offline ? '轻航 · ' + offline + ' 个服务离线' : newer?.available ? '轻航 · 有新版本 ' + newer.latest.version : '添加到轻航' });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[META_KEY]) scheduleSync(800);
  if (area !== 'local') return;
  if ([changes[STATE_KEY]?.newValue, changes[PREFS_KEY]?.newValue].some((record) => record?.origin === 'local')) scheduleSync(3000);
  if (changes[STATE_KEY]) scheduleMonitor().then(updateBadge).catch(() => {});
  if (changes[HEALTH_KEY] || changes[UPDATE_KEY]) updateBadge().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) sync.run().catch(() => {});
  if (alarm.name === MONITOR_ALARM) monitor.due().then(updateBadge).catch(() => {});
  if (alarm.name === UPDATE_ALARM) update.check().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== 'litenav.linkCheck.start') return false;
  watchNetErrors();
  linkChecker.start(message.ids ?? null).then(
    ({ job, results }) => reply({ job, results }),
    (error) => reply({ error: error.message, status: error.status || 500 }),
  );
  return true;
});

// Granted later from the page: start reading network errors at once.
chrome.permissions.onAdded.addListener(() => { watchNetErrors(); });

function setUp() {
  ensureAlarm(SYNC_ALARM, 5).catch(() => {});
  // Hourly, so a computer asleep at the time still checks soon; GitHub is asked once a day.
  ensureAlarm(UPDATE_ALARM, 60).catch(() => {});
  scheduleMonitor().then(updateBadge).catch(() => {});
  update.check().catch(() => {});
}
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'litenav-save-page', title: '添加到轻航', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'litenav-save-link', title: '把链接添加到轻航', contexts: ['link'] });
  });
}

// The popup shows what to add; when Chrome cannot open it from here (before
// version 127), the same page opens in a small window.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const link = info.menuItemId === 'litenav-save-link';
  const pending = { url: link ? info.linkUrl : info.pageUrl, title: link ? info.selectionText || '' : tab?.title || '', favIconUrl: link ? '' : tab?.favIconUrl || '', at: Date.now() };
  chrome.storage.session.set({ [PENDING_KEY]: pending }).then(() => chrome.action.openPopup()).catch(() =>
    chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 380, height: 420 }));
});

// The address bar: "ln", a space, then words to find among 轻航's sites.
const searchable = async () => searchableLinks(await store.state());
chrome.omnibox.setDefaultSuggestion({ description: '在轻航中搜索：<match>%s</match>' });
chrome.omnibox.onInputChanged.addListener((input, suggest) => {
  searchable().then((links) => suggest(omniboxSuggestions(links, input))).catch(() => suggest([]));
});
chrome.omnibox.onInputEntered.addListener(async (input, disposition) => {
  const links = await searchable().catch(() => []);
  const link = omniboxTarget(links, input);
  if (!link) {
    chrome.search.query({ text: input, disposition: disposition === 'currentTab' ? 'CURRENT_TAB' : 'NEW_TAB' });
    return;
  }
  usage.record(link.id);
  if (disposition === 'currentTab') chrome.tabs.update({ url: link.url });
  else chrome.tabs.create({ url: link.url, active: disposition !== 'newBackgroundTab' });
});

chrome.runtime.onInstalled.addListener((details) => {
  setUp();
  createMenus();
  // A newer build unpacked over the folder and reloaded: say so in a tab.
  const current = chrome.runtime.getManifest().version;
  if (details.reason === 'update' && details.previousVersion && details.previousVersion !== current) {
    area.set({ [JUST_UPDATED_KEY]: { from: details.previousVersion, to: current } })
      .then(() => chrome.tabs.create({ url: chrome.runtime.getURL('index.html#settings') })).catch(() => {});
  }
});
chrome.runtime.onStartup.addListener(() => {
  setUp();
  scheduleSync(1500);
});
watchNetErrors();

