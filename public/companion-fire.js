// NIKKE aim skeletons hold an aim pose (aim_idle) and fire single shots
// (aim_fire), with optional hair and hip sway layers while firing. Play a
// steady loop: aim briefly, fire a burst, return to aim, repeat.
const NORMAL_FIRE = ['aim_fire', 'fire'];
const SKILL_FIRE = /skill|burst/i;
const OVERLAYS = ['aim_fire_hair', 'aim_fire_hip'];

export function fireAnimations(data) {
  const find = name => data.findAnimation(name);
  const idle = find('aim_idle') || data.animations.find(animation => /idle/i.test(animation.name));
  const fire = NORMAL_FIRE.map(find).find(Boolean) ||
    data.animations.find(animation => /fire/i.test(animation.name) && !SKILL_FIRE.test(animation.name));
  const overlays = OVERLAYS.map(find).filter(animation => animation && animation.duration > 0);
  return idle && fire ? { idle, fire, overlays } : null;
}

export function queueFireCycle(state, { idle, fire, overlays }, { aim = 1.2, burst = 1.6 } = {}) {
  const shots = Math.max(1, Math.round(burst / Math.max(fire.duration, 0.1)));
  function cycle() {
    const firing = state.addAnimationWith(0, fire, true, aim);
    firing.listener = { start: () => overlays.forEach((overlay, index) => state.setAnimationWith(index + 1, overlay, true)) };
    const aiming = state.addAnimationWith(0, idle, true, shots * fire.duration);
    aiming.listener = {
      start() {
        overlays.forEach((_, index) => state.setEmptyAnimation(index + 1, 0.1));
        cycle();
      },
    };
  }
  cycle();
  return shots;
}
