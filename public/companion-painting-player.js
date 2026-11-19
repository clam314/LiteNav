// Draws an Azur Lane dynamic painting with the Spine 3.8 WebGL runtime: its
// layers share one canvas and one camera, the first listed on top. Mirrors
// the player interface the companion uses: dom, pause(), play(),
// stopRendering(), dispose() and context.gl.
import { regionCandidates, paintingAnimation, placePainting } from './companion-painting.js';
import { drawnBounds, shotBox } from './companion-performance-player.js';
import { createActionOrder } from './companion-live2d.js';

// Sample each animation this many times to find the extent of the painting.
const SAMPLES = 24;
// The loop plays this long between two reactions in the action display.
const ACTION_GAP = 1.5;

// layers: [{ skeleton: Uint8Array, atlas: text, images: { page: ImageBitmap } }], top first.
// In the action display (mode 'skill') the painting plays its reactions:
// actions is a list of reactions, each a list of animations played in order
// on every layer that has them, followed by the loop again.
export function createPaintingPlayer({ spine, layer, layers, space, frame, mode = 'portrait', actions = [] }) {
  const dom = document.createElement('div');
  dom.className = 'painting-player';
  const canvas = document.createElement('canvas');
  dom.append(canvas);
  layer.append(dom);
  // The textures carry straight alpha, so the page composites it as such.
  const context = new spine.webgl.ManagedWebGLRenderingContext(canvas, { alpha: true, premultipliedAlpha: false });
  try {
    return paint({ spine, dom, canvas, context, layers, space, frame, reactions: mode === 'skill' ? actions : [] });
  } catch (error) {
    // A painting that cannot be read gives its context back at once: browsers
    // only keep a handful of WebGL contexts alive.
    try { context.gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Optional extension. */ }
    dom.remove();
    throw error;
  }
}

function paint({ spine, dom, canvas, context, layers, space, frame, reactions }) {
  const renderer = new spine.webgl.SceneRenderer(canvas, context, true);

  const loaded = layers.map(file => {
    const atlas = new spine.TextureAtlas(file.atlas, page => {
      if (!file.images[page]) throw new Error('角色纹理缺失');
      return new spine.webgl.GLTexture(context, file.images[page]);
    });
    // Repair region names the 3.8 reader garbles (see recoverUtf8).
    const findRegion = atlas.findRegion.bind(atlas);
    atlas.findRegion = name => {
      for (const candidate of regionCandidates(name)) {
        const region = findRegion(candidate);
        if (region) return region;
      }
      return null;
    };
    const data = new spine.SkeletonBinary(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(file.skeleton);
    const skeleton = new spine.Skeleton(data);
    skeleton.setToSetupPose();
    const state = new spine.AnimationState(new spine.AnimationStateData(data));
    return { skeleton, state };
  });
  // Every layer plays the same loop; a layer without it keeps its setup pose.
  const loop = paintingAnimation(loaded[0].skeleton.data.animations.map(animation => animation.name));
  for (const { skeleton, state } of loaded) {
    if (loop && skeleton.data.findAnimation(loop)) state.setAnimation(0, loop, true);
    state.apply(skeleton);
    skeleton.updateWorldTransform();
  }

  // The painting's extent over the loop and any reaction it plays, from
  // every drawn layer. A layer without an animation keeps its loop.
  const probes = loaded.map(({ skeleton }) => new spine.Skeleton(skeleton.data));
  const frames = [];
  for (const name of [loop, ...new Set(reactions.flat())]) {
    const duration = Math.max(0, ...probes.map(probe => probe.data.findAnimation(name)?.duration || 0));
    for (let i = 0; i <= SAMPLES; i++) {
      const time = duration * i / SAMPLES;
      for (const probe of probes) {
        probe.setToSetupPose();
        (probe.data.findAnimation(name) || probe.data.findAnimation(loop))
          ?.apply(probe, time, time, true, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
        probe.updateWorldTransform();
      }
      frames.push(drawnBounds(probes));
    }
  }
  const view = shotBox(frames);
  if (!view) throw new Error('这张立绘暂时无法显示');

  const gl = context.gl;
  let running = false;
  let destroyed = false;
  let handle = 0;
  let last = 0;
  let placedKey = '';
  const draw = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(dom.clientWidth * ratio);
    const height = Math.round(dom.clientHeight * ratio);
    const key = `${width}x${height}`;
    if (width && height && key !== placedKey) {
      placedKey = key;
      canvas.width = width;
      canvas.height = height;
      // The free space follows the viewport, so it is read again on every resize.
      const camera = placePainting(view, { width, height }, space() * ratio);
      renderer.camera.setViewport(width, height);
      renderer.camera.zoom = camera.zoom;
      renderer.camera.position.x = camera.x;
      renderer.camera.position.y = camera.y;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.begin();
    // Draw back to front: the first layer listed is the top one.
    for (let i = loaded.length - 1; i >= 0; i--) renderer.drawSkeleton(loaded[i].skeleton, false);
    renderer.end();
  };
  // The action display: one reaction at a time on every layer that has its
  // animations, back to the loop, a pause, then the next reaction.
  const nextReaction = createActionOrder(reactions);
  let reactionLeft = 0;
  let gapLeft = 0;
  const startReaction = () => {
    const steps = nextReaction();
    // Without reactions the action display simply stays in the loop.
    if (!steps) { player.betweenActions = true; return; }
    player.betweenActions = false;
    reactionLeft = 0;
    for (const { skeleton, state } of loaded) {
      const own = steps.map(name => skeleton.data.findAnimation(name)).filter(Boolean);
      if (!own.length) continue;
      // The 3.8 runtime takes Animation objects only through the *With calls.
      state.setAnimationWith(0, own[0], false);
      for (const animation of own.slice(1)) state.addAnimationWith(0, animation, false, 0);
      if (loop && skeleton.data.findAnimation(loop)) state.addAnimation(0, loop, true, 0);
      reactionLeft = Math.max(reactionLeft, own.reduce((sum, animation) => sum + animation.duration, 0));
    }
  };
  const tick = now => {
    if (!running) return;
    const seconds = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    for (const { skeleton, state } of loaded) {
      state.update(seconds);
      state.apply(skeleton);
      skeleton.updateWorldTransform();
    }
    if (reactions.length && seconds > 0) {
      if (!player.betweenActions && (reactionLeft -= seconds) <= 0) {
        player.betweenActions = true;
        gapLeft = ACTION_GAP;
      } else if (player.betweenActions && (gapLeft -= seconds) <= 0) {
        startReaction();
      }
    }
    draw();
    frame(seconds);
    handle = requestAnimationFrame(tick);
  };
  // A paused painting still follows a resized rail.
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (!running && !destroyed) draw(); }) : null;
  resized?.observe(dom);

  const player = {
    dom,
    context: { gl },
    // True while the action display waits in the loop between two reactions.
    betweenActions: false,
    pause() {
      running = false;
      cancelAnimationFrame(handle);
    },
    play() {
      if (running || destroyed) return;
      running = true;
      last = 0;
      handle = requestAnimationFrame(tick);
    },
    stopRendering() { this.pause(); },
    dispose() {
      if (destroyed) return;
      destroyed = true;
      this.pause();
      resized?.disconnect();
      renderer.dispose?.();
    },
  };
  if (reactions.length) {
    startReaction();
    for (const { skeleton, state } of loaded) {
      state.apply(skeleton);
      skeleton.updateWorldTransform();
    }
  }
  draw();
  return player;
}
