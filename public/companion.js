import { PREFERENCES_KEY, LEGACY_KEY, ROTATION_CHOICES, displayOf, withDisplay, costumeKey, gameOf,
  availableCharacters, paddedView,
  chooseCharacter, playableAnimations, configureViewports, presentationForCostume,
  isLoopingSkill, selectSkillAnimation, completeSkin } from './companion-model.js';
import { createCompanionStage } from './companion-stage.js';
import { LOCAL_FALLBACK_CHARACTER, LOCAL_FALLBACK_COMMIT } from './companion-fallback.js';
import { isExcludedCharacter } from './companion-exclusions.js';
import { composeSkillAttachments } from './companion-composition.js';
import { queuePortraitMotion } from './companion-portrait.js';
import { GAMES, gameById } from './companion-games.js';
import { fireAnimations, queueFireCycle } from './companion-fire.js';
import { combatAnimations, createCombatCycle } from './companion-combat.js';
import { createLive2DPlayer } from './companion-live2d-player.js';
import { readExternalSkeleton, performanceMenu, createPerformance } from './companion-performance-player.js';
import { createDatingTour } from './companion-dating.js';
import { createPaintingPlayer } from './companion-painting-player.js';
import { loadRuntime, loadSpine38, loadLive2DRuntime } from './companion-runtimes.js';
import { readPreferences, writePreferences, mediaQuery, disposePlayer, supportsWebGL } from './companion-browser.js';
import { fetchResource, withAbort, partFor, loadCharacter } from './companion-loaders.js';
import { railSpace, alignedViews, spawnPartner, layoutCamera } from './companion-camera.js';

let currentCompanion;

// The skill menu entry that switches a Brown Dust 2 costume to its 有缘之客 scene.
const DATING_ACTION = 'dating';
// Seconds a 有缘之客 scene plays in 「轮流」 before it may give way to the portrait.
const SCENE_VISIT = 30;
const datingEntry = () => ({ name: DATING_ACTION, label: '有缘之客' });
// A menu while the skill display shows a scene: the skills seen last for this
// costume, or a single entry back to its default skill.
const skillsBack = () => ({ name: '', label: '技能动作' });

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
  // The skill menu last built for each costume, kept for its 有缘之客 scene.
  const skillMenus = new Map();
  // How far each costume's 有缘之客 scene got (its stage and the reactions of
  // it already played), while the page is open.
  const sceneProgress = new Map();
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
        option.textContent = animation.label || configured.find(action => action.animation === animation.name)?.label || `动作${index + 1}`;
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
    // A Live2D model or dynamic painting serves both displays, so both share one download.
    const runtime = partFor(characterSelection, requestedMode)?.runtime;
    const key = costumeKey(characterSelection.costume) + ':' + (runtime === 'live2d' || runtime === '3.8' ? runtime : requestedMode);
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
      // A costume with a 有缘之客 scene shows it as its action display during
      // random rotation, and when picked from the menu of a fixed person.
      assetMode: nextMode === 'skill' && selection.costume.dating &&
        (preferences.random || preferences.skillAction === DATING_ACTION) ? 'dating' : nextMode,
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
      if (partFor(record.selection, record.mode)?.runtime === 'live2d') {
        await startLive2D(record, signal);
        return;
      }
      if (partFor(record.selection, record.mode)?.runtime === '3.8') {
        await startPainting(record, signal);
        return;
      }
      // NIKKE's combat loop also needs the cover skeleton.
      const coverPart = record.mode === 'skill' && gameOf(record.selection.character) === 'nikke' ? record.selection.costume.cover : null;
      const [spine, assets, coverSpine, coverAssets] = await withAbort(Promise.all([
        loadRuntime(partFor(record.selection, record.assetMode)?.runtime), assetsFor(record.selection, record.assetMode),
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
          ...(partFor(record.selection, record.assetMode)?.skin ? { skin: partFor(record.selection, record.assetMode).skin } : {}),
          success(loadedPlayer) {
            if (stage.pending !== record || signal.aborted || disposed) return;
            try {
              record.player = loadedPlayer;
              const presentation = presentationForCostume(presentations, record.selection.costume);
              const data = loadedPlayer.skeleton.data;
              if (record.assetMode === 'dating') {
                // A scene left between two steps resumes there on its next visit.
                const scene = costumeKey(record.selection.costume);
                record.performance = createDatingTour({ spine, player: loadedPlayer, tracks: record.selection.costume.dating.tracks,
                  resume: sceneProgress.get(scene), onProgress: progress => sceneProgress.set(scene, progress) });
                if (!record.performance) throw new Error('有缘之客暂时无法播放');
                record.animations = skillMenus.get(costumeKey(record.selection.costume)) || [skillsBack(), datingEntry()];
                record.animation = { ...datingEntry(), duration: record.performance.duration };
                record.loopSeconds = record.performance.duration;
                record.view = loadedPlayer.companionView = record.performance.view();
                record.configured = true;
                if (document.hidden || !motionAllowed) loadedPlayer.pause();
                else loadedPlayer.play();
                return;
              }
              if (gameOf(record.selection.character) === 'nikke') completeSkin(spine, loadedPlayer.skeleton);
              const firing = record.mode === 'skill' && gameOf(record.selection.character) === 'nikke' ? fireAnimations(data) : null;
              record.animations = firing ? [firing.idle] : playableAnimations(data.animations, record.mode, presentation);
              if (!record.animations.length) throw new Error('这套服装暂无可播放动画');
              record.animation = record.animations[0];
              const externals = new Map();
              if (record.mode === 'skill' && assets.performances) {
                for (const external of assets.externals) {
                  const read = readExternalSkeleton(spine, loadedPlayer.context, external);
                  if (read) externals.set(external.source, read);
                }
                const durationOf = (name, source) => (source ? externals.get(source)?.data : data)?.findAnimation(name)?.duration;
                record.animations = performanceMenu(assets.performances, record.animations, durationOf,
                  name => presentation?.skills?.find(action => action.animation === name)?.label);
              }
              if (record.mode === 'skill' && !firing) {
                // Random rotation also varies the action unless one was chosen.
                let saved = record.skillAction || (preferences.random && record.animations.length > 1 ?
                  record.animations[Math.floor(Math.random() * record.animations.length)].name : '');
                // A loop saved before its layered version existed picks that version.
                saved = record.animations.find(animation => animation.replaces === saved)?.name || saved;
                record.animation = selectSkillAnimation(record.animations, saved, presentation);
                if (!record.animation.performance) {
                  const action = presentation?.skills?.find(action => action.animation === record.animation.name);
                  record.animation = composeSkillAttachments(spine, data, record.animation, action?.attachmentLayers);
                  if (action?.framing === 'full') layer.classList.add('fit-artwork');
                }
                // The scene is offered after the choice above, so a fixed person only shows it when picked.
                if (record.selection.costume.dating) record.animations = [...record.animations, datingEntry()];
                skillMenus.set(costumeKey(record.selection.costume), record.animations);
              }
              if (record.animation.performance) {
                record.performance = createPerformance({ spine, player: loadedPlayer, definitions: assets.performances,
                  name: record.animation.name, externals, premultipliedAlpha: assets.premultipliedAlpha });
                if (!record.performance) throw new Error('技能演出暂时无法播放');
                record.animation = { ...record.animation, duration: record.performance.duration };
                record.loopSeconds = record.performance.duration;
                if (!motionAllowed) record.performance.seek(record.performance.duration * .35);
                // The camera follows the performance from shot to shot.
                record.view = loadedPlayer.companionView = record.performance.view();
                record.configured = true;
                if (document.hidden || !motionAllowed) loadedPlayer.pause();
                else loadedPlayer.play();
                return;
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
          // After the pose, before drawing: a scene hides its letterbox here.
          update(loadedPlayer) { record.performance?.update?.(loadedPlayer.skeleton); },
          // success runs before rendering. Keep this layer transparent until
          // the renderer has actually drawn its first complete frame.
          draw(loadedPlayer) {
            // Performance layers draw over the player's own (hidden) skeleton.
            if (record.performance) record.performance.draw(loadedPlayer.sceneRenderer);
            if (!record.configured || record.firstFrame || stage.pending !== record || signal.aborted) return;
            record.firstFrame = true;
            if (!reveal(record, () => {
              if (record.mode !== 'skill') return;
              skillAnimations = record.animations;
              preferences.skillAction = record.animation.name;
              writePreferences(preferences);
            })) return;
            finish(resolve);
          },
          frame(loadedPlayer, delta) {
            // A performance moves on with the animation clock and picks the camera of its current shot.
            const wrapped = record.performance ? record.performance.advance(delta) : false;
            if (record.performance && record.performance.view() !== loadedPlayer.companionView) {
              loadedPlayer.companionView = record.performance.view();
              loadedPlayer.companionRailKey = undefined;
            }
            // Runs before the camera is set for this frame, paused or not.
            if (record.view) layoutCamera(record, loadedPlayer);
            // The combat loop follows the animation clock, so it pauses with it.
            if (record.combat && delta > 0) record.combat.advance(delta);
            const loop = record.loopSeconds || record.animation?.duration;
            handOver(record, delta, record.performance ? {
              // A layered loop breaks between two plays, a scene between two
              // of its steps. A scene breaks every few seconds, so it stays a
              // little longer.
              atBreak: () => wrapped, visit: record.assetMode === 'dating' ? SCENE_VISIT : 12,
            } : {
              // The portrait finishes a queued motion first; a plain loop
              // breaks once a whole play is over.
              busy: () => record.portraitMotion && loadedPlayer.animationState.getCurrent(0)?.animation === record.portraitMotion,
              atBreak: () => record.elapsed >= loop, visit: Math.max(loop + 2, 12),
            });
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

  // Azur Lane: the portrait loops the model's idle; the action display plays
  // its reactions with a short idle in between. Each model is its own canvas.
  async function startLive2D(record, signal) {
    const [PIXI, assets] = await withAbort(Promise.all([loadLive2DRuntime(), assetsFor(record.selection, record.mode)]), signal);
    if (signal.aborted || stage.pending !== record || disposed) return;
    const { layer } = record;
    const player = await createLive2DPlayer({
      PIXI, layer, settings: assets.settings, plan: assets.plan, blobs: assets.blobs, mode: record.mode,
      space: () => railSpace(layer), frame: delta => ownCanvasFrame(record, delta),
    });
    record.player = player;
    // The model kept loading after this record was replaced or released.
    if (signal.aborted || stage.pending !== record || disposed) { disposePlayer(player); return; }
    reveal(record);
  }

  // An Azur Lane dynamic painting on its own canvas, like Live2D: the loop as
  // a portrait, and for the few with reactions, those as the action display.
  async function startPainting(record, signal) {
    const [spine, assets] = await withAbort(Promise.all([loadSpine38(), assetsFor(record.selection, record.mode)]), signal);
    if (signal.aborted || stage.pending !== record || disposed) return;
    const { layer } = record;
    const player = createPaintingPlayer({
      spine, layer, layers: assets.layers, mode: record.mode, actions: partFor(record.selection, record.mode)?.actions,
      space: () => railSpace(layer), frame: delta => ownCanvasFrame(record, delta),
    });
    record.player = player;
    reveal(record);
  }

  // Live2D models and paintings break between two reactions.
  function ownCanvasFrame(record, delta) {
    handOver(record, delta, { atBreak: () => record.player?.betweenActions });
  }

  // A loaded display replaces the one shown so far. onShown runs once it is
  // on stage; false when the record lost its place meanwhile.
  function reveal(record, onShown) {
    clearTimeout(record.loadingTimer);
    clearTimeout(record.timeout);
    if (!stage.present(record)) return false;
    record.layer.classList.add('is-visible');
    onShown?.();
    loadError = '';
    status.hidden = true;
    updatePlayback();
    prefetchOtherMode(record);
    return true;
  }

  // Every display hands the stage on only at a natural break. The portrait
  // moves to the action display after 16 s unless busy() (a queued motion);
  // the action display returns after visit seconds, and only while atBreak().
  // Random rotation moves to the next person at the first break once due.
  // Paused or hidden pages draw no frames, so rotation waits for them.
  function handOver(record, delta, { busy = () => false, atBreak = () => true, visit = 12 } = {}) {
    if (stage.active !== record || stage.pending || record.advancing || delta <= 0) return;
    record.elapsed += delta;
    const rotate = performance.now() >= rotationDue;
    if (record.mode === 'portrait') {
      if (busy()) return;
      if (rotate) advance(record, 'rotate');
      else if (preferences.skills && record.elapsed >= 16) advance(record, 'skill');
    } else if (atBreak()) {
      if (rotate) advance(record, 'rotate');
      else if (preferences.portraits && record.elapsed >= visit) advance(record, 'portrait');
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
    const [data, reference, performances] = await Promise.all([
      fetchResource(game.catalogUrl, catalogController.signal).then(response => response.json()),
      game.presentationsUrl ? fetchResource(game.presentationsUrl, catalogController.signal, 'no-cache')
        .then(response => response.json()).catch(() => ({})) : null,
      // Without its performances a skill still plays its own animations.
      game.performancesUrl ? fetchResource(game.performancesUrl, catalogController.signal, 'no-cache')
        .then(response => response.json()).catch(() => undefined) : undefined,
    ]);
    if (!/^[a-f0-9]{12,40}$/.test(data.commit) || !Array.isArray(data.characters) || !data.characters.length) {
      throw new Error('角色索引不完整');
    }
    return { data, reference, performances };
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
      const { data, reference, performances } = result.value;
      if (reference) presentations = reference;
      games[game.id] = { assetBase: game.assetBase, commit: data.commit, performances: performances?.costumes,
        paintingCommit: data.paintingCommit };
      // A costume's 有缘之客 scene, keyed like the presets by its portrait skeleton.
      const scene = costume => {
        const found = performances?.dating?.[costumeKey(costume).match(/(?:^|\/)(char\d{6})\.skel$/i)?.[1]?.toLowerCase()];
        return found ? { dating: { skeleton: found.skeleton + '.skel', atlas: found.skeleton + '.atlas', tracks: found.tracks } } : {};
      };
      characters.push(...data.characters.map(character => {
        if (!reference) return { ...character, game: game.id };
        const costumes = character.costumes.map(costume => {
          const presentation = presentationForCostume(reference, costume);
          return { ...costume, label: presentation?.label || costume.label, ...scene(costume) };
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
