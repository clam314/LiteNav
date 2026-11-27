// Wires the extension's store, sync and local API to the chrome.* APIs, for
// extension pages (createPageBackend) and the background worker (createWorkerSync).
import { createLocalStore, PREFS_KEY } from './local-store.js';
import { createChromeSyncChannel } from './sync-chrome.js';
import { createSyncEngine } from './sync-engine.js';
import { createLocalBackend } from './local-backend.js';
import { PREFERENCES_KEY } from './companion-model.js';

const json = (path) => fetch(path).then((response) => {
  if (!response.ok) throw new Error('插件文件缺失：' + path);
  return response.json();
});

function createParts() {
  const area = chrome.storage.local;
  const store = createLocalStore({ area, seed: () => json('/seed.json') });
  const sync = createSyncEngine({ store, channel: createChromeSyncChannel({ area: chrome.storage.sync }), area });
  return { area, store, sync };
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

export async function createPageBackend() {
  const { store, sync } = createParts();
  const knownSites = await json('/known-sites.json');
  await bridgePreferences(store).catch(() => {});
  return createLocalBackend({ store, knownSites, sync });
}

export function createWorkerSync() {
  return createParts();
}
