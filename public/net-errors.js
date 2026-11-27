// Chrome's error code (net::ERR_NAME_NOT_RESOLVED, …) for requests this
// extension made, which fetch() itself does not reveal. Needs the optional
// webRequest permission and host access; without them it answers ''.
const byRequest = new Map();
const byUrl = new Map();
const KEEP_MS = 60 * 1000;
let watching = false;

const key = (url) => { try { return new URL(url).href; } catch { return String(url); } };

function forget() {
  const limit = Date.now() - KEEP_MS;
  for (const [url, entry] of byUrl) if (entry.at < limit) byUrl.delete(url);
}

export function watchNetErrors() {
  const api = globalThis.chrome?.webRequest;
  if (watching || !api) return watching;
  const origin = new URL(chrome.runtime.getURL('/')).origin;
  const filter = { urls: ['http://*/*', 'https://*/*'] };
  // Redirects keep the request id: remember the address the request started with.
  api.onBeforeRequest.addListener((details) => {
    if (details.tabId === -1 && details.initiator === origin && !byRequest.has(details.requestId)) byRequest.set(details.requestId, details.url);
  }, filter);
  api.onErrorOccurred.addListener((details) => {
    const started = byRequest.get(details.requestId);
    if (!started) return;
    byRequest.delete(details.requestId);
    byUrl.set(key(started), { error: details.error, at: Date.now() });
    forget();
  }, filter);
  api.onCompleted.addListener((details) => { byRequest.delete(details.requestId); }, filter);
  watching = true;
  return watching;
}

// The error event may land a moment after fetch() rejects: wait briefly.
export async function netErrorFor(url, wait = 600) {
  const end = Date.now() + wait;
  for (;;) {
    const entry = byUrl.get(key(url));
    if (entry) { byUrl.delete(key(url)); return entry.error; }
    if (!watching || Date.now() > end) return '';
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
