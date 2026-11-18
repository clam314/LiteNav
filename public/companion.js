import { PREFERENCES_KEY, LEGACY_KEY, ROTATION_CHOICES, normalizePreferences, displayOf, withDisplay, costumeKey, gameOf,
  availableCharacters, paddedView, placeView,
  chooseCharacter, atlasPages, playableAnimations, configureViewports, presentationForCostume,
  isLoopingSkill, selectSkillAnimation, completeSkin } from './companion-model.js';
import { createCompanionStage } from './companion-stage.js';
import { LOCAL_FALLBACK_CHARACTER, LOCAL_FALLBACK_COMMIT } from './companion-fallback.js';
import { isExcludedCharacter } from './companion-exclusions.js';
import { composeSkillAttachments } from './companion-composition.js';
import { queuePortraitMotion } from './companion-portrait.js';
import { createAssetFetcher } from './companion-assets.js';
import { GAMES, gameById } from './companion-games.js';
import { fireAnimations, queueFireCycle } from './companion-fire.js';
import { combatAnimations, createCombatCycle } from './companion-combat.js';
// Spine binaries only load in the runtime version that exported them, and
// each build declares the same global. Load builds one at a time, keep each
// one, and leave window.spine on 4.1 for code that looks for it there.
const RUNTIMES = { '4.1': '/vendor/spine/spine-player-4.1.56.js', '4.0': '/vendor/spine/spine-player-4.0.30.js' };
const RUNTIME_CSS = '/vendor/spine/spine-player-4.1.56.css';

const runtimePromises = {};
const loadedRuntimes = {};
let runtimeQueue = Promise.resolve();
let currentCompanion;
const disposedPlayers = new WeakSet();

// Keep the runtime shared, even if the switch is turned off while it downloads.
// Each model load has a separate abort signal and generation check.
function loadRuntime(version = '4.1') {
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

function readPreferences() {
  try {
    let value;
    try { value = JSON.parse(localStorage.getItem(PREFERENCES_KEY)); } catch { /* Recover invalid preferences. */ }
    return normalizePreferences(value, localStorage.getItem(LEGACY_KEY) === 'true');
  } catch { return normalizePreferences(); }
}

function writePreferences(preferences) {
  try {
    const value = JSON.stringify(preferences);
    if (localStorage.getItem(PREFERENCES_KEY) !== value) localStorage.setItem(PREFERENCES_KEY, value);
  }
  catch { /* The controls still work when browser storage is blocked. */ }
}

function mediaQuery(query, fallback) {
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

function disposePlayer(player) {
  if (!player || disposedPlayers.has(player)) return;
  disposedPlayers.add(player);
  const gl = player.context?.gl;
  try { player.stopRendering(); } catch { /* Partially initialized player. */ }
  try { player.pause(); } catch { /* Partially initialized player. */ }
  try { player.dispose(); } catch { /* Already detached. */ }
  player.dom?.remove();
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

async function fetchResource(url, signal, cache = 'default') {
  const response = await fetch(url, { signal, credentials: 'same-origin', cache });
  if (!response.ok) throw new Error('角色素材未能载入，请重试');
  return response;
}

const fetchAsset = createAssetFetcher({ base: GAMES.map(game => game.assetBase), fetchResource });

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

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

const partFor = (selection, mode) => mode === 'skill' ? selection.costume.cutscene :
  mode === 'cover' ? selection.costume.cover : selection.costume.idle;

async function loadCharacter(catalog, selection, mode, signal) {
  const part = partFor(selection, mode);
  if (!part) throw new Error('这套服装没有对应的动画');
  const local = mode === 'portrait' && part.skeleton === LOCAL_FALLBACK_CHARACTER.costumes[0].idle.skeleton;
  const source = catalog.games[gameOf(selection.character)];
  const remote = source.assetBase + source.commit + '/';
  const skelUrl = local ? '/companion/assets/' + part.skeleton.split('/').pop() : remote + part.skeleton;
  const atlasUrl = local ? '/companion/assets/' + part.atlas.split('/').pop() : remote + part.atlas;
  const [skeleton, atlas] = await Promise.all([
    fetchAsset(skelUrl, signal).then(response => response.blob()),
    fetchAsset(atlasUrl, signal).then(response => response.text()),
  ]);
  const baseUrl = new URL(atlasUrl, location.href);
  const textureUrls = atlasPages(atlas).map(page => new URL(page, baseUrl).href);
  const [textures, skeletonData] = await Promise.all([
    Promise.all(textureUrls.map(async url => [url, await (await fetchAsset(url, signal)).blob()])),
    readDataURI(skeleton, signal),
  ]);
  // Spine reads the skeleton and atlas only from data URIs, but textures load
  // through <img>. Blob URLs skip base64 for the largest files; the owner of
  // these assets revokes them once no new player can use them. Spine decodes
  // base64 text with atob, which garbles UTF-8 region names (NIKKE atlases use
  // Korean ones), while a plain data URI hands back the text after the comma.
  const rawDataURIs = { [skelUrl]: skeletonData, [atlasUrl]: 'data:text/plain;charset=utf-8,' + atlas };
  const objectUrls = textures.map(([url, blob]) => (rawDataURIs[url] = URL.createObjectURL(blob)));
  // Runtime joins relative local atlas paths without expanding them to location.origin.
  if (local) {
    for (const url of textureUrls) rawDataURIs[new URL(url).pathname] = rawDataURIs[url];
  }
  return { skelUrl, atlasUrl, rawDataURIs, objectUrls, premultipliedAlpha: /^pma:\s*true\s*$/m.test(atlas) };
}

// Spine fits its whole canvas to the camera. The canvas fills the rail, and the
// camera is widened around the preset view so that view stands on the bottom
// edge while artwork beyond it keeps drawing toward the faded rail edges.
// The cover and aim skeletons place the figure at different spots, so a
// shared camera made her jump sideways on every switch. Give both views the
// same size (and so the same scale), each centred on its own figure and
// standing on its own floor, so a switch changes the pose but not the place.
const alignedViews = (a, b) => {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const frame = view => ({ x: view.x + view.width / 2 - width / 2, y: view.y, width, height });
  return [frame(a), frame(b)];
};

// A second player for NIKKE's cover skeleton, sharing the layer and camera.
function spawnPartner(spine, layer, assets, part, record) {
  return new Promise((resolve, reject) => {
    record.partner = new spine.SpinePlayer(layer, {
      binaryUrl: assets.skelUrl, atlasUrl: assets.atlasUrl, rawDataURIs: assets.rawDataURIs,
      viewport: { padLeft: '5%', padRight: '5%', padTop: '5%', padBottom: '5%', transitionTime: 0 },
      premultipliedAlpha: assets.premultipliedAlpha,
      alpha: true, backgroundColor: '#00000000', showControls: false, showLoading: false,
      preserveDrawingBuffer: false, defaultMix: 0,
      ...(part.skin ? { skin: part.skin } : {}),
      success: resolve,
      error: () => reject(new Error('角色动画暂时无法播放')),
      frame(player) { if (record.view) layoutCamera(record, player); },
    });
  });
}

function layoutCamera(record, player) {
  const width = player.canvas.clientWidth;
  const height = player.canvas.clientHeight;
  const key = width + 'x' + height;
  if (!width || !height || key === player.companionRailKey) return;
  player.companionRailKey = key;
  const space = parseFloat(getComputedStyle(record.layer).getPropertyValue('--companion-space')) || width / 2;
  // Wide full shots stay out of the strongest left fade.
  const maxWidth = record.layer.classList.contains('fit-artwork') ? Math.max(width * .75, space) : width;
  Object.assign(player.currentViewport, placeView(player.companionView || record.view, { width, height }, space, maxWidth));
}

export function initCompanion() {
  if (currentCompanion) return currentCompanion;
  const root = document.getElementById('companion-root');
  if (!root) return undefined;
  const icon = path => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  const segment = (name, value, text) => `<label><input type="radio" name="${name}" value="${value}"><span>${text}</span></label>`;
  root.innerHTML = `
    <aside class="companion-rail" aria-label="角色陪伴" hidden>
      <div class="companion-player" aria-hidden="true"></div>
      <div class="companion-status" role="status" aria-live="polite" hidden>
        <span class="companion-status-text"></span>
        <button class="companion-retry" type="button" hidden>重试</button>
        <button class="companion-fallback" type="button" hidden>使用本地立绘</button>
      </div>
    </aside>
    <div class="companion-controls">
    <button class="companion-toggle" type="button" aria-expanded="false" aria-controls="companion-menu" aria-label="角色设置" data-tip="角色设置">
      ${icon('<path d="m12 3 2.5 5.5 6 1-4.4 4.3 1 6.2-5.1-2.8-5.1 2.8 1-6.2L3.5 9.5l6-1L12 3Z"/>').replace('width="16" height="16"', 'width="18" height="18"')}
      <span class="companion-indicator" aria-hidden="true"></span>
    </button>
    <section id="companion-menu" class="companion-menu" role="region" aria-label="角色设置" hidden>
      <header class="companion-menu-header">
        <strong>角色陪伴</strong>
        <input class="companion-power" type="checkbox" role="switch" aria-label="角色陪伴">
        <button class="companion-menu-close" type="button" aria-label="关闭角色设置">×</button>
      </header>
      <div class="companion-now">
        <div class="companion-now-copy">
          <strong class="companion-current-name">正在读取角色…</strong>
          <span class="companion-current-label"></span>
        </div>
        <button class="companion-icon-button companion-shuffle" type="button" aria-label="换一位" data-tip="换一位" disabled>
          ${icon('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>')}
        </button>
        <button class="companion-icon-button companion-pause" type="button" aria-label="暂停动画" data-tip="暂停动画" aria-pressed="false" disabled>
          <span class="companion-pause-icon">${icon('<path d="M9 5v14"/><path d="M15 5v14"/>')}</span>
          <span class="companion-play-icon">${icon('<path d="m8 5 11 7-11 7V5Z"/>')}</span>
        </button>
      </div>
      <fieldset class="companion-field">
        <legend>展示</legend>
        <div class="companion-segmented">${segment('companion-display', 'portrait', '立绘')}${segment('companion-display', 'skill', '动作')}${segment('companion-display', 'both', '轮流')}</div>
      </fieldset>
      <fieldset class="companion-field">
        <legend>人物</legend>
        <div class="companion-segmented">${segment('companion-person', 'random', '随机轮换')}${segment('companion-person', 'fixed', '固定')}</div>
      </fieldset>
      <label class="companion-field companion-rotation"><span>更换间隔</span><select aria-label="更换间隔">
        ${ROTATION_CHOICES.map(minutes => `<option value="${minutes}">${minutes ? `每 ${minutes} 分钟` : '仅刷新页面时'}</option>`).join('')}
      </select></label>
      <label class="companion-field companion-fixed"><span>人物与服装</span><select aria-label="指定人物与服装" disabled><option>正在读取角色…</option></select></label>
      <label class="companion-field companion-skill-picker" hidden><span>技能动作</span><select aria-label="技能动作" disabled><option>载入技能后可选择</option></select></label>
      <fieldset class="companion-field">
        <legend>游戏</legend>
        <div class="companion-chips">${GAMES.map(game => `<label><input type="checkbox" name="companion-game" value="${game.id}"><span>${game.name}</span></label>`).join('')}</div>
      </fieldset>
      <p class="companion-menu-note" role="status" aria-live="polite" hidden></p>
      <div class="companion-menu-recovery" hidden><button class="companion-menu-retry" type="button">重试切换</button><button class="companion-menu-fallback" type="button">使用本地立绘</button></div>
      <small class="companion-menu-foot">设置仅保存在此浏览器，新角色首次加载需要联网。</small>
    </section></div>`;

  const rail = root.querySelector('.companion-rail');
  const host = root.querySelector('.companion-player');
  const toggle = root.querySelector('.companion-toggle');
  const menu = root.querySelector('.companion-menu');
  const close = root.querySelector('.companion-menu-close');
  const status = root.querySelector('.companion-status');
  const statusText = root.querySelector('.companion-status-text');
  const retry = root.querySelector('.companion-retry');
  const fallback = root.querySelector('.companion-fallback');
  const power = root.querySelector('.companion-power');
  const currentName = root.querySelector('.companion-current-name');
  const currentLabel = root.querySelector('.companion-current-label');
  const displayInputs = [...root.querySelectorAll('[name="companion-display"]')];
  const personInputs = [...root.querySelectorAll('[name="companion-person"]')];
  const gameInputs = [...root.querySelectorAll('[name="companion-game"]')];
  const rotationField = root.querySelector('.companion-rotation');
  const rotationPicker = root.querySelector('[aria-label="更换间隔"]');
  const fixedField = root.querySelector('.companion-fixed');
  const picker = root.querySelector('[aria-label="指定人物与服装"]');
  const skillPickerLabel = root.querySelector('.companion-skill-picker');
  const skillPicker = root.querySelector('[aria-label="技能动作"]');
  const shuffle = root.querySelector('.companion-shuffle');
  const pause = root.querySelector('.companion-pause');
  const note = root.querySelector('.companion-menu-note');
  const recovery = root.querySelector('.companion-menu-recovery');
  const menuRetry = root.querySelector('.companion-menu-retry');
  const menuFallback = root.querySelector('.companion-menu-fallback');

  // Bind the menu before setting up rendering, media queries or asset loading.
  // A renderer setup failure must never leave a visible, unresponsive button.
  function setMenu(open, restoreFocus = false) {
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) close.focus();
    else if (restoreFocus) toggle.focus();
  }
  const onToggle = () => setMenu(menu.hidden);
  const onClose = () => setMenu(false, true);
  const onOutside = event => {
    if (!menu.hidden && !menu.contains(event.target) && !toggle.contains(event.target)) setMenu(false);
  };
  const onKeydown = event => {
    if (menu.hidden || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setMenu(false, true);
  };
  const onFocus = event => {
    if (!menu.hidden && !root.contains(event.target)) setMenu(false);
  };
  toggle.addEventListener('click', onToggle);
  close.addEventListener('click', onClose);
  document.addEventListener('pointerdown', onOutside);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('focusin', onFocus);

  const reducedMotion = mediaQuery('(prefers-reduced-motion: reduce)', () => true);
  const desktop = mediaQuery('(min-width: 1280px)', () => window.innerWidth >= 1280);
  let preferences = readPreferences();
  let motionAllowed = !reducedMotion.matches;
  let catalog;
  let presentations;
  let selection;
  let skillAnimations = [];
  let skillPickerSignature;
  let disposed = false;
  let mode = 'portrait';
  let loadError = '';
  let pickerSignature;
  let noteHold = false;
  // While random rotation is on, the next person appears after this time.
  let rotationDue = Infinity;
  const assetCache = new Map();
  const enabled = () => preferences.portraits || preferences.skills;
  const initialMode = () => preferences.portraits ? 'portrait' : 'skill';
  const stage = createCompanionStage({
    dispose(record) {
      clearTimeout(record.timeout);
      clearTimeout(record.loadingTimer);
      disposePlayer(record.player);
      disposePlayer(record.partner);
      record.layer.remove();
    },
    transition(outgoing, incoming, done) {
      outgoing.layer.style.removeProperty('transition');
      incoming.layer.classList.add('is-visible');
      outgoing.layer.classList.remove('is-visible');
      if (reducedMotion.matches || document.hidden) { done(); return; }
      let finished = false;
      const cleanup = () => {
        clearTimeout(timer);
        incoming.layer.removeEventListener('transitionend', onEnd);
      };
      const complete = () => {
        if (finished) return;
        finished = true;
        cleanup();
        done();
      };
      const onEnd = event => { if (event.target === incoming.layer && event.propertyName === 'opacity') complete(); };
      const timer = setTimeout(complete, 520);
      incoming.layer.addEventListener('transitionend', onEnd);
      return () => {
        finished = true;
        cleanup();
        incoming.layer.style.transition = 'none';
        incoming.layer.classList.add('is-visible');
      };
    },
  });

  function updateUI() {
    const active = stage.active;
    const visible = enabled() && desktop.matches;
    const display = displayOf(preferences);
    document.body.dataset.companion = visible ? 'on' : 'off';
    root.dataset.enabled = String(enabled());
    rail.hidden = !visible;
    power.checked = enabled();
    // While off, the segments show what the switch would restore.
    displayInputs.forEach(input => { input.checked = input.value === (display === 'off' ? preferences.resume : display); });
    personInputs.forEach(input => { input.checked = (input.value === 'random') === preferences.random; });
    rotationField.hidden = !preferences.random;
    rotationPicker.value = String(preferences.rotation);
    fixedField.hidden = preferences.random;
    gameInputs.forEach(input => {
      input.checked = preferences.games.includes(input.value);
      // At least one game must stay selected.
      input.disabled = input.checked && preferences.games.length === 1;
    });
    shuffle.disabled = !catalog || !enabled();
    pause.disabled = !active;
    const pauseText = motionAllowed ? '暂停动画' : '播放动画';
    pause.setAttribute('aria-label', pauseText);
    pause.dataset.tip = pauseText;
    pause.setAttribute('aria-pressed', String(!motionAllowed));
    // NIKKE has one firing loop, so only Brown Dust 2 offers a choice of action.
    skillPickerLabel.hidden = preferences.random || !preferences.skills || gameOf(selection?.character) !== 'bd2';
    skillPicker.disabled = !skillAnimations.length;
    const skillSignature = skillAnimations.map(animation => animation.name).join('|');
    if (skillSignature !== skillPickerSignature) {
      skillPickerSignature = skillSignature;
      skillPicker.replaceChildren();
      const configured = presentationForCostume(presentations, selection?.costume || {})?.skills || [];
      if (!skillAnimations.length) {
        const placeholder = document.createElement('option');
        placeholder.textContent = '载入技能后可选择';
        skillPicker.append(placeholder);
      }
      skillAnimations.forEach((animation, index) => {
        const option = document.createElement('option');
        option.value = animation.name;
        option.textContent = configured.find(action => action.animation === animation.name)?.label || `动作${index + 1}`;
        skillPicker.append(option);
      });
    }
    if (skillAnimations.length) skillPicker.value = preferences.skillAction;
    const severalGames = preferences.games.length > 1;
    if (selection) {
      currentName.textContent = selection.character.name;
      currentLabel.textContent = selection.costume.label + (severalGames ? ` · ${gameById(gameOf(selection.character)).name}` : '');
    }
    if (active) root.dataset.mode = active.mode;
    if (catalog) {
      const signature = `${preferences.portraits}:${preferences.skills}:${preferences.games}`;
      if (signature !== pickerSignature) {
        pickerSignature = signature;
        picker.replaceChildren();
        for (const character of availableCharacters(catalog, preferences)) {
          const group = document.createElement('optgroup');
          group.label = severalGames ? `${gameById(gameOf(character)).name} · ${character.name}` : character.name;
          for (const costume of character.costumes) {
            const option = document.createElement('option');
            option.value = costumeKey(costume);
            option.textContent = `${character.name} · ${costume.label}`;
            group.append(option);
          }
          picker.append(group);
        }
      }
      picker.disabled = false;
      if (selection) picker.value = costumeKey(selection.costume);
    }
    recovery.hidden = !loadError;
    let message = '';
    if (!enabled()) {
      root.dataset.state = 'off';
      message = '已关闭，导航使用完整宽度。';
    } else if (!desktop.matches) {
      root.dataset.state = 'compact';
      message = '窗口宽度达到 1280px 时展示角色。';
    } else if (loadError) {
      root.dataset.state = 'error';
      message = active ? `${loadError}，已保留当前画面。` : loadError;
    } else if (stage.pending) {
      root.dataset.state = active ? 'switching' : 'loading';
      message = statusText.textContent;
    } else {
      root.dataset.state = active ? 'ready' : 'off';
      if (!motionAllowed) message = reducedMotion.matches ? '已按系统偏好暂停动画。' : '动画已暂停。';
    }
    // Errors from a rejected choice stay until the next change.
    if (!noteHold) note.textContent = message;
    note.hidden = !note.textContent;
  }

  function updatePlayback() {
    const paused = document.hidden || !motionAllowed;
    for (const record of [stage.active, stage.pending, stage.outgoing]) {
      for (const player of [record?.player, record?.partner]) {
        if (!player) continue;
        if (paused) player.pause();
        else player.play();
      }
    }
    if (stage.active) root.dataset.paused = String(paused);
    updateUI();
  }

  function clearAssets() {
    for (const task of assetCache.values()) {
      task.controller.abort();
      // Players that already loaded keep their decoded textures.
      task.promise.then(assets => assets.objectUrls.forEach(url => URL.revokeObjectURL(url)), () => {});
    }
    assetCache.clear();
  }

  function assetsFor(characterSelection, requestedMode) {
    const key = costumeKey(characterSelection.costume) + ':' + requestedMode;
    if (assetCache.has(key)) return assetCache.get(key).promise;
    const task = { controller: new AbortController() };
    const timeout = setTimeout(() => task.controller.abort(), 45000);
    task.promise = loadCharacter(catalog, characterSelection, requestedMode, task.controller.signal)
      .catch(error => {
        if (assetCache.get(key) === task) assetCache.delete(key);
        throw error;
      }).finally(() => clearTimeout(timeout));
    assetCache.set(key, task);
    return task.promise;
  }

  function prefetchOtherMode(record) {
    if (!preferences.portraits || !preferences.skills || !enabled() || disposed) return;
    const other = record.mode === 'portrait' ? 'skill' : 'portrait';
    // The same request is shared with an actual switch if it happens before
    // prefetch completes. Failed background loads never replace the artwork.
    void assetsFor(record.selection, other).catch(() => {});
  }

  function stop() {
    stage.clear();
    clearAssets();
    loadError = '';
    host.replaceChildren();
    status.hidden = true;
    delete root.dataset.paused;
    delete root.dataset.mode;
  }

  function showError(record, message) {
    if (disposed || !enabled() || !desktop.matches) return;
    if (stage.pending === record) stage.fail(record);
    else if (stage.active !== record) return;
    loadError = message;
    statusText.textContent = message;
    status.hidden = Boolean(stage.active);
    retry.hidden = false;
    fallback.hidden = false;
    updateUI();
  }

  function scheduleRotation() {
    rotationDue = preferences.random && preferences.rotation ? performance.now() + preferences.rotation * 60000 : Infinity;
  }

  // Move to another random person at a natural break in the current motion.
  function advance(record, next) {
    record.advancing = true;
    queueMicrotask(() => {
      if (stage.active !== record) return;
      if (next !== 'rotate') { void start(next); return; }
      try {
        selectCharacter(true);
      } catch {
        scheduleRotation();
        record.advancing = false;
        return;
      }
      void start();
    });
  }

  function selectCharacter(redraw = false, preserveSkillAction = false) {
    if (!catalog) return;
    const previous = selection ? costumeKey(selection.costume) : preferences.costumeKey;
    selection = chooseCharacter(catalog, preferences, redraw);
    if (previous !== costumeKey(selection.costume)) {
      if (!preserveSkillAction) preferences.skillAction = '';
      skillAnimations = [];
      skillPickerSignature = undefined;
      clearAssets();
      scheduleRotation();
    }
    preferences.characterId = selection.character.id;
    preferences.costumeKey = costumeKey(selection.costume);
    writePreferences(preferences);
    updateUI();
  }

  async function start(nextMode = initialMode()) {
    if (!enabled() || !desktop.matches || disposed || !selection) {
      stop();
      updateUI();
      return;
    }
    mode = nextMode;
    const layer = document.createElement('div');
    layer.className = 'companion-layer';
    if (nextMode === 'portrait' && costumeKey(selection.costume) === costumeKey(LOCAL_FALLBACK_CHARACTER.costumes[0])) {
      layer.classList.add('fit-artwork');
    }
    const record = {
      layer, selection, mode: nextMode, skillAction: preferences.skillAction,
      controller: new AbortController(), elapsed: 0, advancing: false,
    };
    stage.begin(record);
    host.append(layer);
    const signal = record.controller.signal;
    loadError = '';
    status.hidden = true;
    statusText.textContent = `正在准备${record.selection.character.name}的${record.mode === 'skill' ? gameById(gameOf(record.selection.character)).action : '立绘'}…`;
    retry.hidden = true;
    fallback.hidden = true;
    // Only an initial, genuinely slow load gets a stage-level placeholder.
    record.loadingTimer = setTimeout(() => {
      if (stage.pending === record && !stage.active) status.hidden = false;
    }, 350);
    updateUI();
    if (!supportsWebGL()) {
      showError(record, '此浏览器暂不支持角色动画');
      return;
    }
    record.timeout = setTimeout(() => {
      showError(record, '角色载入较慢');
    }, 45000);
    try {
      // NIKKE's combat loop also needs the cover skeleton.
      const coverPart = record.mode === 'skill' && gameOf(record.selection.character) === 'nikke' ? record.selection.costume.cover : null;
      const [spine, assets, coverSpine, coverAssets] = await withAbort(Promise.all([
        loadRuntime(partFor(record.selection, record.mode)?.runtime), assetsFor(record.selection, record.mode),
        coverPart ? loadRuntime(coverPart.runtime) : null, coverPart ? assetsFor(record.selection, 'cover') : null,
      ]), signal);
      if (signal.aborted || stage.pending !== record || disposed) return;
      if (coverPart) {
        const partner = await withAbort(spawnPartner(coverSpine, layer, coverAssets, coverPart, record), signal);
        completeSkin(coverSpine, partner.skeleton);
      }
      if (signal.aborted || stage.pending !== record || disposed) return;
      await new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        const finish = callback => { signal.removeEventListener('abort', abort); callback(); };
        const instance = new spine.SpinePlayer(layer, {
          binaryUrl: assets.skelUrl, atlasUrl: assets.atlasUrl, rawDataURIs: assets.rawDataURIs,
          viewport: { padLeft: '5%', padRight: '5%', padTop: '5%', padBottom: '5%', transitionTime: 0 },
          premultipliedAlpha: assets.premultipliedAlpha,
          alpha: true, backgroundColor: '#00000000', showControls: false, showLoading: false,
          preserveDrawingBuffer: false, defaultMix: 0,
          ...(partFor(record.selection, record.mode)?.skin ? { skin: partFor(record.selection, record.mode).skin } : {}),
          success(loadedPlayer) {
            if (stage.pending !== record || signal.aborted || disposed) return;
            try {
              record.player = loadedPlayer;
              const presentation = presentationForCostume(presentations, record.selection.costume);
              const data = loadedPlayer.skeleton.data;
              if (gameOf(record.selection.character) === 'nikke') completeSkin(spine, loadedPlayer.skeleton);
              const firing = record.mode === 'skill' && gameOf(record.selection.character) === 'nikke' ? fireAnimations(data) : null;
              record.animations = firing ? [firing.idle] : playableAnimations(data.animations, record.mode, presentation);
              if (!record.animations.length) throw new Error('这套服装暂无可播放动画');
              record.animation = record.animations[0];
              if (record.mode === 'skill' && !firing) {
                // Random rotation also varies the action unless one was chosen.
                const saved = record.skillAction || (preferences.random && record.animations.length > 1 ?
                  record.animations[Math.floor(Math.random() * record.animations.length)].name : '');
                record.animation = selectSkillAnimation(record.animations, saved, presentation);
                const action = presentation?.skills?.find(action => action.animation === record.animation.name);
                record.animation = composeSkillAttachments(spine, data, record.animation, action?.attachmentLayers);
                if (action?.framing === 'full') layer.classList.add('fit-artwork');
              }
              const combat = firing && record.partner ? combatAnimations(record.partner.skeleton.data, data) : null;
              configureViewports(loadedPlayer, [record.animation], record.mode, presentation, firing ?
                [firing.fire, ...firing.overlays, ...(combat ? [combat.skill, combat.toCover].filter(Boolean) : [])] : []);
              loadedPlayer.animationState.clearTracks();
              loadedPlayer.skeleton.setToSetupPose();
              loadedPlayer.setAnimation(record.animation, record.mode === 'portrait' || isLoopingSkill(record.animation, presentation));
              if (record.mode === 'portrait') {
                record.portraitMotion = queuePortraitMotion(loadedPlayer.animationState, record.animation);
              } else if (combat) {
                const partner = record.partner;
                configureViewports(partner, [combat.coverIdle], 'skill', undefined, [combat.toAim, combat.reload].filter(Boolean));
                partner.animationState.clearTracks();
                partner.skeleton.setToSetupPose();
                partner.setAnimation(combat.coverIdle, true);
                const show = side => {
                  loadedPlayer.dom.classList.toggle('is-hidden', side !== 'aim');
                  partner.dom.classList.toggle('is-hidden', side !== 'cover');
                };
                record.combat = createCombatCycle(combat,
                  { state: partner.animationState, show: () => show('cover') },
                  { state: loadedPlayer.animationState, show: () => show('aim') });
                record.loopSeconds = record.combat.cycleSeconds;
              } else if (firing) {
                queueFireCycle(loadedPlayer.animationState, firing);
              }
              // The camera is laid out against the rail on every frame from here on.
              record.view = paddedView(loadedPlayer.currentViewport);
              if (combat) {
                [loadedPlayer.companionView, record.partner.companionView] =
                  alignedViews(record.view, paddedView(record.partner.currentViewport));
              }
              if (!motionAllowed && record.mode === 'skill') loadedPlayer.animationState.update(record.animation.duration * .35);
              loadedPlayer.animationState.apply(loadedPlayer.skeleton);
              loadedPlayer.skeleton.updateWorldTransform();
              record.configured = true;
              for (const player of [loadedPlayer, record.partner]) {
                if (!player) continue;
                if (document.hidden || !motionAllowed) player.pause();
                else player.play();
              }
            } catch (error) { finish(() => reject(error)); }
          },
          // success runs before rendering. Keep this layer transparent until
          // the renderer has actually drawn its first complete frame.
          draw() {
            if (!record.configured || record.firstFrame || stage.pending !== record || signal.aborted) return;
            record.firstFrame = true;
            clearTimeout(record.loadingTimer);
            clearTimeout(record.timeout);
            if (!stage.present(record)) return;
            layer.classList.add('is-visible');
            if (record.mode === 'skill') {
              skillAnimations = record.animations;
              preferences.skillAction = record.animation.name;
              writePreferences(preferences);
            }
            loadError = '';
            status.hidden = true;
            updatePlayback();
            prefetchOtherMode(record);
            finish(resolve);
          },
          frame(loadedPlayer, delta) {
            // Runs before the camera is set for this frame, paused or not.
            if (record.view) layoutCamera(record, loadedPlayer);
            // The combat loop follows the animation clock, so it pauses with it.
            if (record.combat && delta > 0) record.combat.advance(delta);
            if (stage.active !== record || stage.pending || record.advancing || delta <= 0) return;
            record.elapsed += delta;
            // Paused or hidden pages draw no frames, so rotation waits for them.
            const rotate = performance.now() >= rotationDue;
            if (record.mode === 'portrait') {
              const playingMotion = record.portraitMotion && loadedPlayer.animationState.getCurrent(0)?.animation === record.portraitMotion;
              if (playingMotion) return;
              if (rotate) advance(record, 'rotate');
              else if (preferences.skills && record.elapsed >= 16) advance(record, 'skill');
            } else if (rotate && record.elapsed >= (record.loopSeconds || record.animation.duration)) {
              advance(record, 'rotate');
            } else if (preferences.portraits && record.elapsed >= Math.max((record.loopSeconds || record.animation.duration) + 2, 12)) {
              advance(record, 'portrait');
            }
          },
          error() {
            queueMicrotask(() => {
              const error = new Error('角色动画暂时无法播放');
              if (stage.active === record) showError(record, error.message);
              finish(() => reject(error));
            });
          },
        });
        record.player = instance;
        if (signal.aborted || stage.pending !== record && stage.active !== record) disposePlayer(instance);
      });
    } catch (error) {
      if (disposed || stage.pending !== record || signal.aborted) return;
      showError(record, error instanceof TypeError ? '无法连接角色素材' : error.message);
    } finally {
      clearTimeout(record.timeout);
      clearTimeout(record.loadingTimer);
    }
  }

  function applyDisplay(next) {
    const previous = preferences;
    preferences = next;
    noteHold = false;
    // Turning off must work even if the catalog has no compatible selection.
    if (!enabled()) {
      writePreferences(preferences);
      stop();
      updateUI();
      return;
    }
    try {
      if (catalog) selectCharacter();
    } catch (error) {
      preferences = previous;
      noteHold = true;
      note.textContent = `${error.message}，已保留原设置。`;
      updateUI();
      return;
    }
    writePreferences(preferences);
    // A newly added skill display plays first so the change is visible at once.
    void start(preferences.skills && !previous.skills ? 'skill' : initialMode());
  }
  function updatePreference(changes) {
    preferences = { ...preferences, ...changes };
    noteHold = false;
    writePreferences(preferences);
    updateUI();
  }
  const onPower = () => applyDisplay(withDisplay(preferences, power.checked ? 'on' : 'off'));
  const onDisplay = event => applyDisplay(withDisplay(preferences, event.target.value));
  const onPerson = event => { updatePreference({ random: event.target.value === 'random' }); scheduleRotation(); };
  const onRotation = () => { updatePreference({ rotation: Number(rotationPicker.value) }); scheduleRotation(); };
  const onGame = () => {
    const games = gameInputs.filter(input => input.checked).map(input => input.value);
    if (!games.length) { updateUI(); return; }
    updatePreference({ games });
    // A person from a game that was just turned off makes way at once.
    if (selection && !games.includes(gameOf(selection.character)) && catalog) {
      try {
        selectCharacter(true);
        void start();
      } catch (error) {
        noteHold = true;
        note.textContent = `${error.message}。`;
        updateUI();
      }
    }
  };
  const onShuffle = () => { selectCharacter(true); void start(); };
  const onPick = () => {
    const character = availableCharacters(catalog, preferences).find(item => item.costumes.some(costume => costumeKey(costume) === picker.value));
    if (!character) return;
    preferences.characterId = character.id;
    preferences.costumeKey = picker.value;
    preferences.random = false;
    selectCharacter();
    void start();
  };
  const onRetry = () => { void start(mode); };
  const onSkillPick = () => {
    preferences.skillAction = skillPicker.value;
    writePreferences(preferences);
    void start('skill');
  };
  const onFallback = () => {
    if (!catalog.characters.some(character => character.id === LOCAL_FALLBACK_CHARACTER.id &&
      character.costumes.some(costume => costumeKey(costume) === costumeKey(LOCAL_FALLBACK_CHARACTER.costumes[0])))) {
      catalog = { ...catalog, characters: [LOCAL_FALLBACK_CHARACTER,
        ...catalog.characters.filter(character => character.id !== LOCAL_FALLBACK_CHARACTER.id)] };
    }
    preferences = { ...preferences, random: false, portraits: true, skills: false,
      characterId: LOCAL_FALLBACK_CHARACTER.id, costumeKey: costumeKey(LOCAL_FALLBACK_CHARACTER.costumes[0]) };
    selectCharacter();
    void start();
  };
  const onPause = () => { motionAllowed = !motionAllowed; updatePlayback(); };
  const onMotionChange = () => { motionAllowed = !reducedMotion.matches; updatePlayback(); };
  const onDesktopChange = () => { if (desktop.matches) void start(); else { stop(); updateUI(); } };
  const onStorage = event => {
    if (![PREFERENCES_KEY, LEGACY_KEY, null].includes(event.key)) return;
    preferences = readPreferences();
    if (catalog) selectCharacter(false, true);
    void start();
  };
  retry.addEventListener('click', onRetry);
  fallback.addEventListener('click', onFallback);
  menuRetry.addEventListener('click', onRetry);
  menuFallback.addEventListener('click', onFallback);
  shuffle.addEventListener('click', onShuffle);
  pause.addEventListener('click', onPause);
  power.addEventListener('change', onPower);
  displayInputs.forEach(input => input.addEventListener('change', onDisplay));
  personInputs.forEach(input => input.addEventListener('change', onPerson));
  rotationPicker.addEventListener('change', onRotation);
  gameInputs.forEach(input => input.addEventListener('change', onGame));
  picker.addEventListener('change', onPick);
  skillPicker.addEventListener('change', onSkillPick);
  document.addEventListener('visibilitychange', updatePlayback);
  reducedMotion.addEventListener('change', onMotionChange);
  desktop.addEventListener('change', onDesktopChange);
  window.addEventListener('storage', onStorage);

  const catalogController = new AbortController();
  const catalogTimeout = setTimeout(() => catalogController.abort(), 15000);
  // Every registered game loads its own catalog and fails on its own. Brown
  // Dust 2 falls back to the bundled portrait when its catalog is unreachable.
  const loadGame = async game => {
    const [data, reference] = await Promise.all([
      fetchResource(game.catalogUrl, catalogController.signal).then(response => response.json()),
      game.presentationsUrl ? fetchResource(game.presentationsUrl, catalogController.signal, 'no-cache')
        .then(response => response.json()).catch(() => ({})) : null,
    ]);
    if (!/^[a-f0-9]{12,40}$/.test(data.commit) || !Array.isArray(data.characters) || !data.characters.length) {
      throw new Error('角色索引不完整');
    }
    return { data, reference };
  };
  Promise.allSettled(GAMES.map(loadGame)).then(results => {
    if (disposed) return;
    const games = {};
    const characters = [];
    results.forEach((result, index) => {
      const game = GAMES[index];
      if (result.status === 'rejected') {
        if (game.id !== 'bd2') return;
        games.bd2 = { assetBase: game.assetBase, commit: LOCAL_FALLBACK_COMMIT };
        characters.push({ ...LOCAL_FALLBACK_CHARACTER, game: 'bd2' });
        return;
      }
      const { data, reference } = result.value;
      if (reference) presentations = reference;
      games[game.id] = { assetBase: game.assetBase, commit: data.commit };
      characters.push(...data.characters.map(character => {
        if (!reference) return { ...character, game: game.id };
        const costumes = character.costumes.map(costume => {
          const presentation = presentationForCostume(reference, costume);
          return { ...costume, label: presentation?.label || costume.label };
        });
        const named = character.costumes.map(costume => presentationForCostume(reference, costume)).find(preset => preset?.name);
        return { ...character, game: game.id, name: named?.name || character.name, costumes };
      }));
    });
    // The same exclusion rules apply to the offline fallback.
    catalog = { games, characters: characters.filter(character => !isExcludedCharacter(character)) };
    if (results.every(result => result.status === 'rejected')) {
      // Only the bundled portrait is left.
      preferences.portraits ||= preferences.skills;
      preferences.skills = false;
    }
    try {
      selectCharacter(preferences.random);
    } catch {
      // The chosen games may all be unavailable; fall back to what loaded.
      preferences.games = Object.keys(games);
      selectCharacter(preferences.random);
    }
    void start();
  }).finally(() => clearTimeout(catalogTimeout));

  currentCompanion = {
    destroy() {
      disposed = true;
      catalogController.abort();
      clearTimeout(catalogTimeout);
      stop();
      clearAssets();
      toggle.removeEventListener('click', onToggle);
      close.removeEventListener('click', onClose);
      retry.removeEventListener('click', onRetry);
      fallback.removeEventListener('click', onFallback);
      menuRetry.removeEventListener('click', onRetry);
      menuFallback.removeEventListener('click', onFallback);
      shuffle.removeEventListener('click', onShuffle);
      pause.removeEventListener('click', onPause);
      power.removeEventListener('change', onPower);
      displayInputs.forEach(input => input.removeEventListener('change', onDisplay));
      personInputs.forEach(input => input.removeEventListener('change', onPerson));
      rotationPicker.removeEventListener('change', onRotation);
      gameInputs.forEach(input => input.removeEventListener('change', onGame));
      picker.removeEventListener('change', onPick);
      skillPicker.removeEventListener('change', onSkillPick);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('visibilitychange', updatePlayback);
      reducedMotion.removeEventListener('change', onMotionChange);
      desktop.removeEventListener('change', onDesktopChange);
      window.removeEventListener('storage', onStorage);
      root.replaceChildren();
      delete document.body.dataset.companion;
      delete root.dataset.state;
      delete root.dataset.enabled;
      delete root.dataset.mode;
      currentCompanion = undefined;
    },
  };
  updateUI();
  return currentCompanion;
}
