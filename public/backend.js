// Where the page's /api requests go: to server.py when the page is served by
// it, or to the browser's own store when it runs as the Chrome extension.
const extension = globalThis.location?.protocol === 'chrome-extension:' && Boolean(globalThis.chrome?.storage?.local);

export const backendMode = extension ? 'extension' : 'server';

// What this backend can do; the page hides what it cannot. In the extension,
// network checks ask for permission to reach websites first (permissions).
export const capabilities = Object.freeze(extension
  ? { monitor: true, linkCheck: true, sync: true, permissions: true, browserBookmarks: true, browserSearch: true }
  : { monitor: true, linkCheck: true, sync: false, permissions: false, browserBookmarks: false, browserSearch: false });

// Optional extension permissions, by the feature that needs them.
const PERMISSIONS = {
  network: { permissions: ['webRequest'], origins: ['http://*/*', 'https://*/*'] },
  bookmarks: { permissions: ['bookmarks'] },
};

export async function hasPermission(kind) {
  if (!extension) return true;
  try { return await chrome.permissions.contains(PERMISSIONS[kind]); } catch { return false; }
}

// Shows Chrome's permission prompt (nothing when already granted). Chrome
// only allows it in response to a click: call it before any await.
export function requestPermission(kind, extra = {}) {
  if (!extension) return Promise.resolve(true);
  const wanted = PERMISSIONS[kind] || { permissions: [], origins: [] };
  const request = { permissions: wanted.permissions || [], origins: [...(wanted.origins || []), ...(extra.origins || [])] };
  // Chrome refuses to ask for what the extension holds anyway (a build that
  // grants them at install): then the answer is whether it holds them.
  return chrome.permissions.request(request).catch(() => chrome.permissions.contains(request).catch(() => false));
}

export function dropPermission(kind) {
  if (!extension) return Promise.resolve(false);
  return chrome.permissions.remove(PERMISSIONS[kind]).catch(() => false);
}

// Searches with the browser's default engine, where the extension may.
export function browserSearch(text, newTab) {
  return chrome.search.query({ text, disposition: newTab ? 'NEW_TAB' : 'CURRENT_TAB' });
}

export const browserBookmarks = () => chrome.bookmarks.getTree();

let localBackend;
const local = () => (localBackend ||= import('./extension-runtime.js').then((module) => module.createPageBackend()));

export async function api(path, options = {}) {
  if (extension) {
    const backend = await local();
    try { return structuredClone(await backend.request(path, options)); }
    catch (error) {
      if (!error.status) error.status = 500;
      throw error;
    }
  }
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || body.message || '请求失败，请稍后重试');
    error.status = response.status;
    throw error;
  }
  return body;
}

// Calls back when the configuration or the sync status changed elsewhere:
// another tab, or a sync run by the background worker. The server version
// keeps refreshing on focus instead.
export function onBackendChange(callback) {
  if (!extension) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes['litenav.state']) callback('state');
    if (changes['litenav.sync']) callback('sync');
    if (changes['litenav.health']) callback('health');
  });
}
