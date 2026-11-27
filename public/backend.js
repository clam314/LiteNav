// Where the page's /api requests go: to server.py when the page is served by
// it, or to the browser's own store when it runs as the Chrome extension.
const extension = globalThis.location?.protocol === 'chrome-extension:' && Boolean(globalThis.chrome?.storage?.local);

export const backendMode = extension ? 'extension' : 'server';

// What this backend can do; the page hides what it cannot.
export const capabilities = Object.freeze(extension
  ? { monitor: false, linkCheck: false, sync: true }
  : { monitor: true, linkCheck: true, sync: false });

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
  });
}
