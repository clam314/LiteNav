// NIKKE's combat loop moves between two skeletons that share one camera, as
// clam314/Nikkiweb's "开火循环展示" does: wait in cover, rise to aim, fire a
// burst (and a skill shot when there is one), drop back to cover and reload.
// Timings follow Nikkiweb. Each transition plays on the skeleton it leaves.
import { fireAnimations } from './companion-fire.js';

const SKILL_FIRE = ['aim_skill_fire', 'skill_fire', 'aim_burst_fire', 'burst_fire', 'aim_fire_skill'];
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function combatAnimations(coverData, aimData) {
  const firing = fireAnimations(aimData);
  const coverIdle = coverData.findAnimation('cover_idle');
  if (!firing || !coverIdle) return null;
  const skill = SKILL_FIRE.map(name => aimData.findAnimation(name)).find(animation => animation?.duration > 0) || null;
  return {
    coverIdle, aimIdle: firing.idle, fire: firing.fire, overlays: firing.overlays, skill,
    toAim: coverData.findAnimation('to_aim'), toCover: aimData.findAnimation('to_cover'),
    reload: coverData.findAnimation('cover_reload'),
  };
}

// One cycle as steps: which skeleton is shown, what it plays, and how long to hold.
export function combatSteps(set) {
  const steps = [];
  // Both transitions carry the figure across the frame (rising to the right,
  // sliding out of cover), which read as a jump once the other pose appeared.
  // The target pose fades in as each transition starts.
  if (set.toAim) {
    steps.push({ on: 'cover', play: set.toAim, loop: false, show: 'aim',
      with: { on: 'aim', play: set.aimIdle, loop: true }, hold: Math.max(0.24, set.toAim.duration + 0.14) + 0.22 });
  } else {
    steps.push({ on: 'aim', show: 'aim', play: set.aimIdle, loop: true, hold: 0.22 });
  }
  steps.push({ on: 'aim', play: set.fire, loop: true, overlays: true, hold: clamp(set.fire.duration * 4.2, 1.15, 1.8) });
  if (set.skill) steps.push({ on: 'aim', play: set.skill, loop: true, hold: clamp(set.skill.duration * 2.6, 1.9, 3.4) });
  steps.push({ on: 'aim', play: set.aimIdle, loop: true, hold: 0.26 });
  if (set.toCover) {
    steps.push({ on: 'aim', play: set.toCover, loop: false, show: 'cover',
      with: { on: 'cover', play: set.coverIdle, loop: true }, hold: Math.max(0.24, set.toCover.duration + 0.19) + 0.52 });
  } else {
    steps.push({ on: 'cover', show: 'cover', play: set.coverIdle, loop: true, hold: 0.52 });
  }
  steps.push(set.reload ?
    { on: 'cover', play: set.reload, loop: false, then: set.coverIdle, hold: set.reload.duration + 0.12 + 0.48 } :
    { on: 'cover', play: set.coverIdle, loop: true, hold: 0.6 });
  return steps;
}

// cover and aim: { state, show() }. advance() is driven by the player's frame
// delta, so the loop pauses with the animation and with hidden pages.
export function createCombatCycle(set, cover, aim, { intro = 0.65 } = {}) {
  const steps = combatSteps(set);
  const sides = { cover, aim };
  let index = -1;
  let remaining = intro;
  cover.show();
  cover.state.setAnimationWith(0, set.coverIdle, true);

  function run(step) {
    const { state } = sides[step.on];
    if (step.with) sides[step.with.on].state.setAnimationWith(0, step.with.play, step.with.loop);
    if (step.show) sides[step.show].show();
    state.setAnimationWith(0, step.play, step.loop);
    if (step.then) state.addAnimationWith(0, step.then, true, 0);
    set.overlays.forEach((overlay, track) => {
      if (step.overlays) state.setAnimationWith(track + 1, overlay, true);
      else if (step.on === 'aim') state.setEmptyAnimation(track + 1, 0.1);
    });
  }

  return {
    cycleSeconds: steps.reduce((total, step) => total + step.hold, 0),
    advance(delta) {
      remaining -= delta;
      while (remaining <= 0) {
        index = (index + 1) % steps.length;
        run(steps[index]);
        remaining += steps[index].hold;
      }
    },
  };
}
