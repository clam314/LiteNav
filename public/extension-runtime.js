// Wires the extension's store, sync, monitoring and link check to the
// chrome.* APIs, for extension pages (createPageBackend) and the background
// worker (createWorkerParts).
import { createLocalStore, PREFS_KEY } from './local-store.js';
import { createChromeSyncChannel } from './sync-chrome.js';
import { createServerSyncChannel, SERVER_KEY } from './sync-server.js';
import { createSyncEngine } from './sync-engine.js';
import { createLocalBackend } from './local-backend.js';
import { createMonitor } from './monitor.js';
import { createLinkChecker, checkLink } from './link-check.js';
import { netErrorFor } from './net-errors.js';
import { PREFERENCES_KEY } from './companion-model.js';
import { createUpdateChecker } from './extension-update.js';

// Optional permissions, asked for when a feature first needs them.
export const NETWORK_PERMISSIONS = Object.freeze({ permissions: ['webRequest'], origins: ['http://*/*', 'https://*/*'] });
export const hostAccess = () => chrome.permissions.contains({ origins: NETWORK_PERMISSIONS.origins }).catch(() => false);

const json = (path) => fetch(path).then((response) => {
  if (!response.ok) throw new Error('插件文件缺失：' + path);
  return response.json();
});

function createParts() {
  const area = chrome.storage.local;
  const store = createLocalStore({ area, seed: () => json('/seed.json') });
  const channelFor = async (provider) => {
    if (provider !== 'server') return createChromeSyncChannel({ area: chrome.storage.sync });
    const server = (await area.get(SERVER_KEY))[SERVER_KEY];
    if (!server?.url) throw new Error('还没有设置同步服务器');
    return createServerSyncChannel(server);
  };
  const sync = createSyncEngine({ store, channelFor, area });
  const monitor = createMonitor({ store, area });
  const update = createUpdateChecker({ area, currentVersion: chrome.runtime.getManifest().version });
  return { area, store, sync, monitor, update };
}

// The companion keeps its preferences in localStorage, which the worker
// cannot read: mirror them into chrome.storage.local both ways.
async function bridgePreferences(store) {
  const readLocal = () => { try { return JSON.parse(localStorage.getItem(PREFERENCES_KEY)); } catch { return null; } };
  const announce = () => window.dispatchEvent(new StorageEvent('storage', { key: PREFERENCES_KEY, storageArea: localStorage }));
  const apply = (value) => {
    try {
      const text = JSON.stringify(value);
      if (localStorage.getItem(PREFERENCES_KEY) === text) return;
      localStorage.setItem(PREFERENCES_KEY, text);
      announce();
    } catch { /* Blocked storage: the companion keeps what it has. */ }
  };
  const stored = await store.prefs();
  const local = readLocal();
  if (stored?.value) apply(stored.value);
  else if (local && typeof local === 'object') await store.setPrefs(local);
  window.addEventListener('litenav-preferences', (event) => { store.setPrefs(event.detail).catch(() => {}); });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const record = changes[PREFS_KEY]?.newValue;
    if (areaName === 'local' && record?.origin === 'sync' && record.value) apply(record.value);
  });
}

// The worker runs link checks, so leaving the page does not stop them.
async function startLinkCheck(ids) {
  const reply = await chrome.runtime.sendMessage({ type: 'litenav.linkCheck.start', ids });
  if (!reply) throw new Error('后台没有响应，请重新打开轻航后再试');
  if (reply.error) {
    const error = new Error(reply.error);
    error.status = reply.status || 500;
    throw error;
  }
  return reply;
}

export async function createPageBackend() {
  const { area, store, sync, monitor, update } = createParts();
  const knownSites = await json('/known-sites.json');
  await bridgePreferences(store).catch(() => {});
  const linkChecker = createLinkChecker({ store, area });
  return createLocalBackend({
    store, knownSites, sync, monitor, area, hostAccess, update,
    linkCheck: { status: () => linkChecker.status(), start: startLinkCheck },
  });
}

export function createWorkerParts() {
  const parts = createParts();
  const linkChecker = createLinkChecker({ store: parts.store, area: parts.area, check: (url, options) => checkLink(url, { ...options, netError: netErrorFor }) });
  return { ...parts, linkChecker };
}
