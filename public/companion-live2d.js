// Azur Lane ships come as Live2D (Cubism) models instead of Spine skeletons.
// These helpers decide what to play, which files to fetch and where to place
// the figure; companion-live2d-player.js does the drawing.

// Reactions the game plays on its main screen and when the ship is touched.
// L2D+ models add drag states (idleN, touch_idleN, touch_dragN) that only make
// sense while dragging, so they are not played here.
const ACTION = /^(?:home|login|mail|mission|mission_complete|complete|touch_(?:head|body|special)|main_\d+)$/;

// idle loops on the base track; effect is a separate ambient loop (ribbons,
// glows) that the game runs alongside every other motion.
export function live2dMotionPlan(motions) {
  const groups = Object.keys(motions || {}).filter(name => motions[name]?.[0]?.File);
  return {
    idle: groups.includes('idle') ? 'idle' : null,
    effect: groups.includes('effect') ? 'effect' : null,
    actions: groups.filter(name => ACTION.test(name)),
  };
}

// The Cubism framework reads a motion's curves as one run of model curves,
// then parameters, then part opacities, each run ending at the first curve of
// another kind. Half the Azur Lane models interleave them (parameters, parts,
// more parameters, more parts), so everything after the first change was
// skipped: part of the movement, and the part switches that hide one of two
// poses (爱宕「盛夏进行曲」 showed four hands). The same curves, stably ordered
// by kind; a motion already in order comes back as it is.
const CURVE_KINDS = ['Model', 'Parameter', 'PartOpacity'];
export function orderMotionCurves(motion) {
  if (!Array.isArray(motion?.Curves)) return motion;
  const rank = curve => {
    const kind = CURVE_KINDS.indexOf(curve?.Target);
    return kind < 0 ? CURVE_KINDS.length : kind;
  };
  const ranked = motion.Curves.map((curve, index) => ({ curve, index, rank: rank(curve) }));
  if (ranked.every((entry, index) => index === 0 || ranked[index - 1].rank <= entry.rank)) return motion;
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return { ...motion, Curves: ranked.map(entry => entry.curve) };
}

// The files a model needs, relative to its folder. The moc and textures are
// Git LFS objects, which raw.githubusercontent.com serves only as pointers.
export function live2dFiles(settings, plan) {
  const refs = settings.FileReferences || {};
  if (!refs.Moc || !refs.Textures?.length) throw new Error('角色模型配置不完整');
  const motions = [plan.idle, plan.effect, ...plan.actions].filter(Boolean).map(group => refs.Motions[group][0].File);
  return [
    { path: refs.Moc, lfs: true },
    ...refs.Textures.map(path => ({ path, lfs: true })),
    ...(refs.Physics ? [{ path: refs.Physics, lfs: false }] : []),
    ...motions.map(path => ({ path, lfs: false })),
  ];
}

// A copy of the settings that only lists the planned motions, with every file
// replaced by the URL that serves it.
export function withLive2DFiles(settings, plan, urls) {
  const refs = settings.FileReferences;
  const url = path => {
    if (!urls[path]) throw new Error('角色模型文件缺失');
    return urls[path];
  };
  const motions = {};
  for (const group of [plan.idle, plan.effect, ...plan.actions].filter(Boolean)) {
    motions[group] = [{ ...refs.Motions[group][0], File: url(refs.Motions[group][0].File) }];
  }
  return {
    ...settings,
    FileReferences: {
      Moc: url(refs.Moc),
      Textures: refs.Textures.map(url),
      ...(refs.Physics ? { Physics: url(refs.Physics) } : {}),
      Motions: motions,
    },
  };
}

// Touch targets of L2D+ models (TouchHead, TouchDrag3, TouchIdle12, …) are
// meshes with a transparent texture, some parked far outside the canvas.
const TOUCH_TARGET = /^touch/i;

// Extent of the drawn meshes, in model pixels (y down), within the model's
// canvas. Hidden, nearly transparent and touch-target meshes do not count.
export function live2dArtBounds(drawables, canvas, bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }) {
  const clip = (value, size) => Math.max(0, Math.min(size, value));
  for (const { id, vertices, opacity, visible } of drawables) {
    if (!visible || !(opacity >= 0.02) || TOUCH_TARGET.test(id)) continue;
    for (let i = 0; i < vertices.length; i += 2) {
      const x = clip(vertices[i], canvas.width);
      const y = clip(vertices[i + 1], canvas.height);
      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  }
  return bounds;
}

// The action display's box: the idle box with its top raised to where the
// reactions reach most of the time (share of their frames stay below it).
// The figure keeps standing on its idle floor at its idle centre; a moment
// past that top (a flick of hair, a splash) and close-ups that fill the
// canvas, which the canvas clip frames, do not shrink it.
export function reactionFraming(idle, frames, canvas, share = 0.9) {
  const box = { ...idle };
  if (![idle?.minY, idle?.maxY].every(Number.isFinite)) return box;
  const fillsCanvas = frame => [frame.minX <= 1, frame.minY <= 1, frame.maxX >= canvas.width - 1,
    frame.maxY >= canvas.height - 1].filter(Boolean).length >= 3;
  const tops = frames.filter(frame => Number.isFinite(frame.minY) && !fillsCanvas(frame))
    .map(frame => frame.minY).sort((a, b) => a - b);
  if (tops.length) box.minY = Math.min(idle.minY, tops[Math.floor(tops.length * (1 - share))]);
  return box;
}

// A scene is never enlarged more than this to fill the rail with its background.
export const MAX_COVER_ZOOM = 1.6;

// Fill the rail's height with the artwork, stand it on the bottom edge and
// centre it in the space the navigation leaves free. Wide artwork (a scene
// behind the ship) runs past both sides; the rail fades its left edge.
// cover ({ minY, maxY, anchorX }, model pixels) is a scene's background band
// (see backgroundBand): that band then fills the height instead, unless it
// would take more than MAX_COVER_ZOOM. The point anchorX (the head) keeps its
// place across the rail, so enlarging never pushes the figure under the
// navigation; without it, the middle of the art does.
export function placeLive2D(bounds, rail, space, fallback, cover = null) {
  const usable = [bounds?.minX, bounds?.maxX, bounds?.minY, bounds?.maxY].every(Number.isFinite) &&
    bounds.maxX > bounds.minX && bounds.maxY > bounds.minY;
  const box = usable ? bounds : { minX: 0, maxX: fallback.width, minY: 0, maxY: fallback.height };
  const centre = rail.width - Math.min(space, rail.width) / 2;
  const plain = rail.height / (box.maxY - box.minY);
  const banded = cover && cover.maxY > cover.minY ? rail.height / (cover.maxY - cover.minY) : 0;
  const zoomed = banded > plain && banded <= plain * MAX_COVER_ZOOM;
  const middle = (box.minX + box.maxX) / 2;
  const x = centre - middle * plain;
  if (!zoomed) return { scale: plain, x, y: -box.minY * plain };
  const anchor = Number.isFinite(cover.anchorX) ? cover.anchorX : middle;
  return { scale: banded, x: x + anchor * plain - anchor * banded, y: -cover.minY * banded };
}

// Where a scene's background lies on the rail, from the first frame drawn at
// the plain framing: mask holds its opacity (0–255), columns × rows, top row
// first. Only the part of the rail the navigation leaves visible counts (from
// the share `from` of its width). A figure on its own (the rail mostly bare)
// gives null; a scene gives the longest run of rows its background covers
// all but a sliver of ({ top, bottom }, shares of the height). Backgrounds
// are landscape and figures and props stick out above or below them, and
// some end in a painted edge (a brushed pool, a slanted room); the band
// leaves those rows out, but never cuts above `keep` (the top of the head,
// a share of the height): a head above the background stays in view. A band
// below `least` of the height gives null too.
export function backgroundBand(mask, columns, rows, { from = 0.5, solid = 0.93, scene = 0.6, least = 0.55, keep = 1 } = {}) {
  const left = Math.floor(columns * from);
  const span = columns - left;
  const filled = row => {
    let count = 0;
    for (let column = left; column < columns; column++) if (mask[row * columns + column] >= 200) count += 1;
    return count / span;
  };
  const shares = Array.from({ length: rows }, (_, row) => filled(row));
  if (shares.reduce((sum, share) => sum + share, 0) < scene * rows) return null;
  let best = null;
  let start = -1;
  for (let row = 0; row <= rows; row++) {
    const inside = row < rows && shares[row] >= solid;
    if (inside && start < 0) start = row;
    if (!inside && start >= 0) {
      if (!best || row - start > best.bottom - best.top) best = { top: start, bottom: row };
      start = -1;
    }
  }
  if (!best) return null;
  const top = Math.min(best.top / rows, Math.max(0, keep));
  const bottom = best.bottom / rows;
  return bottom - top >= least ? { top, bottom } : null;
}

// Play every reaction once, in a fresh random order each round, never
// repeating the last one across rounds. next.progress() is the round so far
// ({ queue, last }: positions in actions still to play and the one played
// last); passing it back as resume continues that round on a later visit.
export function createActionOrder(actions, random = Math.random, resume = null) {
  const valid = index => Number.isInteger(index) && index >= 0 && index < actions.length;
  let queue = Array.isArray(resume?.queue) ? [...new Set(resume.queue.filter(valid))] : [];
  let last = valid(resume?.last) ? resume.last : undefined;
  function next() {
    if (!actions.length) return null;
    if (!queue.length) {
      queue = actions.map((_, index) => index);
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }
      if (queue.length > 1 && queue[0] === last) queue.push(queue.shift());
    }
    last = queue.shift();
    return actions[last];
  }
  next.progress = () => ({ queue: [...queue], last: last ?? null });
  return next;
}

// Where the eyes look, as the focus the model's head and eyes turn toward
// (-1…1, y up). pointer and bounds are in model pixels (y down). The face
// sits near the top of the figure; the turn grows with the pointer's
// distance from it and stays below the model's full range, so a pointer
// resting on the navigation does not wrench the head aside.
export function gazeFocus(pointer, bounds, strength = 0.8) {
  if (![bounds?.minX, bounds?.maxX, bounds?.minY, bounds?.maxY].every(Number.isFinite)) return { x: 0, y: 0 };
  const height = bounds.maxY - bounds.minY;
  const reach = height * 0.6;
  if (!(reach > 0)) return { x: 0, y: 0 };
  let x = (pointer.x - (bounds.minX + bounds.maxX) / 2) / reach;
  let y = (bounds.minY + height * 0.2 - pointer.y) / reach;
  const length = Math.hypot(x, y);
  if (length > 1) {
    x /= length;
    y /= length;
  }
  return { x: x * strength, y: y * strength };
}
