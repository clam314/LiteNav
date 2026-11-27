// How often and how lately each site was opened, for 最近使用 and for ordering
// 常用 by use. Kept per browser (chrome.storage.local in the extension, so its
// address-bar search can count too; localStorage otherwise) and never synced:
// every click would otherwise be a change to send.
export const USAGE_KEY = 'litenav.usage';
// An open counts half as much after this long, so "frequent" means lately.
export const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const KEEP = 1000;

export const decayedScore = (entry, now = Date.now()) => entry ? entry.score * 0.5 ** (Math.max(0, now - entry.last) / HALF_LIFE_MS) : 0;

export function recordOpen(usage, id, now = Date.now()) {
  const entry = usage[id];
  const next = { ...usage, [id]: { score: decayedScore(entry, now) + 1, count: (entry?.count || 0) + 1, last: now } };
  const ids = Object.keys(next);
  if (ids.length <= KEEP) return next;
  // The ones opened longest ago go first.
  ids.sort((a, b) => next[b].last - next[a].last);
  return Object.fromEntries(ids.slice(0, KEEP).map((key) => [key, next[key]]));
}

// Ids opened most recently first.
export const recentIds = (usage) => Object.keys(usage).sort((a, b) => usage[b].last - usage[a].last);

// Most used first (by the fading score); ties keep the given order.
export function byUse(links, usage, now = Date.now()) {
  return links.map((link, index) => ({ link, index, score: decayedScore(usage[link.id], now) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.link);
}

// The storage of this browser: chrome.storage.local in the extension, else
// localStorage, both behind the same get/set.
export function usageArea() {
  if (globalThis.location?.protocol === 'chrome-extension:' && globalThis.chrome?.storage?.local) return chrome.storage.local;
  return {
    async get(key) {
      try { const text = globalThis.localStorage.getItem(key); return text ? { [key]: JSON.parse(text) } : {}; }
      catch { return {}; }
    },
    async set(items) {
      try { for (const [key, value] of Object.entries(items)) globalThis.localStorage.setItem(key, JSON.stringify(value)); }
      catch { /* Blocked storage: counts last while the page is open. */ }
    },
  };
}

export function createUsageStore(area = usageArea(), now = () => Date.now()) {
  let queue = Promise.resolve();
  const read = async () => {
    const value = (await area.get(USAGE_KEY))[USAGE_KEY];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  };
  return {
    load: read,
    // One write at a time, so two quick opens both count.
    record(id) {
      queue = queue.then(async () => {
        const next = recordOpen(await read(), id, now());
        await area.set({ [USAGE_KEY]: next });
        return next;
      }).catch(() => ({}));
      return queue;
    },
    async clear() { await area.set({ [USAGE_KEY]: {} }); return {}; },
  };
}
