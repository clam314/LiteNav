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
// How long the camera takes to move to the other display's framing.
const GLIDE_SECONDS = 0.6;

// layers: [{ skeleton: Uint8Array, atlas: text, images: { page: ImageBitmap } }], top first.
// In the action display (mode 'skill') the painting plays its reactions:
// actions is a list of reactions, each a list of animations played in order
// on every layer that has them, followed by the loop again. progress and
// onProgress continue the round of reactions across visits, as for Live2D.
// setMode() moves the same painting to the other display.
export function createPaintingPlayer({ spine, layer, layers, space, frame, mode = 'portrait', actions = [],
  progress = null, onProgress = () => {}, onReaction = () => {} }) {
  const dom = document.createElement('div');
  dom.className = 'painting-player';
  const canvas = document.createElement('canvas');
  dom.append(canvas);
  layer.append(dom);
  // The textures carry straight alpha, so the page composites it as such.
  const context = new spine.webgl.ManagedWebGLRenderingContext(canvas, { alpha: true, premultipliedAlpha: false });
  try {
    return paint({ spine, dom, canvas, context, layers, space, frame, mode, actions, progress, onProgress, onReaction });
  } catch (error) {
    // A painting that cannot be read gives its context back at once: browsers
    // only keep a handful of WebGL contexts alive.
    try { context.gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Optional extension. */ }
    dom.remove();
    throw error;
  }
}

function paint({ spine, dom, canvas, context, layers, space, frame, mode, actions, progress, onProgress, onReaction }) {
  let current = mode === 'skill' ? 'skill' : 'portrait';
  // The reactions the current display plays.
  let reactions = current === 'skill' ? actions : [];
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

  // The painting's extent over the loop, and over the loop and its reactions
  // for the action display, from every drawn layer. A layer without an
  // animation keeps its loop.
  const probes = loaded.map(({ skeleton }) => new spine.Skeleton(skeleton.data));
  const extent = names => {
    const frames = [];
    for (const name of names) {
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
    return shotBox(frames);
  };
  const views = { portrait: extent([loop]) };
  views.skill = actions.length ? extent([loop, ...new Set(actions.flat())]) : views.portrait;
  if (!views.portrait || !views.skill) throw new Error('这张立绘暂时无法显示');

  const gl = context.gl;
  let running = false;
  let destroyed = false;
  let handle = 0;
  let last = 0;
  let placedKey = '';
  // The camera on screen, and a glide to the other display's framing.
  let shown = null;
  let glide = null;
  const aim = camera => {
    shown = camera;
    renderer.camera.zoom = camera.zoom;
    renderer.camera.position.x = camera.x;
    renderer.camera.position.y = camera.y;
  };
  // smooth moves there over GLIDE_SECONDS (a display switch); a resize jumps.
  const place = (width, height, ratio, smooth) => {
    // The free space follows the viewport, so it is read again on every resize.
    const camera = placePainting(views[current], { width, height }, space() * ratio);
    glide = smooth && shown ? { from: shown, to: camera, elapsed: 0 } : null;
    if (!glide) aim(camera);
  };
  const draw = (seconds = 0, smooth = false) => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(dom.clientWidth * ratio);
    const height = Math.round(dom.clientHeight * ratio);
    const key = `${width}x${height}`;
    if (width && height && key !== placedKey) {
      placedKey = key;
      canvas.width = width;
      canvas.height = height;
      renderer.camera.setViewport(width, height);
      place(width, height, ratio, false);
    } else if (width && height && smooth) {
      place(width, height, ratio, true);
    }
    if (glide) {
      glide.elapsed += seconds;
      const progress = Math.min(1, glide.elapsed / GLIDE_SECONDS);
      const eased = progress * progress * (3 - 2 * progress);
      const { from, to } = glide;
      const mix = key => from[key] + (to[key] - from[key]) * eased;
      aim({ zoom: mix('zoom'), x: mix('x'), y: mix('y') });
      if (progress >= 1) glide = null;
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
  const nextReaction = createActionOrder(actions, Math.random, progress);
  let reactionLeft = 0;
  let gapLeft = 0;
  const startReaction = () => {
    const steps = nextReaction();
    // Without reactions the action display simply stays in the loop.
    if (!steps) { player.betweenActions = true; return; }
    player.betweenActions = false;
    reactionLeft = 0;
    // The first animation names the reaction, for its voice line.
    onReaction(steps[0]);
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
    // frame() is true while the companion moves on from this painting: it
    // then stays in its loop rather than begin a reaction that would be cut off.
    const hold = frame(seconds) === true;
    if (reactions.length && seconds > 0) {
      if (!player.betweenActions && (reactionLeft -= seconds) <= 0) {
        player.betweenActions = true;
        gapLeft = ACTION_GAP;
        onProgress(nextReaction.progress());
      } else if (player.betweenActions && !hold && (gapLeft -= seconds) <= 0) {
        startReaction();
      }
    }
    draw(seconds);
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
    // Moves this painting to the other display: the action display frames
    // room for the reactions and plays them, the portrait keeps the loop.
    // The companion switches at a break between reactions.
    setMode(next) {
      if (destroyed || next === current || (next !== 'skill' && next !== 'portrait')) return;
      current = next;
      reactions = current === 'skill' ? actions : [];
      player.betweenActions = false;
      if (reactions.length) startReaction();
      draw(0, true);
    },
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
