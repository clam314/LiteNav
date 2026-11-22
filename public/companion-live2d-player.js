// Draws one Live2D model with PixiJS and pixi-live2d-display (Cubism 4
// framework on Cubism Core 5). The player mirrors the parts of SpinePlayer the
// companion uses: dom, pause(), play(), stopRendering(), dispose() and
// context.gl.
import { live2dArtBounds, placeLive2D, backgroundBand, createActionOrder, withLive2DFiles, gazeFocus, reactionFraming } from './companion-live2d.js';

// The framework keeps one set of compiled shaders for every WebGL context, so
// a second canvas (the next person fading in) left the first one blank. Give
// each context its own shader set.
export function separateShaderContexts(live2d) {
  const Shader = live2d.CubismShader_WebGL;
  if (!Shader || Shader.prototype.companionPerContext) return;
  const setup = Shader.prototype.setupShaderProgram;
  const shaders = new WeakMap();
  Shader.prototype.setupShaderProgram = function (renderer, ...rest) {
    let own = shaders.get(renderer.gl);
    if (!own) {
      own = new Shader();
      own.gl = renderer.gl;
      shaders.set(renderer.gl, own);
    }
    return setup.call(own, renderer, ...rest);
  };
  Shader.prototype.companionPerContext = true;
}

// Sample the idle motion for this long to find the extent the figure uses.
const SAMPLE_SECONDS = 8;
const SAMPLE_STEP = 0.25;
// Width of the fade where a close-up meets the left edge of the model canvas.
const CANVAS_FADE = 64;
// Reactions are sampled to their end, but no further than this.
const REACTION_SECONDS = 30;
// The idle pause between two reactions in the action display.
const ACTION_GAP = 1.5;

// blobs maps each file of the settings to its downloaded Blob. In the action
// display, progress (from an earlier visit) continues the round of reactions,
// and onProgress receives the round each time a reaction has played out.
export async function createLive2DPlayer({ PIXI, layer, settings, plan, blobs, mode, space, frame,
  progress = null, onProgress = () => {}, onReaction = () => {} }) {
  const live2d = PIXI.live2d;
  const dom = document.createElement('div');
  dom.className = 'live2d-player';
  const canvas = document.createElement('canvas');
  dom.append(canvas);
  layer.append(dom);
  const app = new PIXI.Application({
    view: canvas, resizeTo: dom, backgroundAlpha: 0, antialias: true, autoStart: false,
    resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true,
  });
  let model;
  let destroyed = false;
  // URLs of this player alone, so destroying its textures touches no other player.
  const urls = Object.fromEntries(Object.entries(blobs).map(([path, blob]) => [path, URL.createObjectURL(blob)]));
  const player = {
    dom,
    context: { gl: app.renderer.gl },
    pause() { app.ticker.stop(); },
    play() { if (!destroyed) app.ticker.start(); },
    stopRendering() { app.ticker.stop(); },
    dispose() {
      if (destroyed) return;
      destroyed = true;
      app.ticker.stop();
      app.destroy(false, { children: true, texture: true, baseTexture: true });
      Object.values(urls).forEach(url => URL.revokeObjectURL(url));
    },
    // True while the action display waits in idle between two reactions.
    betweenActions: false,
  };
  try {
    // Every file is already a full blob URL; the library's resolver would turn
    // blob:http://… into blob:http//….
    // Azur Lane motions switch alternative parts on and off (a fan-holding arm
    // and a resting one, two poses of a mascot) with PartOpacity curves. By
    // default the framework writes those curves to a parameter of the same
    // name, which these models lack, so every alternative stayed drawn on top
    // of the others.
    live2d.CubismConfig.setOpacityFromMotion = true;
    const modelSettings = new live2d.Cubism4ModelSettings(withLive2DFiles(settings, plan, urls));
    modelSettings.resolveURL = path => path;
    model = await live2d.Live2DModel.from(modelSettings, {
      autoUpdate: false, autoInteract: false, motionPreload: live2d.MotionPreloadStrategy.ALL,
      // The library looks for "Idle"; Azur Lane names the group "idle".
      idleMotionGroup: plan.idle,
    });
    app.stage.addChild(model);
    const internal = model.internalModel;
    const motions = internal.motionManager;
    // The framework's clock, in seconds; motions are scheduled against it.
    let clock = 0;

    // Part opacities are never reset between frames, so a part that a reaction
    // switched and idle does not drive would keep the reaction's state. Every
    // frame starts from the model's own opacities; the motions then switch
    // the parts they drive.
    const partOpacities = Array.from({ length: internal.coreModel.getPartCount() },
      (_, index) => internal.coreModel.getPartOpacityByIndex(index));
    internal.on('beforeMotionUpdate', () => {
      partOpacities.forEach((opacity, index) => internal.coreModel.setPartOpacityByIndex(index, opacity));
    });

    // The ambient effect loop runs on its own queue next to the base motion.
    if (plan.effect) {
      const effect = await motions.loadMotion(plan.effect, 0);
      if (effect) {
        effect.setIsLoop(true);
        const queue = new live2d.CubismMotionQueueManager();
        // The queue calls this for user events in the motion without checking it exists.
        queue.setEventCallback(() => {});
        let started = false;
        internal.on('afterMotionUpdate', () => {
          if (!started) { queue.startMotion(effect, false, clock); started = true; }
          queue.doUpdateMotion(internal.coreModel, clock);
        });
      }
    }

    const nextAction = createActionOrder(mode === 'skill' ? plan.actions : [], Math.random, progress);
    let gapLeft = 0;
    const startAction = () => {
      const name = nextAction();
      // Without reactions the action display simply stays in idle.
      if (!name) { player.betweenActions = true; return; }
      player.betweenActions = false;
      void motions.startMotion(name, 0, live2d.MotionPriority.FORCE);
      // The motion's name, for the voice line the game says with it.
      onReaction(name);
    };

    // Find the extent of the idle pose (and in the action display, of every
    // reaction) before the first frame, then start.
    const step = seconds => {
      clock += seconds;
      model.elapsedTime = clock * 1000;
      internal.update(seconds * 1000, clock * 1000);
    };
    if (plan.idle) await motions.startMotion(plan.idle, 0, live2d.MotionPriority.IDLE);
    const core = internal.coreModel;
    const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    const canvasSize = { width: internal.originalWidth, height: internal.originalHeight };
    const sample = (into = bounds) => {
      const drawables = [];
      for (let i = 0; i < core.getDrawableCount(); i++) {
        drawables.push({ id: core.getDrawableId(i), vertices: internal.getDrawableVertices(i),
          opacity: core.getDrawableOpacity(i), visible: core.getDrawableDynamicFlagIsVisible(i) });
      }
      return live2dArtBounds(drawables, canvasSize, into);
    };
    for (let t = 0; t <= SAMPLE_SECONDS; t += SAMPLE_STEP) {
      step(t ? SAMPLE_STEP : 0);
      sample();
    }
    // Reactions move the figure (a bow, a leap), so the action display leaves
    // room above it for them; see reactionFraming.
    if (mode === 'skill' && plan.actions.length) {
      const frames = [];
      for (const name of plan.actions) {
        await motions.startMotion(name, 0, live2d.MotionPriority.FORCE);
        const length = motions.motionGroups[name]?.[0]?.getDuration?.();
        const seconds = Math.min(length > 0 ? length : SAMPLE_SECONDS, REACTION_SECONDS);
        for (let t = SAMPLE_STEP; t <= seconds; t += SAMPLE_STEP) {
          step(SAMPLE_STEP);
          frames.push(sample({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }));
        }
      }
      Object.assign(bounds, reactionFraming(bounds, frames, canvasSize));
      // The last reaction sampled is still the current motion, and the
      // library refuses to start a motion that is already playing: had the
      // first reaction been that one, it would have been skipped.
      motions.stopAllMotions();
    }

    // Listen only now, so the reactions sampled above do not count as played.
    let group = '';
    motions.on('motionStart', name => { group = name; });
    motions.on('motionFinish', () => {
      if (group === plan.idle || mode !== 'skill') return;
      player.betweenActions = true;
      gapLeft = ACTION_GAP;
      onProgress(nextAction.progress());
    });
    if (mode === 'skill') startAction();

    // The head in model pixels: the highest point of the drawables that move
    // when the head turns, and their middle across. null when the model has
    // no head turn.
    const findHead = () => {
      const index = core.getParameterIndex('ParamAngleX');
      if (!(index >= 0 && index < core.getParameterCount())) return null;
      const count = core.getDrawableCount();
      const before = Array.from({ length: count }, (_, i) => Float32Array.from(internal.getDrawableVertices(i)));
      const value = core.getParameterValueByIndex(index);
      core.setParameterValueByIndex(index, value + 30);
      core.update();
      let top = Infinity;
      let left = Infinity;
      let right = -Infinity;
      const moved = canvasSize.height * 0.002;
      for (let i = 0; i < count; i++) {
        if (!core.getDrawableDynamicFlagIsVisible(i) || !(core.getDrawableOpacity(i) >= 0.02)) continue;
        const after = internal.getDrawableVertices(i);
        let shift = 0;
        let highest = Infinity;
        let lowX = Infinity;
        let highX = -Infinity;
        for (let k = 0; k < after.length; k += 2) {
          shift = Math.max(shift, Math.abs(after[k] - before[i][k]), Math.abs(after[k + 1] - before[i][k + 1]));
          highest = Math.min(highest, before[i][k + 1]);
          lowX = Math.min(lowX, before[i][k]);
          highX = Math.max(highX, before[i][k]);
        }
        if (shift > moved) {
          top = Math.min(top, highest);
          left = Math.min(left, lowX);
          right = Math.max(right, highX);
        }
      }
      core.setParameterValueByIndex(index, value);
      core.update();
      return Number.isFinite(top) ? { top: Math.max(0, top), x: (left + right) / 2 } : null;
    };
    let placedKey = '';
    // A scene's background band in model pixels, once the first frame showed it.
    let cover = null;
    const place = () => {
      const width = dom.clientWidth;
      const height = dom.clientHeight;
      const key = `${width}x${height}`;
      if (!width || !height || key === placedKey) return;
      placedKey = key;
      app.resize();
      // The free space follows the viewport, so it is read again on every resize.
      const spot = placeLive2D(bounds, { width, height }, space(), canvasSize, cover);
      model.scale.set(spot.scale);
      model.position.set(spot.x, spot.y);
      // The game shows a model through its canvas, so art a reaction moves
      // past it (a close-up of the face) is cut off there instead of spilling
      // over the navigation. Cubism's renderer turns off the scissor and
      // stencil tests a PixiJS mask relies on, so the page clips the element.
      // Its left edge, which lies inside the rail's own fade, fades out too.
      const right = width - (spot.x + canvasSize.width * spot.scale);
      const bottom = height - (spot.y + canvasSize.height * spot.scale);
      const left = Math.max(0, spot.x);
      canvas.style.clipPath = `inset(${[spot.y, right, bottom].map(edge => Math.max(0, edge).toFixed(1) + 'px').join(' ')} ${left.toFixed(1)}px)`;
      const fade = left > 0 ? `linear-gradient(90deg, transparent ${left.toFixed(1)}px, #000 ${(left + CANVAS_FADE).toFixed(1)}px)` : '';
      canvas.style.webkitMaskImage = fade;
      canvas.style.maskImage = fade;
    };
    app.ticker.add(() => {
      const seconds = Math.min(app.ticker.deltaMS / 1000, 0.1);
      place();
      step(seconds);
      // frame() is true while the companion moves on from this display: it
      // then stays in idle rather than begin a reaction that would be cut off.
      const hold = frame(seconds) === true;
      if (player.betweenActions && !hold && (gapLeft -= seconds) <= 0) startAction();
    });
    place();
    // The eyes and head follow the pointer anywhere on the page, back to the
    // front when it leaves the window. The rail itself takes no pointer input.
    const look = event => {
      const rect = canvas.getBoundingClientRect();
      const pointer = { x: (event.clientX - rect.left - model.x) / model.scale.x, y: (event.clientY - rect.top - model.y) / model.scale.y };
      const focus = gazeFocus(pointer, bounds);
      internal.focusController.focus(focus.x, focus.y);
    };
    const away = event => { if (!event.relatedTarget) internal.focusController.focus(0, 0); };
    window.addEventListener('pointermove', look, { passive: true });
    document.addEventListener('pointerout', away);
    const dispose = player.dispose;
    player.dispose = () => {
      window.removeEventListener('pointermove', look);
      document.removeEventListener('pointerout', away);
      dispose();
    };
    app.render();
    // Read the first frame (opacity, at a low resolution) to find a scene's
    // background, then place the model by it and draw again. The head (the
    // drawables a head turn moves) stays in view; a model without a head turn
    // keeps its plain framing.
    try {
      const head = findHead();
      const width = app.renderer.view.width;
      const height = app.renderer.view.height;
      const pixels = app.renderer.plugins.extract.pixels();
      const columns = 96;
      const rows = 96;
      const mask = new Uint8Array(columns * rows);
      for (let row = 0; row < rows; row++) {
        // The pixels come bottom row first, as WebGL reads them.
        const y = height - 1 - Math.min(height - 1, Math.floor((row + 0.5) * height / rows));
        for (let column = 0; column < columns; column++) {
          const x = Math.min(width - 1, Math.floor((column + 0.5) * width / columns));
          mask[row * columns + column] = pixels[(y * width + x) * 4 + 3];
        }
      }
      const railHeight = dom.clientHeight;
      const band = head ? backgroundBand(mask, columns, rows, { keep: (head.top * model.scale.y + model.y) / railHeight }) : null;
      if (band) {
        cover = { minY: (band.top * railHeight - model.y) / model.scale.y, maxY: (band.bottom * railHeight - model.y) / model.scale.y,
          anchorX: head.x };
        placedKey = '';
        place();
        app.render();
      }
    } catch { /* Without a readable frame the plain framing stays. */ }
    return player;
  } catch (error) {
    player.dispose();
    dom.remove();
    throw error;
  }
}
