// The extension's background worker: runs 云同步 whenever this browser saves
// a change, another device's change arrives, Chrome starts, and every 15
// minutes as a fallback; the toolbar button opens 轻航.
import { createWorkerSync } from './extension-runtime.js';
import { STATE_KEY, PREFS_KEY } from './local-store.js';
import { META_KEY } from './sync-chrome.js';

const { sync } = createWorkerSync();
const ALARM = 'litenav-sync';

let timer;
// Changes come in bursts (dragging to sort saves each step): wait for a pause.
// chrome.storage.sync allows 120 writes a minute.
function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(() => { sync.run().catch(() => {}); }, delay);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[META_KEY]) schedule(800);
  if (area === 'local' && [changes[STATE_KEY]?.newValue, changes[PREFS_KEY]?.newValue].some((record) => record?.origin === 'local')) schedule(3000);
});

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) sync.run().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create(ALARM, { periodInMinutes: 15 }); });
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 15 });
  schedule(1500);
});

chrome.action.onClicked.addListener(() => { chrome.tabs.create({ url: chrome.runtime.getURL('index.html') }); });
