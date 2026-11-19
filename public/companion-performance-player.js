// Plays a Brown Dust 2 full skill performance inside a SpinePlayer: each
// layer poses its own copy of a skeleton at the performance time and is drawn
// in the player's draw pass, and the camera moves to the current shot.
import { performanceActions, compilePerformance, schedulePerformance, performanceLayers, layerPoseAt, shotAt }
  from './companion-performance.js';

// The costume id the performances are keyed by, from the cutscene skeleton path.
export const performanceId = part => part?.skeleton?.match(/(?:^|\/)cutscene_(char\d{6})\.skel$/i)?.[1]?.toLowerCase();

// Skeletons a costume's performances borrow from (glow or tera layers).
export function performanceSources(definitions = []) {
  const sources = new Set();
  const visit = step => {
    if (Array.isArray(step)) step.forEach(visit);
    else if (step && typeof step === 'object' && step.source) sources.add(step.source);
  };
  definitions.forEach(definition => definition.composite.forEach(visit));
  return [...sources];
}

// Turn downloaded files of a borrowed skeleton into skeleton data on this
// player's GL context. Returns null when it cannot be read.
export function readExternalSkeleton(spine, context, external) {
  try {
    const atlas = new spine.TextureAtlas(external.atlas);
    for (const page of atlas.pages) {
      const image = external.images[page.name];
      if (!image) return null;
      page.setTexture(new spine.GLTexture(context, image));
    }
    const data = new spine.SkeletonBinary(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(external.skeleton);
    return { data, premultipliedAlpha: external.premultipliedAlpha };
  } catch {
    return null;
  }
}

// The actions a skill menu offers on top of the cutscene's own animations.
// A layered loop ("loop_2_all") stands in for the plain loop it completes;
// every other performance is a full performance, listed first.
export function performanceMenu(definitions, animations, durationOf, labelOf = name => name) {
  const playable = performanceActions(definitions).filter(name => {
    try {
      const plan = schedulePerformance(compilePerformance(definitions, name), durationOf);
      return !plan.missing.length && plan.duration > 0;
    } catch { return false; }
  });
  const names = new Set(animations.map(animation => animation.name));
  const replacements = new Map();
  const full = [];
  for (const name of playable) {
    const base = name.match(/^(loop\w*?)_all$/)?.[1];
    if (base && names.has(base)) replacements.set(base, name);
    else full.push(name);
  }
  const entry = (name, label, replaces) => ({ name, label, replaces, performance: true });
  return [
    ...full.map((name, index) => entry(name, full.length > 1 ? `完整演出 ${index + 1}` : '完整演出')),
    ...animations.map(animation => replacements.has(animation.name) ?
      entry(replacements.get(animation.name), labelOf(animation.name), animation.name) : animation),
  ];
}

// Slots that carry effects rather than the figure: ground shadows and
// footprints, wind, breath, glows, snow and the like. Their art reaches far
// past the figure and would shrink it inside the shot.
export const EFFECT_SLOT = /shadow|footprint|wind|breath|effect|(?:^|_)eff(?:_|\d|$)|glow|glrow|snow|smoke|dust|flash|spark|particle|blur|trail|light|레이어/i;

// The camera box of a shot from the figure's extent in each sampled frame
// ({ minX, maxX, minY, maxY }, y up). Each edge takes the 10th or 90th
// percentile over the frames, so a brief lunge or flourish does not shrink
// the figure for the whole shot.
export function shotBox(frames) {
  const usable = frames.filter(frame => [frame.minX, frame.maxX, frame.minY, frame.maxY].every(Number.isFinite));
  if (!usable.length) return null;
  const quantile = (values, q) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  };
  const edges = key => usable.map(frame => frame[key]);
  // The median frame is the figure at rest; no edge strays more than half
  // its size beyond it, even when a cut ends with pieces flying off.
  const core = { minX: quantile(edges('minX'), .5), maxX: quantile(edges('maxX'), .5),
    minY: quantile(edges('minY'), .5), maxY: quantile(edges('maxY'), .5) };
  const reachX = (core.maxX - core.minX) / 2;
  const reachY = (core.maxY - core.minY) / 2;
  const minX = Math.max(quantile(edges('minX'), .1), core.minX - reachX);
  const maxX = Math.min(quantile(edges('maxX'), .9), core.maxX + reachX);
  const minY = Math.max(quantile(edges('minY'), .1), core.minY - reachY);
  const maxY = Math.min(quantile(edges('maxY'), .9), core.maxY + reachY);
  if (!(maxX > minX && maxY > minY)) return null;
  const width = maxX - minX;
  const height = maxY - minY;
  // The same 5% side and top margins as the presets; the art stands on the floor.
  return { x: minX - width * .05, y: minY, width: width * 1.1, height: height * 1.05 };
}

const partArea = part => (part.maxX - part.minX) * (part.maxY - part.minY);

// Largest first, without a backdrop that dwarfs everything else: the solid
// black letterbox around a 有缘之客 scene reaches far past all the other parts
// together on both axes (2.9× and more), a scene's own background only a
// little past its figure (2× at most).
export function withoutBackdrops(parts) {
  parts = [...parts].sort((a, b) => partArea(b) - partArea(a));
  while (parts.length > 1) {
    const [largest, ...rest] = parts;
    const width = Math.max(...rest.map(part => part.maxX)) - Math.min(...rest.map(part => part.minX));
    const height = Math.max(...rest.map(part => part.maxY)) - Math.min(...rest.map(part => part.minY));
    if (largest.maxX - largest.minX <= width * 2.5 || largest.maxY - largest.minY <= height * 2.5) break;
    parts = rest;
  }
  return parts;
}

// The extent of a frame's parts ({ minX, maxX, minY, maxY } each), leaving
// out parts whose centre lies far outside the middle half of all centres:
// chains or petals flung off screen at the end of a cut.
export function figureBounds(parts) {
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  if (!parts.length) return bounds;
  parts = withoutBackdrops(parts);
  const spread = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = q => sorted[Math.round(q * (sorted.length - 1))];
    const range = at(.75) - at(.25);
    return [at(.25) - range * 3, at(.75) + range * 3];
  };
  // A handful of parts has no meaningful middle half; keep them all.
  const few = parts.length < 8;
  const [left, right] = few ? [-Infinity, Infinity] : spread(parts.map(part => (part.minX + part.maxX) / 2));
  const [bottom, top] = few ? [-Infinity, Infinity] : spread(parts.map(part => (part.minY + part.maxY) / 2));
  for (const part of parts) {
    const x = (part.minX + part.maxX) / 2;
    const y = (part.minY + part.maxY) / 2;
    if (x < left || x > right || y < bottom || y > top) continue;
    bounds.minX = Math.min(bounds.minX, part.minX);
    bounds.maxX = Math.max(bounds.maxX, part.maxX);
    bounds.minY = Math.min(bounds.minY, part.minY);
    bounds.maxY = Math.max(bounds.maxY, part.maxY);
  }
  return bounds;
}

// Extent of the drawn attachments of posed skeletons (y up), like
// visibleArtBounds but over several skeletons, with the top edge too and
// without stray parts. skip leaves slots out by name.
export function drawnBounds(skeletons, skip = null) {
  return figureBounds(drawnParts(skeletons, skip));
}

// Each drawn attachment's extent, with its slot name.
export function drawnParts(skeletons, skip = null) {
  const parts = [];
  let vertices = new Float32Array(1024);
  for (const skeleton of skeletons) {
    for (const slot of skeleton.drawOrder) {
      const attachment = slot.bone.active ? slot.getAttachment() : null;
      if (!attachment?.region || skip?.test(slot.data.name)) continue;
      if (skeleton.color.a * slot.color.a * (attachment.color?.a ?? 1) < 0.02) continue;
      let count = 8;
      if (attachment.triangles) {
        count = attachment.worldVerticesLength;
        if (vertices.length < count) vertices = new Float32Array(count);
        attachment.computeWorldVertices(slot, 0, count, vertices, 0, 2);
      } else {
        attachment.computeWorldVertices(slot, vertices, 0, 2);
      }
      const part = { slot: slot.data.name, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (let i = 0; i < count; i += 2) {
        part.minX = Math.min(part.minX, vertices[i]);
        part.maxX = Math.max(part.maxX, vertices[i]);
        part.minY = Math.min(part.minY, vertices[i + 1]);
        part.maxY = Math.max(part.maxY, vertices[i + 1]);
      }
      parts.push(part);
    }
  }
  return parts;
}

const SHOT_SAMPLES = 24;

// Returns null when a step names an animation the skeletons lack.
export function createPerformance({ spine, player, definitions, name, externals = new Map(), premultipliedAlpha }) {
  const base = player.skeleton;
  const dataOf = source => source ? externals.get(source)?.data : base.data;
  const durationOf = (animation, source) => dataOf(source)?.findAnimation(animation)?.duration;
  const plan = schedulePerformance(compilePerformance(definitions, name), durationOf);
  if (plan.missing.length || !(plan.duration > 0)) return null;

  const layers = performanceLayers(plan.segments).map(layer => {
    const skeleton = new spine.Skeleton(dataOf(layer.source));
    const skin = layer.skin && skeleton.data.findSkin(layer.skin);
    if (skin) skeleton.setSkin(skin);
    else if (!layer.source && base.skin) skeleton.setSkin(base.skin);
    skeleton.setSlotsToSetupPose();
    return {
      ...layer, skeleton, visible: false,
      premultipliedAlpha: layer.source ? externals.get(layer.source).premultipliedAlpha : premultipliedAlpha,
    };
  });
  const events = [];
  const pose = time => {
    for (const layer of layers) {
      const at = layerPoseAt(layer, time);
      layer.visible = Boolean(at);
      if (!at) continue;
      const skeleton = layer.skeleton;
      skeleton.setToSetupPose();
      events.length = 0;
      skeleton.data.findAnimation(at.name).apply(skeleton, at.time, at.time, false, events, 1,
        spine.MixBlend.setup, spine.MixDirection.mixIn);
      skeleton.updateWorldTransform();
    }
  };

  // One camera per shot, from the figure's extent in sampled frames. A frame
  // drawn only by effect slots counts them after all.
  const shots = plan.shots.map(shot => {
    const frames = [];
    for (let i = 0; i <= SHOT_SAMPLES; i++) {
      pose(shot.start + (shot.end - shot.start) * Math.min(i / SHOT_SAMPLES, 0.9999));
      const skeletons = layers.filter(layer => layer.visible).map(layer => layer.skeleton);
      const figure = drawnBounds(skeletons, EFFECT_SLOT);
      frames.push(Number.isFinite(figure.minX) ? figure : drawnBounds(skeletons));
    }
    return { ...shot, view: shotBox(frames) };
  });
  // A shot without drawn art keeps the camera of the shot before it.
  shots.forEach((shot, index) => { shot.view ||= shots.slice(0, index).reverse().find(other => other.view)?.view; });
  const fallback = shots.find(shot => shot.view)?.view;
  if (!fallback) return null;
  shots.forEach(shot => { shot.view ||= fallback; });

  // The player's own skeleton stays loaded but is never drawn.
  player.animationState.clearTracks();
  base.color.a = 0;
  let time = 0;
  pose(time);
  return {
    duration: plan.duration,
    get time() { return time; },
    // Move along; true when the performance wrapped around to its start.
    advance(delta) {
      if (!(delta > 0)) return false;
      time += delta;
      const wrapped = time >= plan.duration;
      if (wrapped) time %= plan.duration;
      pose(time);
      return wrapped;
    },
    seek(seconds) {
      time = ((seconds % plan.duration) + plan.duration) % plan.duration;
      pose(time);
    },
    view() { return shotAt(shots, time).view; },
    draw(renderer) {
      renderer.begin();
      for (const layer of layers) if (layer.visible) renderer.drawSkeleton(layer.skeleton, layer.premultipliedAlpha);
      renderer.end();
    },
  };
}
