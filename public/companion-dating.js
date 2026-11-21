// Brown Dust 2 "有缘之客" (dating) scenes. Each scene skeleton has stages: an
// idle per stage (idle1, idle2, …), touch reactions on that stage
// (mix{stage}_{reaction}_{part}, played part after part over the idle) and
// transitions to the next stage (motion{stage}_{n}). The game moves on when
// the player touches the right places; the companion has no touches, so it
// tours the scene: every reaction of a stage once, in a random order, then
// the transition, and from the last stage back to the first.

import { drawnBounds, drawnParts, withoutBackdrops, shotBox, EFFECT_SLOT } from './companion-performance-player.js';

const IDLE = /^idle(\d+)$/;
const REACTION = /^mix(\d+)_(\d+)_(\w+)$/;
const MOTION = /^motion(\d+)_(\d+)$/;

const byNumber = (a, b) => a - b;
// Parts are numbered; an "end" part closes the reaction.
const partOrder = part => /^\d+$/.test(part) ? Number(part) : Number.MAX_SAFE_INTEGER;

export function datingScript(names) {
  const stages = new Map();
  const stage = number => {
    if (!stages.has(number)) stages.set(number, { number, idle: null, reactions: new Map(), motions: [] });
    return stages.get(number);
  };
  for (const name of names) {
    let match;
    if ((match = IDLE.exec(name))) stage(Number(match[1])).idle = name;
    else if ((match = REACTION.exec(name))) {
      const reactions = stage(Number(match[1])).reactions;
      const key = Number(match[2]);
      if (!reactions.has(key)) reactions.set(key, []);
      reactions.get(key).push({ name, order: partOrder(match[3]) });
    } else if ((match = MOTION.exec(name))) stage(Number(match[1])).motions.push({ name, order: Number(match[2]) });
  }
  return [...stages.values()].filter(stage => stage.idle).sort((a, b) => a.number - b.number).map(stage => ({
    idle: stage.idle,
    reactions: [...stage.reactions.keys()].sort(byNumber)
      .map(key => stage.reactions.get(key).sort((a, b) => a.order - b.order).map(part => part.name)),
    motion: stage.motions.sort((a, b) => a.order - b.order)[0]?.name ?? null,
  }));
}

// The tour as a list of steps: { stage, idle } starts a stage, { stage, key,
// reaction: [parts] } plays the stage's reaction number key, { stage, motion }
// moves on. A stage's transition is skipped when it is the last stage or has
// none. The tour starts at stage from (an index), without the reactions of
// that stage listed in played, and ends with the last stage.
export function datingTour(script, random = Math.random, from = 0, played = []) {
  const steps = [];
  script.forEach((stage, index) => {
    if (index < from) return;
    steps.push({ stage: index, idle: stage.idle });
    const pool = stage.reactions.map((reaction, key) => ({ key, reaction }))
      .filter(({ key }) => index !== from || !played.includes(key));
    while (pool.length) {
      const { key, reaction } = pool.splice(Math.floor(random() * pool.length), 1)[0];
      steps.push({ stage: index, key, reaction });
    }
    if (stage.motion && index < script.length - 1) steps.push({ stage: index, motion: stage.motion });
  });
  return steps;
}

// The skin each stage wears when a scene keeps its artwork in skins: the
// one holding most of the attachments its idle and reactions switch to,
// cover(skin, animation names) counting them. Names do not tell: 安洁莉卡
// 「霓虹救星」's second stage wears idle1_2, not a skin named after idle2. A
// stage no skin serves keeps the one before (the first, the first skin).
export function stageSkins(script, skins, cover) {
  let carried = null;
  return script.map(stage => {
    const names = [stage.idle, ...stage.reactions.flat()];
    let best = null;
    let most = 0;
    for (const skin of skins) {
      const count = cover(skin, names);
      if (count > most) { best = skin; most = count; }
    }
    carried = best ?? carried ?? skins[0] ?? null;
    return carried;
  });
}

const FRAME_SLOT = /black|^bk\d*$|^fr\b/i;

// The camera box of a scene's picture from its drawn parts, or null. Slots of
// a solid backdrop that was dropped are added to backdrops.
export function scenePicture(parts, backdrops = new Set()) {
  const covers = part => part.minX <= 0 && part.maxX >= 0 && part.minY <= 0 && part.maxY >= 0;
  // Black frame pieces on all four sides of the origin leave a window: that
  // is exactly what the game shows.
  const pieces = parts.filter(part => FRAME_SLOT.test(part.slot));
  const across = (low, high) => low < 0 && high > 0;
  const edge = (pick, test, reduce) => {
    const values = pieces.filter(test).map(pick);
    return values.length ? reduce(...values) : NaN;
  };
  const left = edge(part => part.maxX, part => part.maxX <= 0 && across(part.minY, part.maxY), Math.max);
  const right = edge(part => part.minX, part => part.minX >= 0 && across(part.minY, part.maxY), Math.min);
  const bottom = edge(part => part.maxY, part => part.maxY <= 0 && across(part.minX, part.maxX), Math.max);
  const top = edge(part => part.minY, part => part.minY >= 0 && across(part.minX, part.maxX), Math.min);
  if ([left, right, bottom, top].every(Number.isFinite)) return { x: left, y: bottom, width: right - left, height: top - bottom };
  const area = part => (part.maxX - part.minX) * (part.maxY - part.minY);
  let kept = withoutBackdrops(parts);
  // A black frame over the scene with a window in it (B_BG_black, BK, Black,
  // fr) is as large as a picture; its name gives it away.
  const largest = kept[0] ? area(kept[0]) : 0;
  kept = kept.filter(part => !(FRAME_SLOT.test(part.slot) && covers(part) && area(part) >= largest / 2));
  for (const part of parts) if (!kept.includes(part)) backdrops.add(part.slot);
  const picture = kept.length > 1 && kept.find(covers);
  return picture ? { x: picture.minX, y: picture.minY, width: picture.maxX - picture.minX, height: picture.maxY - picture.minY } : null;
}

// Seconds of idle before each reaction.
const GAP = 2;
const SAMPLES = 24;

// Tours a scene on a SpinePlayer whose skeleton is the scene. tracks plays
// reactions over the idle on a second track, as the game does for these
// scenes. Same shape as a skill performance: advance(delta) is true at a
// natural break, here between two steps, when the figure is in its bare
// idle, and view() is the camera of the current stage. A stage holds up to
// fifty reactions and can run for minutes, so the companion may leave at any
// break: onProgress({ stage, played }) reports each one, and resume (the same
// shape) continues a later visit with the reactions not yet played.
export function createDatingTour({ spine, player, tracks = true, random = Math.random, resume = null, onProgress = () => {} }) {
  const data = player.skeleton.data;
  const script = datingScript(data.animations.map(animation => animation.name));
  if (!script.length) return null;
  const state = player.animationState;
  const length = name => data.findAnimation(name)?.duration || 0;

  // One camera per stage. Scenes are drawn around the origin: the picture is
  // the largest part covering it once a solid letterbox backdrop is gone
  // (letterbox frames made of four pieces never cover it). The backdrop slots
  // are hidden while the scene plays. Without a picture, frame the figure.
  const probe = new spine.Skeleton(data);
  // Scenes keep alternative parts in skins: a whole look per stage (安洁莉卡
  // 「霓虹救星」, whose default skin draws nothing), or one item in several
  // versions next to the default skin (奥利维尔「传奇退役」's wand, 黎维塔
  // 「服装 92」's inner layer, 尤里「服装 93」's phone, 悠丝缇亚「服装 96」's arm and
  // towel). Without one, those parts are not drawn at all; with all of them,
  // the versions overlap. Each stage wears the skin that holds most of its
  // attachments (see stageSkins), over the default skin, which the runtime
  // falls back to; a transition wears both stages' skins.
  const initial = player.skeleton.skin || data.defaultSkin;
  const holds = new Map(data.skins.map(skin => [skin, new Set(skin.getAttachments().map(entry => entry.slotIndex + ':' + entry.name))]));
  // Distinct attachments, so one switched on every frame counts once.
  const cover = (skin, names) => {
    const keys = new Set();
    for (const name of names) {
      for (const timeline of data.findAnimation(name)?.timelines || []) {
        for (const attachment of timeline.attachmentNames || []) if (attachment) keys.add(timeline.slotIndex + ':' + attachment);
      }
    }
    let count = 0;
    for (const key of keys) if (holds.get(skin).has(key)) count += 1;
    return count;
  };
  const skins = stageSkins(script, data.skins.filter(skin => skin !== data.defaultSkin && skin.getAttachments().length), cover)
    .map(skin => skin || initial);
  // A transition turns one stage's look into the next, keyed in both skins
  // (安洁莉卡「霓虹救星」 from idle1_2 to idle3_1), so it wears the two together.
  const crossings = script.map((stage, index) => {
    const from = skins[index];
    const to = skins[index + 1];
    if (!stage.motion || !to || from === to) return null;
    const both = new spine.Skin(from.name + '+' + to.name);
    both.addSkin(from);
    both.addSkin(to);
    return both;
  });
  const backdrops = new Set();
  const views = script.map((stage, index) => {
    const animation = data.findAnimation(stage.idle);
    // Some scenes fade in from nothing, so look halfway through the idle.
    const middle = animation.duration / 2;
    probe.setSkin(skins[index]);
    probe.setToSetupPose();
    animation.apply(probe, middle, middle, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
    probe.updateWorldTransform();
    // Backdrops found in an earlier stage are hidden in every stage, so a
    // later stage is framed without them: 安洁莉卡「霓虹救星」's second stage
    // keeps two of them, and the smaller would pass for its picture.
    const picture = scenePicture(drawnParts([probe]).filter(part => !backdrops.has(part.slot)), backdrops);
    if (picture) return picture;
    const frames = [];
    probe.setSkin(skins[index]);
    for (let i = 0; i <= SAMPLES; i++) {
      const time = animation.duration * i / SAMPLES;
      probe.setToSetupPose();
      animation.apply(probe, time, time, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
      probe.updateWorldTransform();
      const figure = drawnBounds([probe], EFFECT_SLOT);
      frames.push(Number.isFinite(figure.minX) ? figure : drawnBounds([probe]));
    }
    return shotBox(frames);
  });
  const fallback = views.find(Boolean);
  if (!fallback) return null;

  let steps = [];
  let index = 0;
  let wait = 0;
  let stage = 0;
  const run = step => {
    stage = step.stage;
    if (step.idle) {
      if (player.skeleton.skin !== skins[stage]) {
        player.skeleton.setSkin(skins[stage]);
        player.skeleton.setSlotsToSetupPose();
      }
      state.clearTrack(1);
      state.setAnimation(0, step.idle, true);
      return GAP;
    }
    if (step.motion) {
      if (crossings[stage]) player.skeleton.setSkin(crossings[stage]);
      state.clearTrack(1);
      state.setAnimation(0, step.motion, false);
      return length(step.motion);
    }
    const [first, ...rest] = step.reaction;
    const track = tracks ? 1 : 0;
    state.setAnimation(track, first, false);
    for (const part of rest) state.addAnimation(track, part, false, 0);
    // Back to the bare idle once the reaction is over.
    if (tracks) state.addEmptyAnimation(1, 0, 0);
    else state.addAnimation(0, script[step.stage].idle, true, 0);
    return step.reaction.reduce((sum, part) => sum + length(part), 0) + GAP;
  };
  // Start at a stage: the transitions of the stages before it leave their
  // last pose (clothes shed, a turn), so pose the skeleton through them first.
  let played = [];
  const restart = (from = 0, done = []) => {
    state.clearTracks();
    const skeleton = player.skeleton;
    skeleton.setToSetupPose();
    if (skins[from] && skeleton.skin !== skins[from]) {
      skeleton.setSkin(skins[from]);
      skeleton.setSlotsToSetupPose();
    }
    for (const stage of script.slice(0, from)) {
      const motion = stage.motion && data.findAnimation(stage.motion);
      motion?.apply(skeleton, motion.duration, motion.duration, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
    }
    played = [...done];
    steps = datingTour(script, random, from, played);
    index = 0;
    wait = run(steps[0]);
  };
  const startAt = Number.isInteger(resume?.stage) && resume.stage > 0 && resume.stage < script.length ? resume.stage : 0;
  restart(startAt, startAt === (resume?.stage ?? 0) && Array.isArray(resume?.played) ? resume.played : []);
  const progress = () => onProgress({ stage, played: [...played] });
  progress();
  const tourLength = datingTour(script, random).reduce((sum, step) => sum + (step.idle ? GAP : step.motion ? length(step.motion) :
    step.reaction.reduce((total, part) => total + length(part), 0) + GAP), 0);
  return {
    duration: tourLength,
    view: () => views[stage] || fallback,
    advance(delta) {
      if (!(delta > 0)) return false;
      wait -= delta;
      let moved = false;
      while (wait <= 0) {
        if (steps[index].reaction) played.push(steps[index].key);
        index += 1;
        moved = true;
        if (index >= steps.length) {
          restart(0);
          break;
        }
        if (steps[index].idle) played = [];
        wait += run(steps[index]);
      }
      if (moved) progress();
      return moved;
    },
    stage: () => stage,
    // Runs after the pose is applied and before drawing.
    update(skeleton) {
      if (!backdrops.size) return;
      for (const slot of skeleton.slots) if (backdrops.has(slot.data.name)) slot.attachment = null;
    },
    seek() { /* A still frame stays on the first stage's idle. */ },
    draw() { /* The player draws the scene skeleton itself. */ },
  };
}
