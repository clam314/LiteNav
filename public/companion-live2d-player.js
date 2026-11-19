// Draws one Live2D model with PixiJS and pixi-live2d-display (Cubism 4
// framework on Cubism Core 5). The player mirrors the parts of SpinePlayer the
// companion uses: dom, pause(), play(), stopRendering(), dispose() and
// context.gl.
import { live2dArtBounds, placeLive2D, createActionOrder, withLive2DFiles, gazeFocus } from './companion-live2d.js';

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
// The idle pause between two reactions in the action display.
const ACTION_GAP = 1.5;

// blobs maps each file of the settings to its downloaded Blob.
export async function createLive2DPlayer({ PIXI, layer, settings, plan, blobs, mode, space, frame }) {
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

    let group = '';
    motions.on('motionStart', name => { group = name; });
    const nextAction = createActionOrder(mode === 'skill' ? plan.actions : []);
    let gapLeft = 0;
    const startAction = () => {
      const name = nextAction();
      // Without reactions the action display simply stays in idle.
      if (!name) { player.betweenActions = true; return; }
      player.betweenActions = false;
      void motions.startMotion(name, 0, live2d.MotionPriority.FORCE);
    };
    motions.on('motionFinish', () => {
      if (group === plan.idle || mode !== 'skill') return;
      player.betweenActions = true;
      gapLeft = ACTION_GAP;
    });

    // Find the extent of the idle pose before the first frame, then start.
    const step = seconds => {
      clock += seconds;
      model.elapsedTime = clock * 1000;
      internal.update(seconds * 1000, clock * 1000);
    };
    if (plan.idle) await motions.startMotion(plan.idle, 0, live2d.MotionPriority.IDLE);
    const core = internal.coreModel;
    const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    const canvasSize = { width: internal.originalWidth, height: internal.originalHeight };
    const sample = () => {
      const drawables = [];
      for (let i = 0; i < core.getDrawableCount(); i++) {
        drawables.push({ id: core.getDrawableId(i), vertices: internal.getDrawableVertices(i),
          opacity: core.getDrawableOpacity(i), visible: core.getDrawableDynamicFlagIsVisible(i) });
      }
      live2dArtBounds(drawables, canvasSize, bounds);
    };
    for (let t = 0; t <= SAMPLE_SECONDS; t += SAMPLE_STEP) {
      step(t ? SAMPLE_STEP : 0);
      sample();
    }
    if (mode === 'skill') startAction();

    let placedKey = '';
    const place = () => {
      const width = dom.clientWidth;
      const height = dom.clientHeight;
      const key = `${width}x${height}`;
      if (!width || !height || key === placedKey) return;
      placedKey = key;
      app.resize();
      // The free space follows the viewport, so it is read again on every resize.
      const spot = placeLive2D(bounds, { width, height }, space(), canvasSize);
      model.scale.set(spot.scale);
      model.position.set(spot.x, spot.y);
    };
    app.ticker.add(() => {
      const seconds = Math.min(app.ticker.deltaMS / 1000, 0.1);
      place();
      step(seconds);
      if (player.betweenActions && (gapLeft -= seconds) <= 0) startAction();
      frame(seconds);
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
    return player;
  } catch (error) {
    player.dispose();
    dom.remove();
    throw error;
  }
}
