import { separateShaderContexts } from './companion-live2d-player.js';

// Spine binaries only load in the runtime version that exported them, and
// each build declares the same global. Load builds one at a time, keep each
// one, and leave window.spine on 4.1 for code that looks for it there.
// Brown Dust 2 moved to Spine 4.2 on 2026-11-20; NIKKE ships 4.0 and 4.1.
const RUNTIMES = {
  '4.2': '/vendor/spine/spine-player-4.2.120.js',
  '4.1': '/vendor/spine/spine-player-4.1.56.js',
  '4.0': '/vendor/spine/spine-player-4.0.30.js',
};
const RUNTIME_CSS = '/vendor/spine/spine-player-4.1.56.css';

const runtimePromises = {};
const loadedRuntimes = {};
let runtimeQueue = Promise.resolve();

// Keep the runtime shared, even if the switch is turned off while it downloads.
// Each model load has a separate abort signal and generation check.
export function loadRuntime(version = '4.1') {
  if (!RUNTIMES[version]) version = '4.1';
  if (runtimePromises[version]) return runtimePromises[version];
  const task = runtimeQueue.catch(() => {}).then(async () => {
    await loadRuntimeFile('link', RUNTIME_CSS);
    const previous = window.spine;
    // A runtime that is already present (or a test double) serves 4.1 directly.
    if (version === '4.1' && previous?.SpinePlayer && !Object.values(loadedRuntimes).includes(previous)) return previous;
    await loadRuntimeFile('script', RUNTIMES[version], 'script-' + version);
    const runtime = window.spine;
    if (!runtime?.SpinePlayer) throw new Error('角色播放器未能载入');
    loadedRuntimes[version] = runtime;
    if (version !== '4.1' && previous?.SpinePlayer) window.spine = previous;
    return runtime;
  });
  runtimeQueue = task;
  runtimePromises[version] = task.catch(error => {
    delete runtimePromises[version];
    throw error;
  });
  return runtimePromises[version];
}

// Azur Lane's dynamic paintings are Spine 3.8 skeletons, drawn with the 3.8
// WebGL runtime (it has no player). That build adds its classes to whatever
// global spine object exists instead of making its own, which would mix them
// into 4.1: clear the global while it loads, then put the previous one back.
let spine38Runtime;

export function loadSpine38() {
  spine38Runtime ||= (runtimeQueue = runtimeQueue.catch(() => {}).then(async () => {
    const previous = window.spine;
    let runtime;
    window.spine = undefined;
    try {
      await loadRuntimeFile('script', '/vendor/spine/spine-webgl-3.8.js', 'script-3.8');
      runtime = window.spine;
    } finally {
      window.spine = previous;
    }
    if (!runtime?.webgl?.SceneRenderer) throw new Error('角色播放器未能载入');
    return runtime;
  })).catch(error => {
    spine38Runtime = undefined;
    throw error;
  });
  return spine38Runtime;
}

// Live2D models run on PixiJS with pixi-live2d-display, which ships one build
// per Cubism generation: Azur Lane's Cubism 3+ models need Cubism Core and the
// cubism4 build, Destiny Child's Cubism 2 models the Cubism 2.1 runtime and
// the cubism2 build. Each loads only when a model needs it, after the
// runtime it builds on. Both builds add their classes to PIXI.live2d, so each
// loads into a namespace of its own (see loadLive2DBuild).
const PIXI_RUNTIME = '/vendor/live2d/pixi-6.5.10.min.js';
// PixiJS 6 compiles uniform setters with new Function and refuses to start
// where pages may not (the Chrome extension's CSP). Its official patch swaps
// in plain setters; it is only loaded there.
const PIXI_UNSAFE_EVAL = '/vendor/live2d/pixi-unsafe-eval-6.5.10.min.js';
const evalAllowed = () => { try { return new Function('return true')(); } catch { return false; } };
const LIVE2D_GENERATIONS = {
  4: { runtime: '/vendor/live2d/live2dcubismcore.min.js', ready: () => window.Live2DCubismCore,
    build: '/vendor/live2d/pixi-live2d-display-0.4.0-cubism4.min.js', settings: 'Cubism4ModelSettings' },
  2: { runtime: '/vendor/live2d/live2d-2.1.min.js', ready: () => window.Live2D,
    build: '/vendor/live2d/pixi-live2d-display-0.4.0-cubism2.min.js', settings: 'Cubism2ModelSettings' },
};
const live2dRuntimes = {};

// The PixiJS global and the plugin namespace for one generation (4 or 2).
export function loadLive2DRuntime(generation = 4) {
  const spec = LIVE2D_GENERATIONS[generation];
  if (!spec) return Promise.reject(new Error('角色播放器未能载入'));
  live2dRuntimes[generation] ||= (async () => {
    await loadRuntimeFile('script', spec.runtime, 'live2d-core-' + generation);
    await loadRuntimeFile('script', PIXI_RUNTIME, 'live2d-pixi');
    if (!evalAllowed()) await loadRuntimeFile('script', PIXI_UNSAFE_EVAL, 'live2d-pixi-unsafe-eval');
    const PIXI = window.PIXI;
    const live2d = await loadLive2DBuild(PIXI, spec.build, generation);
    if (!spec.ready() || !live2d?.Live2DModel || !live2d[spec.settings]) throw new Error('角色播放器未能载入');
    if (generation === 4) separateShaderContexts(live2d);
    return { PIXI, live2d };
  })().catch(error => {
    delete live2dRuntimes[generation];
    throw error;
  });
  return live2dRuntimes[generation];
}

// A plugin build adds itself to PIXI.live2d, creating it when missing. Give it
// an empty one while it runs, keep what it made and put the previous one back,
// one build at a time.
function loadLive2DBuild(PIXI, url, generation) {
  const task = runtimeQueue.catch(() => {}).then(async () => {
    const previous = PIXI?.live2d;
    if (PIXI) PIXI.live2d = undefined;
    try {
      await loadRuntimeFile('script', url, 'live2d-build-' + generation);
      return PIXI?.live2d;
    } finally {
      if (PIXI) PIXI.live2d = previous;
    }
  });
  runtimeQueue = task;
  return task;
}

function loadRuntimeFile(tag, url, key = tag) {
  const existing = document.querySelector(`[data-companion-resource="${key}"]`);
  if (existing?.dataset.loaded === 'true') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const element = existing || document.createElement(tag);
    let timer;
    const finish = error => {
      clearTimeout(timer);
      element.removeEventListener('load', loaded);
      element.removeEventListener('error', failed);
      if (error) {
        element.remove();
        reject(error);
      } else {
        element.dataset.loaded = 'true';
        resolve();
      }
    };
    const loaded = () => finish();
    const failed = () => finish(new Error('角色播放器未能载入，请重试'));
    element.addEventListener('load', loaded, { once: true });
    element.addEventListener('error', failed, { once: true });
    timer = setTimeout(failed, 15000);
    if (!existing) {
      element.dataset.companionResource = key;
      if (tag === 'link') {
        element.rel = 'stylesheet';
        element.href = url;
      } else {
        element.src = url;
        element.async = true;
      }
      document.head.append(element);
    }
  });
}
