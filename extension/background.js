// The extension's background worker:
// - 云同步 whenever this browser saves a change, another device's change
//   arrives, Chrome starts, and every 5 minutes (how a server's changes arrive);
// - service monitoring on an alarm, with the offline count on the toolbar icon;
// - 网址体检 jobs, so leaving the page does not stop them;
// - the toolbar button opens 轻航.
import { createWorkerParts } from './extension-runtime.js';
import { STATE_KEY, PREFS_KEY } from './local-store.js';
import { META_KEY } from './sync-chrome.js';
import { HEALTH_KEY } from './monitor.js';
import { watchNetErrors } from './net-errors.js';

const { store, sync, monitor, linkChecker } = createWorkerParts();
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

async function updateBadge() {
  const offline = await monitor.offline();
  await chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
  await chrome.action.setBadgeText({ text: offline ? String(offline) : '' });
  await chrome.action.setTitle({ title: offline ? '轻航 · ' + offline + ' 个服务离线' : '打开轻航' });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[META_KEY]) scheduleSync(800);
  if (area !== 'local') return;
  if ([changes[STATE_KEY]?.newValue, changes[PREFS_KEY]?.newValue].some((record) => record?.origin === 'local')) scheduleSync(3000);
  if (changes[STATE_KEY]) scheduleMonitor().then(updateBadge).catch(() => {});
  if (changes[HEALTH_KEY]) updateBadge().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) sync.run().catch(() => {});
  if (alarm.name === MONITOR_ALARM) monitor.due().then(updateBadge).catch(() => {});
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
  scheduleMonitor().then(updateBadge).catch(() => {});
}
chrome.runtime.onInstalled.addListener(setUp);
chrome.runtime.onStartup.addListener(() => {
  setUp();
  scheduleSync(1500);
});
watchNetErrors();

chrome.action.onClicked.addListener(() => { chrome.tabs.create({ url: chrome.runtime.getURL('index.html') }); });
