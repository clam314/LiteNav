// The character catalogs a page plays from. The server version serves the
// copies GitHub Actions refreshes every week. The Chrome extension ships the
// copies of its build, and would never learn of new characters or costumes:
// it also keeps the latest copies from this repository's main branch, fetched
// in the background at most once a day, and plays a kept copy on the next
// visit when it is newer than its own and every part of it runs on a player
// this build has.
import { GAMES } from './companion-games.js';

export const CATALOG_REMOTE = 'https://raw.githubusercontent.com/clam314/LiteNav/main/public';
export const CATALOG_CACHE_NAME = 'litenav-companion-catalogs';
export const CATALOG_CHECK_KEY = 'litenav.companion.catalogCheckedAt';
export const CATALOG_CHECK_MS = 20 * 60 * 60 * 1000;
// What companion-runtimes.js can play; a part without one is Spine 4.1.
export const PLAYABLE_RUNTIMES = new Set(['4.0', '4.1', '4.2', 'live2d', '3.8']);

const MODES = ['idle', 'cutscene', 'cover', 'dating'];

export function usableCatalog(data) {
  if (!data || !/^[a-f0-9]{12,40}$/.test(data.commit) || !Array.isArray(data.characters) || !data.characters.length) return false;
  return data.characters.every(character => Array.isArray(character.costumes) && character.costumes.every(costume =>
    MODES.every(mode => !costume[mode] || PLAYABLE_RUNTIMES.has(costume[mode].runtime || '4.1'))));
}

const newer = (candidate, current) => String(candidate?.generatedAt || '') > String(current?.generatedAt || '');
const filesOf = game => [game.catalogUrl, game.presentationsUrl, game.performancesUrl].filter(Boolean);

// enabled: whether this page keeps remote copies (the extension). fetchJson(url,
// signal, cache) reads a bundled file.
export function createCatalogSource({ enabled = false, fetchJson, cacheStorage = globalThis.caches, remoteBase = CATALOG_REMOTE,
  fetchImpl = (...args) => globalThis.fetch(...args), storage, now = () => Date.now() }) {
  // Reading localStorage itself throws where the browser blocks storage.
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  const remote = path => remoteBase + path;
  let opening;
  const openStore = () => (opening ||= Promise.resolve(enabled ? cacheStorage?.open(CATALOG_CACHE_NAME) : null).catch(() => null));
  const kept = async path => {
    const store = await openStore();
    const response = await store?.match(remote(path)).catch(() => undefined);
    return response ? response.json().catch(() => null) : null;
  };

  return {
    // { data, reference, performances, remote } for one game, as the
    // companion loads them: the catalog is required, the other two optional.
    async read(game, signal) {
      const bundled = await fetchJson(game.catalogUrl, signal).catch(error => {
        if (error?.name === 'AbortError') throw error;
        return null;
      });
      const copy = enabled ? await kept(game.catalogUrl) : null;
      const useKept = usableCatalog(copy) && (!usableCatalog(bundled) || newer(copy, bundled));
      const data = useKept ? copy : bundled;
      if (!data) throw new Error('角色索引不可用');
      const pick = async (path, cache) => {
        if (!path) return undefined;
        if (useKept) { const value = await kept(path); if (value) return value; }
        return fetchJson(path, signal, cache);
      };
      const [reference, performances] = await Promise.all([
        game.presentationsUrl ? pick(game.presentationsUrl, 'no-cache').catch(() => ({})) : null,
        // Without its performances a skill still plays its own animations.
        game.performancesUrl ? pick(game.performancesUrl, 'no-cache').catch(() => undefined) : undefined,
      ]);
      return { data, reference, performances, remote: useKept };
    },

    // Keeps the latest copies for the next visit. Resolves with the games
    // whose copy changed; does nothing when checked recently.
    async refresh({ force = false, games = GAMES } = {}) {
      const store = await openStore();
      if (!store) return [];
      let checked = 0;
      try { checked = Number(storage?.getItem(CATALOG_CHECK_KEY)) || 0; } catch { /* Blocked: check every visit. */ }
      if (!force && now() - checked < CATALOG_CHECK_MS) return [];
      const changed = [];
      let reached = false;
      for (const game of games) {
        try {
          const responses = await Promise.all(filesOf(game).map(async path => {
            const response = await fetchImpl(remote(path), { cache: 'no-cache', credentials: 'omit', signal: AbortSignal.timeout(20000) });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return [path, await response.text()];
          }));
          reached = true;
          const catalog = JSON.parse(responses[0][1]);
          // A copy this build cannot play is not kept; the bundled one stays.
          if (!usableCatalog(catalog)) continue;
          const previous = await kept(game.catalogUrl);
          for (const [path, text] of responses) {
            JSON.parse(text);
            await store.put(remote(path), new Response(text, { headers: { 'Content-Type': 'application/json' } }));
          }
          if (previous?.generatedAt !== catalog.generatedAt) changed.push(game.id);
        } catch { /* Offline or a broken copy: keep what there is. */ }
      }
      // Offline, the next visit tries again.
      if (reached) { try { storage?.setItem(CATALOG_CHECK_KEY, String(now())); } catch { /* Checked again next time. */ } }
      return changed;
    },
  };
}
