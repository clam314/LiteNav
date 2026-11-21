// Browser services the companion relies on, each tolerant of what a page
// may block or lack: storage, media queries, WebGL.
import { PREFERENCES_KEY, LEGACY_KEY, SCENE_PROGRESS_KEY, normalizePreferences, normalizeSceneProgress } from './companion-model.js';

const disposedPlayers = new WeakSet();

export function readPreferences() {
  try {
    let value;
    try { value = JSON.parse(localStorage.getItem(PREFERENCES_KEY)); } catch { /* Recover invalid preferences. */ }
    return normalizePreferences(value, localStorage.getItem(LEGACY_KEY) === 'true');
  } catch { return normalizePreferences(); }
}

export function writePreferences(preferences) {
  try {
    const value = JSON.stringify(preferences);
    if (localStorage.getItem(PREFERENCES_KEY) !== value) localStorage.setItem(PREFERENCES_KEY, value);
  }
  catch { /* The controls still work when browser storage is blocked. */ }
}

export function readSceneProgress() {
  try { return normalizeSceneProgress(JSON.parse(localStorage.getItem(SCENE_PROGRESS_KEY))); }
  catch { return {}; }
}

// Updates one scene in place, so tabs touring different scenes keep each other's progress.
export function writeSceneProgress(key, progress) {
  try {
    const scenes = readSceneProgress();
    delete scenes[key];
    const value = JSON.stringify(normalizeSceneProgress({ [key]: progress, ...scenes }));
    if (localStorage.getItem(SCENE_PROGRESS_KEY) !== value) localStorage.setItem(SCENE_PROGRESS_KEY, value);
  } catch { /* Without storage, progress lasts while the page is open. */ }
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

export function supportsWebGL() {
  const canvas = document.createElement('canvas');
  try {
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}
