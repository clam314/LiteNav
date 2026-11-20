import { separateShaderContexts } from './companion-live2d-player.js';

// Spine binaries only load in the runtime version that exported them, and
// each build declares the same global. Load builds one at a time, keep each
// one, and leave window.spine on 4.1 for code that looks for it there.
const RUNTIMES = { '4.1': '/vendor/spine/spine-player-4.1.56.js', '4.0': '/vendor/spine/spine-player-4.0.30.js' };
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

// Azur Lane's Live2D models need Cubism Core, PixiJS and pixi-live2d-display,
// loaded in this order since each builds on the previous global.
const LIVE2D_RUNTIME = [
  '/vendor/live2d/live2dcubismcore.min.js',
  '/vendor/live2d/pixi-6.5.10.min.js',
  '/vendor/live2d/pixi-live2d-display-0.4.0-cubism4.min.js',
];
let live2dRuntime;

export function loadLive2DRuntime() {
  live2dRuntime ||= (async () => {
    for (const [index, url] of LIVE2D_RUNTIME.entries()) await loadRuntimeFile('script', url, 'live2d-' + index);
    const PIXI = window.PIXI;
    if (!window.Live2DCubismCore || !PIXI?.live2d?.Live2DModel) throw new Error('角色播放器未能载入');
    separateShaderContexts(PIXI.live2d);
    return PIXI;
  })().catch(error => {
    live2dRuntime = undefined;
    throw error;
  });
  return live2dRuntime;
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
