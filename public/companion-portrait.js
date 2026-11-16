// The portrait viewer plays its chosen idle for five seconds between reactions.
// Queue directly on the Spine track to keep the idle viewport and playback clock.
export function queuePortraitMotion(state, baseAnimation) {
  const motion = state.data.skeletonData.findAnimation('motion');
  if (!motion || motion === baseAnimation || !Number.isFinite(motion.duration) || motion.duration <= 0) return null;

  function queueCycle() {
    state.addAnimationWith(0, motion, false, 5);
    const idle = state.addAnimationWith(0, baseAnimation, true, motion.duration);
    idle.listener = { start: queueCycle };
  }
  queueCycle();
  return motion;
}
