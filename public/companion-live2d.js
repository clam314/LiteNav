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

// Fill the rail's height with the artwork, stand it on the bottom edge and
// centre it in the space the navigation leaves free. Wide artwork (a scene
// behind the ship) runs past both sides; the rail fades its left edge.
export function placeLive2D(bounds, rail, space, fallback) {
  const usable = [bounds?.minX, bounds?.maxX, bounds?.minY, bounds?.maxY].every(Number.isFinite) &&
    bounds.maxX > bounds.minX && bounds.maxY > bounds.minY;
  const box = usable ? bounds : { minX: 0, maxX: fallback.width, minY: 0, maxY: fallback.height };
  const scale = rail.height / (box.maxY - box.minY);
  const centre = rail.width - Math.min(space, rail.width) / 2;
  return { scale, x: centre - (box.minX + box.maxX) / 2 * scale, y: -box.minY * scale };
}

// Play every reaction once, in a fresh random order each round, never
// repeating the last one across rounds.
export function createActionOrder(actions, random = Math.random) {
  let queue = [];
  let last;
  return function next() {
    if (!actions.length) return null;
    if (!queue.length) {
      queue = [...actions];
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }
      if (queue.length > 1 && queue[0] === last) queue.push(queue.shift());
    }
    last = queue.shift();
    return last;
  };
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
