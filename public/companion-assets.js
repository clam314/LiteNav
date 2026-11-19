// Upstream companion files are addressed by a pinned commit, so their bytes
// never change. raw.githubusercontent.com only allows five minutes of HTTP
// caching, which made every visit download the same artwork again. Keep a
// copy in the Cache API (secure contexts) and otherwise prefer whatever the
// HTTP cache still holds, stale or not.
export const ASSET_CACHE_NAME = 'litenav-companion-assets';
// Roughly 70 Spine costume modes (skeleton, atlas and textures each count
// once), or a dozen Live2D models, which also keep physics and ~15 motions.
export const ASSET_CACHE_LIMIT = 300;
// A dynamic painting or Live2D texture alone can be 5–15 MB, so the entry
// limit could let the store grow past a gigabyte. Keep it within this size.
export const ASSET_CACHE_BYTES = 512 * 1024 * 1024;

const keyOf = request => typeof request === 'string' ? request : request.url;
// GitHub sends Content-Length for raw files and LFS objects alike. For text
// it sends gzip and counts the compressed bytes, so atlases and JSON weigh
// less than they take; images, which dominate, are counted exactly.
const sizeOf = response => Number(response?.headers?.get?.('content-length')) || 0;

// base is one origin prefix or a list of them (one per game).
export function createAssetFetcher({ base, fetchResource, cacheStorage = globalThis.caches, limit = ASSET_CACHE_LIMIT,
  maxBytes = ASSET_CACHE_BYTES }) {
  const bases = [].concat(base);
  const sizes = new Map();
  let opening;
  let trimming = Promise.resolve();
  const openStore = () => {
    // Insecure origins, private windows and blocked storage have no usable store.
    opening ||= Promise.resolve(cacheStorage?.open(ASSET_CACHE_NAME)).catch(() => null);
    return opening;
  };

  // Keys keep insertion order: drop the oldest entries until both the entry
  // count and the total size fit. Trims run one at a time.
  async function trim(store) {
    const keys = await store.keys();
    let count = keys.length;
    let total = 0;
    const entries = [];
    for (const request of keys) {
      const key = keyOf(request);
      // Entries stored by an earlier visit are measured once from their headers.
      if (!sizes.has(key)) sizes.set(key, sizeOf(await store.match(request)));
      entries.push([request, sizes.get(key)]);
      total += sizes.get(key);
    }
    // The newest entry stays, whatever its size.
    for (const [request, size] of entries.slice(0, -1)) {
      if (count <= limit && total <= maxBytes) break;
      await store.delete(request);
      sizes.delete(keyOf(request));
      count -= 1;
      total -= size;
    }
  }

  async function remember(store, url, response) {
    try {
      await store.put(url, response);
      sizes.set(url, sizeOf(response));
      trimming = trimming.then(() => trim(store)).catch(() => {});
      await trimming;
    } catch { /* Quota or storage errors: the network copy is still used. */ }
  }

  return async function fetchAsset(url, signal) {
    if (!bases.some(prefix => url.startsWith(prefix))) return fetchResource(url, signal);
    const store = await openStore();
    const stored = await store?.match(url).catch(() => undefined);
    if (stored) return stored;
    const response = await fetchResource(url, signal, 'force-cache');
    if (store) void remember(store, url, response.clone());
    return response;
  };
}
