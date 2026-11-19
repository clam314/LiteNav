// Upstream companion files are addressed by a pinned commit, so their bytes
// never change. raw.githubusercontent.com only allows five minutes of HTTP
// caching, which made every visit download the same artwork again. Keep a
// copy in the Cache API (secure contexts) and otherwise prefer whatever the
// HTTP cache still holds, stale or not.
export const ASSET_CACHE_NAME = 'litenav-companion-assets';
// Roughly 70 Spine costume modes (skeleton, atlas and textures each count
// once), or a dozen Live2D models, which also keep physics and ~15 motions.
export const ASSET_CACHE_LIMIT = 300;

// base is one origin prefix or a list of them (one per game).
export function createAssetFetcher({ base, fetchResource, cacheStorage = globalThis.caches, limit = ASSET_CACHE_LIMIT }) {
  const bases = [].concat(base);
  let opening;
  const openStore = () => {
    // Insecure origins, private windows and blocked storage have no usable store.
    opening ||= Promise.resolve(cacheStorage?.open(ASSET_CACHE_NAME)).catch(() => null);
    return opening;
  };

  async function remember(store, url, response) {
    try {
      await store.put(url, response);
      const keys = await store.keys();
      // Keys keep insertion order: drop the oldest entries beyond the limit.
      for (const request of keys.slice(0, Math.max(0, keys.length - limit))) await store.delete(request);
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
