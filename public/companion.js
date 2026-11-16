const STORAGE_KEY = 'guihang.companion.enabled';
const RUNTIME_JS = '/vendor/spine/spine-player-4.1.56.js';
const RUNTIME_CSS = '/vendor/spine/spine-player-4.1.56.css';
const CHARACTER_URL = '/companion/character.json';

let runtimePromise;
let currentCompanion;
const disposedPlayers = new WeakSet();

// Keep the runtime shared, even if the switch is turned off while it downloads.
// Each model load has a separate abort signal and generation check.
function loadRuntime() {
  if (runtimePromise) return runtimePromise;
  runtimePromise = Promise.all([
    loadRuntimeFile('link', RUNTIME_CSS),
    window.spine?.SpinePlayer ? Promise.resolve() : loadRuntimeFile('script', RUNTIME_JS),
  ]).then(() => {
    if (!window.spine?.SpinePlayer) throw new Error('角色播放器未能载入');
    return window.spine;
  }).catch(error => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

function loadRuntimeFile(tag, url) {
  const existing = document.querySelector(`[data-companion-resource="${tag}"]`);
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
      element.dataset.companionResource = tag;
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

function readPreference() {
  try { return localStorage.getItem(STORAGE_KEY) === 'true'; }
  catch { return false; }
}

function writePreference(enabled) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled)); }
  catch { /* Private browsing and blocked storage still allow this page's switch. */ }
}

function disposePlayer(player) {
  if (!player || disposedPlayers.has(player)) return;
  disposedPlayers.add(player);
  const gl = player.context?.gl;
  try { player.stopRendering(); } catch { /* A partially initialized player. */ }
  try { player.pause(); } catch { /* A partially initialized player. */ }
  try { player.dispose(); } catch { /* The parent may already have been detached. */ }
  player.dom?.remove();
  // Spine dispose releases its textures and listeners; explicitly release the
  // WebGL context too, so repeated toggles do not exhaust the browser's limit.
  try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Optional extension. */ }
}

function supportsWebGL() {
  const canvas = document.createElement('canvas');
  try {
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}

async function fetchResource(url, signal) {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error('角色素材未能载入，请重试');
  return response;
}

function readDataURI(blob, signal) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => {
      reader.abort();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const finish = callback => {
      signal.removeEventListener('abort', abort);
      callback();
    };
    reader.onload = () => finish(() => resolve(reader.result));
    reader.onerror = () => finish(() => reject(new Error('角色素材无法读取')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else reader.readAsDataURL(blob);
  });
}

async function loadCharacter(signal) {
  const response = await fetchResource(CHARACTER_URL, signal);
  const character = await response.json();
  if (!character.skelUrl || !character.atlasUrl || !character.animation ||
      !Array.isArray(character.textureUrls) || !character.textureUrls.length) {
    throw new Error('角色素材配置不完整');
  }
  const urls = [character.skelUrl, character.atlasUrl, ...character.textureUrls];
  const rawDataURIs = Object.fromEntries(await Promise.all(urls.map(async url => {
    const resource = await fetchResource(url, signal);
    const data = await readDataURI(await resource.blob(), signal);
    return [url, data];
  })));
  return { character, rawDataURIs };
}

export function initCompanion() {
  if (currentCompanion) return currentCompanion;
  const root = document.getElementById('companion-root');
  if (!root) return undefined;

  root.innerHTML = `
    <aside class="companion-rail" aria-label="角色陪伴" hidden>
      <div class="companion-player" aria-hidden="true"></div>
      <div class="companion-status" role="status" aria-live="polite">
        <span class="companion-status-text"></span>
        <button class="companion-retry" type="button" hidden>重试</button>
      </div>
      <div class="companion-caption" hidden>
        <span class="companion-name"></span><span class="companion-label"></span>
      </div>
      <div class="companion-motion" hidden>
        <span>已按系统偏好暂停</span>
        <button type="button">播放动画</button>
      </div>
    </aside>
    <button class="companion-toggle" type="button" role="switch" aria-checked="false"
      aria-label="角色动画" aria-describedby="companion-toggle-hint" title="角色动画 · 仅在此浏览器记住开关">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="m12 3 2.5 5.5 6 1-4.4 4.3 1 6.2-5.1-2.8-5.1 2.8 1-6.2L3.5 9.5l6-1L12 3Z"/>
      </svg>
      <span>角色动画</span><span class="companion-toggle-track" aria-hidden="true"></span>
    </button>
    <span id="companion-toggle-hint" class="companion-toggle-hint" role="tooltip">仅在此浏览器记住开关</span>`;

  const rail = root.querySelector('.companion-rail');
  const host = root.querySelector('.companion-player');
  const toggle = root.querySelector('.companion-toggle');
  const status = root.querySelector('.companion-status');
  const statusText = root.querySelector('.companion-status-text');
  const retry = root.querySelector('.companion-retry');
  const caption = root.querySelector('.companion-caption');
  const motion = root.querySelector('.companion-motion');
  const motionText = motion.querySelector('span');
  const motionButton = motion.querySelector('button');
  const hint = root.querySelector('.companion-toggle-hint');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const desktop = window.matchMedia('(min-width: 1280px)');
  let enabled = readPreference();
  let motionAllowed = !reducedMotion.matches;
  let generation = 0;
  let controller;
  let player;
  let ready = false;
  let disposed = false;

  function updatePlayback() {
    if (!ready || !player) return;
    const paused = document.hidden || !motionAllowed;
    if (paused) player.pause();
    else player.play();
    root.dataset.paused = String(paused);
    motion.hidden = !reducedMotion.matches;
    motionText.textContent = motionAllowed ? '动画正在播放' : '已按系统偏好暂停';
    motionButton.textContent = motionAllowed ? '暂停动画' : '播放动画';
  }

  function stop() {
    generation += 1;
    controller?.abort();
    controller = undefined;
    ready = false;
    disposePlayer(player);
    player = undefined;
    host.replaceChildren();
    caption.hidden = true;
    motion.hidden = true;
    delete root.dataset.paused;
  }

  function showError(run, message) {
    if (run !== generation || !enabled || disposed) return;
    stop();
    root.dataset.state = 'error';
    status.hidden = false;
    statusText.textContent = message;
    retry.hidden = false;
  }

  async function start() {
    stop();
    if (!enabled || !desktop.matches || disposed) return;
    const run = generation;
    const loadController = new AbortController();
    controller = loadController;
    const signal = loadController.signal;
    root.dataset.state = 'loading';
    status.hidden = false;
    statusText.textContent = '正在唤醒角色…';
    retry.hidden = true;
    if (!supportsWebGL()) {
      showError(run, '此浏览器暂不支持角色动画');
      return;
    }
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      loadController.abort();
    }, 25000);
    try {
      const [spine, { character, rawDataURIs }] = await Promise.all([
        loadRuntime(), loadCharacter(signal),
      ]);
      if (signal.aborted || run !== generation || !enabled || disposed) return;
      const instance = new spine.SpinePlayer(host, {
        binaryUrl: character.skelUrl,
        atlasUrl: character.atlasUrl,
        rawDataURIs,
        animation: character.animation,
        viewport: character.viewport || { padLeft: '4%', padRight: '4%', padTop: '4%', padBottom: '4%' },
        premultipliedAlpha: character.premultipliedAlpha ?? false,
        alpha: true,
        backgroundColor: '#00000000',
        showControls: false,
        showLoading: false,
        preserveDrawingBuffer: false,
        success(loadedPlayer) {
          if (run !== generation || signal.aborted || !enabled || disposed) {
            disposePlayer(loadedPlayer);
            return;
          }
          player = loadedPlayer;
          loadedPlayer.setAnimation(character.animation, true);
          // Pose once before pausing for reduced motion, so the character stays visible.
          loadedPlayer.animationState.apply(loadedPlayer.skeleton);
          loadedPlayer.skeleton.updateWorldTransform();
          ready = true;
          root.dataset.state = 'ready';
          status.hidden = true;
          caption.querySelector('.companion-name').textContent = character.name || '陪伴角色';
          caption.querySelector('.companion-label').textContent = character.label || '';
          caption.hidden = false;
          updatePlayback();
        },
        error(failedPlayer) {
          // The runtime throws after calling error; defer cleanup until its frame returns.
          queueMicrotask(() => {
            disposePlayer(failedPlayer);
            showError(run, '角色暂时没能出现，请重试');
          });
        },
      });
      if (run !== generation || signal.aborted) disposePlayer(instance);
      else player = instance;
    } catch (error) {
      if (run !== generation || disposed || (!timedOut && signal.aborted)) return;
      showError(run, timedOut ? '角色载入较慢，请重试' : (error.message || '角色暂时没能出现，请重试'));
    } finally {
      clearTimeout(timeout);
    }
  }

  function updateUI() {
    document.body.dataset.companion = enabled ? 'on' : 'off';
    toggle.setAttribute('aria-checked', String(enabled));
    rail.hidden = !enabled || !desktop.matches;
    hint.textContent = enabled && !desktop.matches ? '扩大窗口即可显示角色' : '角色动画 · 仅在此浏览器记住开关';
    if (!enabled) root.dataset.state = 'off';
    else if (!desktop.matches) root.dataset.state = 'compact';
  }

  function setEnabled(next, persist = true) {
    if (disposed) return;
    const changed = enabled !== next;
    enabled = next;
    if (persist) writePreference(enabled);
    updateUI();
    if (!changed) return;
    if (enabled) void start();
    else stop();
  }

  const onToggle = () => setEnabled(!enabled);
  const onRetry = () => { void start(); };
  const onMotionClick = () => {
    motionAllowed = !motionAllowed;
    updatePlayback();
  };
  const onMotionChange = () => {
    motionAllowed = !reducedMotion.matches;
    updatePlayback();
  };
  const onDesktopChange = () => {
    updateUI();
    if (enabled && desktop.matches) void start();
    else stop();
  };
  const onStorage = event => {
    if (event.key === STORAGE_KEY || event.key === null) setEnabled(event.key === null ? false : event.newValue === 'true', false);
  };
  toggle.addEventListener('click', onToggle);
  retry.addEventListener('click', onRetry);
  motionButton.addEventListener('click', onMotionClick);
  reducedMotion.addEventListener('change', onMotionChange);
  desktop.addEventListener('change', onDesktopChange);
  document.addEventListener('visibilitychange', updatePlayback);
  window.addEventListener('storage', onStorage);

  currentCompanion = {
    destroy() {
      disposed = true;
      stop();
      toggle.removeEventListener('click', onToggle);
      retry.removeEventListener('click', onRetry);
      motionButton.removeEventListener('click', onMotionClick);
      reducedMotion.removeEventListener('change', onMotionChange);
      desktop.removeEventListener('change', onDesktopChange);
      document.removeEventListener('visibilitychange', updatePlayback);
      window.removeEventListener('storage', onStorage);
      root.replaceChildren();
      delete document.body.dataset.companion;
      delete root.dataset.state;
      currentCompanion = undefined;
    },
  };
  updateUI();
  if (enabled) void start();
  return currentCompanion;
}
