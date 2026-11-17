import { PREFERENCES_KEY, LEGACY_KEY, normalizePreferences, costumeKey, availableCharacters,
  chooseCharacter, atlasPages, playableAnimations, configureViewports, presentationForCostume,
  isLoopingSkill, selectSkillAnimation } from './companion-model.js';
import { createCompanionStage } from './companion-stage.js';
import { composeSkillAttachments } from './companion-composition.js';
import { queuePortraitMotion } from './companion-portrait.js';
const RUNTIME_JS = '/vendor/spine/spine-player-4.1.56.js';
const RUNTIME_CSS = '/vendor/spine/spine-player-4.1.56.css';
const CATALOG_URL = '/companion/catalog.json';
const PRESENTATIONS_URL = '/companion/gamekee-presets.json';
const ASSET_BASE = 'https://raw.githubusercontent.com/myssal/Brown-Dust-2-Asset/';

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

async function loadCharacter(catalog, selection, mode, signal) {
  const part = mode === 'skill' ? selection.costume.cutscene : selection.costume.idle;
  if (!part) throw new Error('这套服装没有对应的动画');
  const local = mode === 'portrait' && part.skeleton === 'spine/char/char000101/char000101.skel';
  const skelUrl = local ? '/companion/assets/char000101.skel' : ASSET_BASE + catalog.commit + '/' + part.skeleton;
  const atlasUrl = local ? '/companion/assets/char000101.atlas' : ASSET_BASE + catalog.commit + '/' + part.atlas;
  const [skeleton, atlas] = await Promise.all([
    fetchResource(skelUrl, signal).then(response => response.blob()),
    fetchResource(atlasUrl, signal).then(response => response.text()),
  ]);
  const baseUrl = new URL(atlasUrl, location.href);
  const textureUrls = atlasPages(atlas).map(page => new URL(page, baseUrl).href);
  const rawDataURIs = Object.fromEntries(await Promise.all([
    [skelUrl, skeleton], [atlasUrl, new Blob([atlas], { type: 'text/plain' })],
    ...await Promise.all(textureUrls.map(async url => [url, await (await fetchResource(url, signal)).blob()])),
  ].map(async ([url, blob]) => [url, await readDataURI(blob, signal)])));
  // Runtime joins relative local atlas paths without expanding them to location.origin.
  if (local) {
    for (const url of textureUrls) rawDataURIs[new URL(url).pathname] = rawDataURIs[url];
  }
  return { skelUrl, atlasUrl, rawDataURIs, premultipliedAlpha: /^pma:\s*true\s*$/m.test(atlas) };
}

export function initCompanion() {
  if (currentCompanion) return currentCompanion;
  const root = document.getElementById('companion-root');
  if (!root) return undefined;
  const option = (key, title, description) => `
    <label class="companion-option"><span><strong>${title}</strong><small>${description}</small></span>
      <input type="checkbox" role="switch" data-option="${key}" aria-label="${title}"></label>`;
  root.innerHTML = `
    <aside class="companion-rail" aria-label="角色陪伴" hidden>
      <div class="companion-player" aria-hidden="true"></div>
      <div class="companion-status" role="status" aria-live="polite" hidden>
        <span class="companion-status-text"></span>
        <button class="companion-retry" type="button" hidden>重试</button>
        <button class="companion-fallback" type="button" hidden>使用本地立绘</button>
      </div>
      <div class="companion-caption" hidden>
        <span class="companion-name"></span><span class="companion-label"></span><span class="companion-caption-mode"></span>
      </div>
    </aside>
    <div class="companion-controls">
    <button class="companion-toggle" type="button" aria-expanded="false" aria-controls="companion-menu" aria-label="角色设置">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="m12 3 2.5 5.5 6 1-4.4 4.3 1 6.2-5.1-2.8-5.1 2.8 1-6.2L3.5 9.5l6-1L12 3Z"/>
      </svg><span>角色设置</span><span class="companion-indicator" aria-hidden="true"></span>
    </button>
    <section id="companion-menu" class="companion-menu" role="region" aria-label="角色设置" hidden>
      <header class="companion-menu-header"><strong>角色陪伴</strong><button class="companion-menu-close" type="button" aria-label="关闭角色设置">×</button></header>
      <div class="companion-menu-current"><strong class="companion-current-name">正在读取角色…</strong><span class="companion-current-label"></span></div>
      ${option('random', '随机人物', '每次打开页面，更换一位人物与服装')}
      ${option('portraits', '展示立绘', '播放人物的待机动画')}
      ${option('skills', '展示技能', '与立绘同时开启时轮流展示')}
      ${option('info', '人物信息', '在画面下方显示姓名与服装')}
      <label class="companion-character-picker"><span>指定人物与服装 · 选择后关闭随机</span><select aria-label="指定人物与服装" disabled><option>正在读取角色…</option></select></label>
      <label class="companion-character-picker companion-skill-picker" hidden><span>技能动作</span><select aria-label="技能动作" disabled><option>载入技能后可选择</option></select></label>
      <div class="companion-menu-actions"><button class="companion-shuffle" type="button" disabled>换一位</button><button class="companion-pause" type="button" disabled>暂停动画</button></div>
      <button class="companion-hide" type="button">关闭角色</button>
      <small class="companion-menu-note" role="status" aria-live="polite"></small>
      <div class="companion-menu-recovery companion-menu-actions" hidden><button class="companion-menu-retry" type="button">重试切换</button><button class="companion-menu-fallback" type="button">使用本地立绘</button></div>
      <small class="companion-menu-note">仅在此浏览器记住设置；新角色首次加载需要联网。</small>
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
  const caption = root.querySelector('.companion-caption');
  const currentName = root.querySelector('.companion-current-name');
  const currentLabel = root.querySelector('.companion-current-label');
  const picker = root.querySelector('[aria-label="指定人物与服装"]');
  const skillPickerLabel = root.querySelector('.companion-skill-picker');
  const skillPicker = root.querySelector('[aria-label="技能动作"]');
  const shuffle = root.querySelector('.companion-shuffle');
  const pause = root.querySelector('.companion-pause');
  const hide = root.querySelector('.companion-hide');
  const note = root.querySelector('.companion-menu-note');
  const recovery = root.querySelector('.companion-menu-recovery');
  const menuRetry = root.querySelector('.companion-menu-retry');
  const menuFallback = root.querySelector('.companion-menu-fallback');
  const switches = [...root.querySelectorAll('[data-option]')];

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
  const assetCache = new Map();
  const enabled = () => preferences.portraits || preferences.skills;
  const initialMode = () => preferences.portraits ? 'portrait' : 'skill';
  const stage = createCompanionStage({
    dispose(record) {
      clearTimeout(record.timeout);
      clearTimeout(record.loadingTimer);
      disposePlayer(record.player);
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
    document.body.dataset.companion = visible ? 'on' : 'off';
    root.dataset.enabled = String(enabled());
    rail.hidden = !visible;
    caption.hidden = !active || !preferences.info;
    switches.forEach(input => { input.checked = preferences[input.dataset.option]; });
    shuffle.disabled = !catalog;
    pause.disabled = !active;
    hide.disabled = !enabled();
    pause.textContent = motionAllowed ? '暂停动画' : '播放动画';
    pause.setAttribute('aria-pressed', String(!motionAllowed));
    skillPickerLabel.hidden = !preferences.skills;
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
    if (selection) {
      currentName.textContent = selection.character.name;
      currentLabel.textContent = selection.costume.label;
    }
    if (active) {
      caption.querySelector('.companion-name').textContent = active.selection.character.name;
      caption.querySelector('.companion-label').textContent = active.selection.costume.label;
      caption.querySelector('.companion-caption-mode').textContent = active.mode === 'skill' ? '技能' : '立绘';
      root.dataset.mode = active.mode;
    }
    if (catalog) {
      const signature = `${preferences.portraits}:${preferences.skills}`;
      if (signature !== pickerSignature) {
        pickerSignature = signature;
        picker.replaceChildren();
        for (const character of availableCharacters(catalog, preferences)) {
          const group = document.createElement('optgroup');
          group.label = character.name;
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
    if (!enabled()) {
      root.dataset.state = 'off';
      note.textContent = '立绘和技能均已关闭，导航使用完整宽度。';
    } else if (!desktop.matches) {
      root.dataset.state = 'compact';
      note.textContent = '设置已记住，窗口宽度达到 1280px 时展示角色。';
    } else if (loadError) {
      root.dataset.state = 'error';
      note.textContent = active ? `${loadError}，已保留当前画面，可重试切换。` : loadError;
    } else if (stage.pending) {
      root.dataset.state = active ? 'switching' : 'loading';
      note.textContent = statusText.textContent;
    } else if (!motionAllowed) {
      root.dataset.state = 'ready';
      note.textContent = reducedMotion.matches ? '已按系统偏好暂停，可点击播放动画。' : '动画已暂停。';
    } else {
      root.dataset.state = active ? 'ready' : 'off';
      note.textContent = preferences.portraits && preferences.skills ? '立绘与技能轮流展示。' :
        (preferences.random ? '刷新页面时随机换人，也可以随时点「换一位」。' : '已固定当前人物与服装，刷新后保持。');
    }
  }

  function updatePlayback() {
    const paused = document.hidden || !motionAllowed;
    for (const record of [stage.active, stage.pending, stage.outgoing]) {
      if (!record?.player) continue;
      if (paused) record.player.pause();
      else record.player.play();
    }
    if (stage.active) root.dataset.paused = String(paused);
    updateUI();
  }

  function clearAssets() {
    for (const task of assetCache.values()) task.controller.abort();
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
    caption.hidden = true;
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

  function selectCharacter(redraw = false, preserveSkillAction = false) {
    if (!catalog) return;
    const previous = selection ? costumeKey(selection.costume) : preferences.costumeKey;
    selection = chooseCharacter(catalog, preferences, redraw);
    if (previous !== costumeKey(selection.costume)) {
      if (!preserveSkillAction) preferences.skillAction = '';
      skillAnimations = [];
      skillPickerSignature = undefined;
      clearAssets();
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
    const record = {
      layer, selection, mode: nextMode, skillAction: preferences.skillAction,
      controller: new AbortController(), elapsed: 0, advancing: false,
    };
    stage.begin(record);
    host.append(layer);
    const signal = record.controller.signal;
    loadError = '';
    status.hidden = true;
    statusText.textContent = `正在准备${record.selection.character.name}的${record.mode === 'skill' ? '技能' : '立绘'}…`;
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
      const [spine, assets] = await withAbort(Promise.all([
        loadRuntime(), assetsFor(record.selection, record.mode),
      ]), signal);
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
          success(loadedPlayer) {
            if (stage.pending !== record || signal.aborted || disposed) return;
            try {
              record.player = loadedPlayer;
              const presentation = presentationForCostume(presentations, record.selection.costume);
              const data = loadedPlayer.skeleton.data;
              record.animations = playableAnimations(data.animations, record.mode, presentation);
              if (!record.animations.length) throw new Error('这套服装暂无可播放动画');
              record.animation = record.animations[0];
              if (record.mode === 'skill') {
                record.animation = selectSkillAnimation(record.animations, record.skillAction, presentation);
                const action = presentation?.skills?.find(action => action.animation === record.animation.name);
                record.animation = composeSkillAttachments(spine, data, record.animation, action?.attachmentLayers);
                if (action?.framing === 'full') layer.classList.add('fit-artwork');
              }
              configureViewports(loadedPlayer, [record.animation], record.mode, presentation);
              loadedPlayer.animationState.clearTracks();
              loadedPlayer.skeleton.setToSetupPose();
              loadedPlayer.setAnimation(record.animation, record.mode === 'portrait' || isLoopingSkill(record.animation, presentation));
              if (record.mode === 'portrait') {
                record.portraitMotion = queuePortraitMotion(loadedPlayer.animationState, record.animation);
              }
              const view = loadedPlayer.currentViewport;
              const aspect = (view.width + view.padLeft + view.padRight) / (view.height + view.padTop + view.padBottom);
              if (Number.isFinite(aspect) && aspect > 0) layer.style.setProperty('--companion-art-aspect', String(aspect));
              if (!motionAllowed && record.mode === 'skill') loadedPlayer.animationState.update(record.animation.duration * .35);
              loadedPlayer.animationState.apply(loadedPlayer.skeleton);
              loadedPlayer.skeleton.updateWorldTransform();
              record.configured = true;
              if (document.hidden || !motionAllowed) loadedPlayer.pause();
              else loadedPlayer.play();
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
            if (stage.active !== record || stage.pending || record.advancing || delta <= 0) return;
            record.elapsed += delta;
            if (record.mode === 'portrait') {
              const playingMotion = record.portraitMotion && loadedPlayer.animationState.getCurrent(0)?.animation === record.portraitMotion;
              if (preferences.skills && record.elapsed >= 16 && !playingMotion) {
                record.advancing = true;
                queueMicrotask(() => { if (stage.active === record) void start('skill'); });
              }
            } else if (preferences.portraits && record.elapsed >= Math.max(record.animation.duration + 2, 12)) {
              record.advancing = true;
              queueMicrotask(() => { if (stage.active === record) void start('portrait'); });
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

  const onHide = () => {
    preferences = { ...preferences, portraits: false, skills: false };
    writePreferences(preferences);
    stop();
    updateUI();
  };
  const onOption = event => {
    const key = event.target.dataset.option;
    const previous = preferences;
    preferences = { ...preferences, [key]: event.target.checked };
    if (key === 'portraits' || key === 'skills') {
      // Closing must work even if the catalog has no compatible selection.
      if (!enabled()) { onHide(); return; }
      try {
        if (catalog) selectCharacter();
      } catch (error) {
        preferences = previous;
        updateUI();
        note.textContent = `${error.message}，已保留原设置。`;
        return;
      }
      writePreferences(preferences);
      void start(key === 'skills' && preferences.skills ? 'skill' : initialMode());
    } else {
      writePreferences(preferences);
      updateUI();
    }
  };
  const onShuffle = () => { selectCharacter(true); void start(); };
  const onPick = () => {
    const character = catalog.characters.find(item => item.costumes.some(costume => costumeKey(costume) === picker.value));
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
    preferences = { ...preferences, random: false, portraits: true, skills: false,
      characterId: '0001', costumeKey: 'spine/char/char000101/char000101.skel' };
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
  hide.addEventListener('click', onHide);
  picker.addEventListener('change', onPick);
  skillPicker.addEventListener('change', onSkillPick);
  switches.forEach(input => input.addEventListener('change', onOption));
  document.addEventListener('visibilitychange', updatePlayback);
  reducedMotion.addEventListener('change', onMotionChange);
  desktop.addEventListener('change', onDesktopChange);
  window.addEventListener('storage', onStorage);

  const catalogController = new AbortController();
  const catalogTimeout = setTimeout(() => catalogController.abort(), 15000);
  Promise.all([
    fetchResource(CATALOG_URL, catalogController.signal).then(response => response.json()),
    fetchResource(PRESENTATIONS_URL, catalogController.signal, 'no-cache').then(response => response.json()).catch(() => ({})),
  ]).then(([data, reference]) => {
    if (disposed) return;
    if (!/^[a-f0-9]{12,40}$/.test(data.commit) || !Array.isArray(data.characters) || !data.characters.length) {
      throw new Error('角色索引不完整');
    }
    presentations = reference;
    catalog = { ...data, characters: data.characters.map(character => {
      const costumes = character.costumes.map(costume => {
        const presentation = presentationForCostume(presentations, costume);
        return { ...costume, label: presentation?.label || costume.label };
      });
      const named = character.costumes.map(costume => presentationForCostume(presentations, costume)).find(preset => preset?.name);
      return { ...character, name: named?.name || character.name, costumes };
    }) };
    selectCharacter(preferences.random);
    void start();
  }).catch(() => {
    if (disposed) return;
    // Keep the original offline character available even if the catalog is unavailable.
    catalog = { commit: '424622b8c4fd', characters: [{ id: '0001', name: '拉德尔', costumes: [{ label: '草药猎人',
      idle: { skeleton: 'spine/char/char000101/char000101.skel', atlas: 'spine/char/char000101/char000101.atlas' } }] }] };
    preferences.portraits ||= preferences.skills;
    preferences.skills = false;
    selectCharacter();
    void start();
  }).finally(() => clearTimeout(catalogTimeout));

  currentCompanion = {
    destroy() {
      disposed = true;
      catalogController.abort();
      clearTimeout(catalogTimeout);
      stop();
      assetCache.clear();
      toggle.removeEventListener('click', onToggle);
      close.removeEventListener('click', onClose);
      retry.removeEventListener('click', onRetry);
      fallback.removeEventListener('click', onFallback);
      menuRetry.removeEventListener('click', onRetry);
      menuFallback.removeEventListener('click', onFallback);
      shuffle.removeEventListener('click', onShuffle);
      pause.removeEventListener('click', onPause);
      hide.removeEventListener('click', onHide);
      picker.removeEventListener('change', onPick);
      skillPicker.removeEventListener('change', onSkillPick);
      switches.forEach(input => input.removeEventListener('change', onOption));
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
