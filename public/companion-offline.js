// Costumes saved for offline use. Saving downloads every file the costume's
// displays need (portrait, action, 有缘之客 scene, NIKKE's cover, Azur Lane's
// voice lines) into the kept asset store, and records the costume and the
// asset commits it was saved with: a later catalog may move to newer commits,
// and the saved costume keeps playing the files it has.
import { costumeKey, gameOf } from './companion-model.js';
import { performanceId } from './companion-performance-player.js';

export const OFFLINE_KEY = 'litenav.companion.offline';

// Reading localStorage itself throws where the browser blocks storage.
const browserStorage = () => { try { return globalThis.localStorage; } catch { return null; } };

export function readKept(storage) {
  try {
    const list = JSON.parse((storage ?? browserStorage()).getItem(OFFLINE_KEY));
    return Array.isArray(list) ? list.filter(entry => entry && typeof entry.key === 'string' && entry.costume && entry.source) : [];
  } catch { return []; }
}

export function writeKept(list, storage) {
  try { (storage ?? browserStorage()).setItem(OFFLINE_KEY, JSON.stringify(list)); return true; }
  catch { return false; }
}

// The displays a costume has, each once: a Live2D model or dynamic painting
// serves portrait and action alike.
export function keepModes(costume) {
  const parts = [['portrait', costume.idle], ['skill', costume.cutscene], ['dating', costume.dating], ['cover', costume.cover]];
  const seen = new Set();
  return parts.filter(([, part]) => {
    if (!part) return false;
    const id = part.model || part.painting || part.skeleton;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map(([mode]) => mode);
}

// What the loaders read from catalog.games for this costume, with only its
// own skill performances.
export function keptSource(catalog, game, costume) {
  const { performances, ...source } = catalog.games[game];
  const id = performanceId(costume.cutscene);
  return { ...source, ...(id && performances?.[id] ? { performances: { [id]: performances[id] } } : {}) };
}

export const keptEntry = (list, costume) => list.find(entry => entry.key === costumeKey(costume));

// The catalog as a saved costume needs it: its game at the saved commits.
export const catalogForKept = (catalog, entry) => ({ ...catalog, games: { ...catalog.games, [entry.game]: entry.source } });

// Only the saved costumes, as saved, for choosing while offline.
export function onlyKept(catalog, list) {
  const characters = [];
  for (const entry of list) {
    let character = characters.find(item => item.id === entry.characterId && gameOf(item) === entry.game);
    if (!character) {
      const known = catalog.characters.find(item => item.id === entry.characterId && gameOf(item) === entry.game);
      character = { ...(known || { id: entry.characterId, name: entry.name }), game: entry.game, costumes: [] };
      characters.push(character);
    }
    character.costumes.push(entry.costume);
  }
  return { ...catalog, characters };
}

// Files still needed by the other saved costumes stay when one is removed.
export function releasable(list, key) {
  const entry = list.find(item => item.key === key);
  if (!entry) return [];
  const others = new Set(list.filter(item => item.key !== key).flatMap(item => item.urls || []));
  return (entry.urls || []).filter(url => !others.has(url));
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return Math.max(1, Math.round(bytes / 1024 / 1024)) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

// Lets go of what a load produced only to be saved (blob URLs, decoded images).
export function releaseAssets(assets) {
  assets?.objectUrls?.forEach(url => URL.revokeObjectURL(url));
  for (const item of [...(assets?.layers || []), ...(assets?.externals || [])]) {
    for (const image of Object.values(item.images || {})) image?.close?.();
  }
}
