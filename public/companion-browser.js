// Browser services the companion relies on, each tolerant of what a page
// may block or lack: storage, media queries, WebGL.
import { PREFERENCES_KEY, LEGACY_KEY, SCENE_PROGRESS_KEY, REACTION_PROGRESS_KEY, normalizePreferences, normalizeSceneProgress,
  normalizeReactionProgress } from './companion-model.js';

const disposedPlayers = new WeakSet();

// With current, the fields the stored copy lacks keep their values here: a
// page of an older version, still open, saves without the newer ones.
export function readPreferences(current = null) {
  try {
    let value;
    try { value = JSON.parse(localStorage.getItem(PREFERENCES_KEY)); } catch { /* Recover invalid preferences. */ }
    if (current && value && typeof value === 'object' && !Array.isArray(value)) value = { ...current, ...value };
    return normalizePreferences(value, localStorage.getItem(LEGACY_KEY) === 'true');
  } catch { return normalizePreferences(); }
}

export function writePreferences(preferences) {
  try {
    const value = JSON.stringify(preferences);
    const stored = localStorage.getItem(PREFERENCES_KEY);
    if (stored === value) return;
    // The same preferences written another way (key order, an older page's
    // copy) are not rewritten: every write wakes the other open pages.
    let same = false;
    try {
      const saved = JSON.parse(stored);
      same = Boolean(saved) && typeof saved === 'object' && !Array.isArray(saved) &&
        JSON.stringify(normalizePreferences(saved)) === JSON.stringify(normalizePreferences(preferences));
    } catch { /* Unreadable: write ours. */ }
    if (!same) {
      localStorage.setItem(PREFERENCES_KEY, value);
      // The Chrome extension syncs the preferences between devices.
      globalThis.dispatchEvent?.(new CustomEvent('litenav-preferences', { detail: preferences }));
    }
  }
  catch { /* The controls still work when browser storage is blocked. */ }
}

// Live2D's frame rate cap: a setting of this computer (it suits its CPU), so it
// lives outside the preferences that 云同步 shares. 0 means no cap.
export const LIVE2D_FPS_KEY = 'litenav.companion.live2dFps';

export function readLive2DFps() {
  try { return localStorage.getItem(LIVE2D_FPS_KEY) === '30' ? 30 : 0; }
  catch { return 0; }
}

export function writeLive2DFps(fps) {
  try {
    if (fps) localStorage.setItem(LIVE2D_FPS_KEY, String(fps));
    else localStorage.removeItem(LIVE2D_FPS_KEY);
  } catch { /* Lasts while the page is open. */ }
}

// Progress kept per costume under storageKey, cleaned by normalize.
function readProgress(storageKey, normalize) {
  try { return normalize(JSON.parse(localStorage.getItem(storageKey))); }
  catch { return {}; }
}

// Updates one costume in place and puts it first, so tabs playing different
// costumes keep each other's progress and the oldest entries go first.
function writeProgress(storageKey, normalize, key, progress) {
  try {
    const entries = readProgress(storageKey, normalize);
    delete entries[key];
    const value = JSON.stringify(normalize({ [key]: progress, ...entries }));
    if (localStorage.getItem(storageKey) !== value) localStorage.setItem(storageKey, value);
  } catch { /* Without storage, progress lasts while the page is open. */ }
}

export function readSceneProgress() {
  return readProgress(SCENE_PROGRESS_KEY, normalizeSceneProgress);
}

export function readReactionProgress() {
  return readProgress(REACTION_PROGRESS_KEY, normalizeReactionProgress);
}

export function writeReactionProgress(key, progress) {
  writeProgress(REACTION_PROGRESS_KEY, normalizeReactionProgress, key, progress);
}

// Updates one scene in place, so tabs touring different scenes keep each other's progress.
export function writeSceneProgress(key, progress) {
  writeProgress(SCENE_PROGRESS_KEY, normalizeSceneProgress, key, progress);
}

export function mediaQuery(query, fallback) {
  try {
    const media = window.matchMedia(query);
    return {
      get matches() { return media.matches; },
      addEventListener(_type, listener) {
        if (media.addEventListener) media.addEventListener('change', listener);
        else media.addListener?.(listener);
      },
      removeEventListener(_type, listener) {
        if (media.removeEventListener) media.removeEventListener('change', listener);
        else media.removeListener?.(listener);
      },
    };
  } catch {
    // Media-query support must not prevent the independent settings controls
    // from initializing. Keep desktop sizing responsive in this fallback too.
    const listeners = new Set();
    let previous = fallback();
    const resize = () => {
      const matches = fallback();
      if (matches === previous) return;
      previous = matches;
      listeners.forEach(listener => listener({ matches }));
    };
    return {
      get matches() { return fallback(); },
      addEventListener(_type, listener) {
        listeners.add(listener);
        if (listeners.size === 1) window.addEventListener('resize', resize);
      },
      removeEventListener(_type, listener) {
        listeners.delete(listener);
        if (!listeners.size) window.removeEventListener('resize', resize);
      },
    };
  }
}

export function disposePlayer(player) {
  if (!player || disposedPlayers.has(player)) return;
  disposedPlayers.add(player);
  const gl = player.context?.gl;
  try { player.stopRendering(); } catch { /* Partially initialized player. */ }
  try { player.pause(); } catch { /* Partially initialized player. */ }
  try { player.dispose(); } catch { /* Already detached. */ }
  player.dom?.remove();
  try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Optional extension. */ }
}

// Checked once per page: every load asked again, and each check is one more
// WebGL context for the browser to clean up.
let webglSupport;

export function supportsWebGL() {
  if (webglSupport !== undefined) return webglSupport;
  const canvas = document.createElement('canvas');
  try {
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return (webglSupport = false);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return (webglSupport = true);
  } catch { return (webglSupport = false); }
}
