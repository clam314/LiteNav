// Brown Dust 2 full skill performances. BD2-L2D-Viewer (Jelosus2, MIT)
// choreographs each skill from the cuts its cutscene skeleton exports: a
// definition lists phases in order, a phase is one step or several steps
// played together, and a step names an animation (or another definition).
// Steps played together each pose their own copy of the skeleton, so split
// parts (body, hair, glow) draw at once. This module only does the timing;
// drawing stays with the Spine player.
//
// A step is "cut_1" or { name, offset, source, skin, hold, playDuration,
// layerOrder, loop }: offset delays it, playDuration cuts it short, hold and
// loop keep it on screen until its phase ends, layerOrder sorts parallel
// steps back to front, source names another skeleton and skin a skin.

// Definitions no other definition plays are the performances on offer.
export function performanceActions(definitions = []) {
  const names = new Set(definitions.map(definition => definition.name));
  const referenced = new Set();
  const visit = step => {
    if (Array.isArray(step)) step.forEach(visit);
    else if (typeof step === 'string' && names.has(step)) referenced.add(step);
  };
  definitions.forEach(definition => definition.composite.forEach(visit));
  return definitions.filter(definition => !referenced.has(definition.name)).map(definition => definition.name);
}

// Expand a definition into a tree of steps, sequences and parallel phases.
export function compilePerformance(definitions, name, ancestors = []) {
  const byName = new Map(definitions.map(definition => [definition.name, definition]));
  const definition = byName.get(name);
  if (!definition) throw new Error(`unknown performance ${name}`);
  if (ancestors.includes(name)) throw new Error(`circular performance ${[...ancestors, name].join(' -> ')}`);
  const path = [...ancestors, name];
  const step = spec => typeof spec === 'string' && byName.has(spec) ?
    compilePerformance(definitions, spec, path) : { kind: 'step', spec: typeof spec === 'string' ? { name: spec } : spec };
  return {
    kind: 'sequence',
    children: definition.composite.map(phase => Array.isArray(phase) ?
      { kind: 'parallel', children: phase.map(step) } : step(phase)),
  };
}

// Lay the tree out in time, as BD2-L2D-Viewer does. Each branch of a parallel
// phase gets its own track; durationOf(name, source) is the animation's own
// length, or undefined when the skeleton lacks it.
//
// Shots are the camera's time windows: every step or parallel phase reached
// through sequences alone. A parallel phase is one shot however it nests.
export function schedulePerformance(tree, durationOf) {
  const segments = [];
  const missing = [];
  const shots = [];
  const walk = (node, start, track, inParallel = false) => {
    const result = place(node, start, track, inParallel);
    if (!inParallel && node.kind !== 'sequence' && result.duration > 0) shots.push({ start, end: start + result.duration });
    return result;
  };
  const place = (node, start, track, inParallel) => {
    if (node.kind === 'step') {
      const { name, offset = 0, source = null, skin, hold = false, loop = false, playDuration } = node.spec;
      const native = durationOf(name, source);
      if (!(native >= 0)) missing.push(source ? `${source}:${name}` : name);
      const own = Number.isFinite(native) ? native : 0;
      const duration = playDuration > 0 ? Math.min(playDuration, own) : own;
      segments.push({ track, start: start + offset, duration, name, source, skin, hold, loop });
      return { duration: Math.max(duration + offset, 0), tracks: 1, steps: [segments.at(-1)] };
    }
    if (node.kind === 'sequence') {
      let elapsed = 0;
      let tracks = 1;
      for (const child of node.children) {
        const result = walk(child, start + elapsed, track, inParallel);
        elapsed += result.duration;
        tracks = Math.max(tracks, result.tracks);
      }
      return { duration: elapsed, tracks };
    }
    const order = index => node.children[index].kind === 'step' && Number.isFinite(node.children[index].spec.layerOrder) ?
      node.children[index].spec.layerOrder : 0;
    const ordered = node.children.map((_, index) => index).sort((a, b) => order(a) - order(b) || a - b);
    let next = track;
    let duration = 0;
    const kept = [];
    for (const index of ordered) {
      const child = node.children[index];
      const result = walk(child, start, next, true);
      duration = Math.max(duration, result.duration);
      next += Math.max(result.tracks, 1);
      if (child.kind === 'step' && (child.spec.hold || child.spec.loop)) kept.push(...result.steps);
    }
    // Held and looping steps stay on screen until the whole phase is over.
    for (const segment of kept) segment.holdUntil = start + duration;
    return { duration, tracks: Math.max(next - track, 1) };
  };
  const { duration } = walk(tree, 0, 0);
  return { segments, duration, missing, shots };
}

const segmentEnd = segment => segment.holdUntil ?? segment.start + segment.duration;

// Group segments into layers, one skeleton copy each, drawn back to front.
export function performanceLayers(segments) {
  const layers = new Map();
  for (const segment of segments) {
    const key = `${segment.source ?? ''}:${segment.track}`;
    if (!layers.has(key)) layers.set(key, { key, track: segment.track, source: segment.source, segments: [] });
    layers.get(key).segments.push(segment);
  }
  return [...layers.values()].map(layer => ({
    ...layer,
    skin: layer.segments.find(segment => segment.skin)?.skin,
    segments: layer.segments.sort((a, b) => a.start - b.start),
  })).sort((a, b) => a.track - b.track || a.segments[0].start - b.segments[0].start);
}

// What a layer shows at time t: { name, time } in the animation, or null
// while the layer is off screen. Between two of its steps the previous one
// holds its last frame.
export function layerPoseAt(layer, t) {
  const EPSILON = 1e-4;
  const { segments } = layer;
  const end = Math.max(...segments.map(segmentEnd));
  if (t < segments[0].start - EPSILON || t > end + EPSILON) return null;
  const current = segments.find(segment => segmentEnd(segment) > t) || segments.at(-1);
  if (t < current.start - EPSILON) {
    const previous = segments[segments.indexOf(current) - 1];
    return previous ? { name: previous.name, time: previous.duration } : null;
  }
  const local = Math.max(0, t - current.start);
  const time = current.loop && current.duration > 0 ? local % current.duration : Math.min(current.duration, local);
  return { name: current.name, time };
}

// The shot playing at time t.
export function shotAt(shots, t) {
  return shots.find(shot => t < shot.end) || shots.at(-1);
}
