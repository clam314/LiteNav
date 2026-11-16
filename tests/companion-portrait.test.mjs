import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { queuePortraitMotion } from '../public/companion-portrait.js';

const runtime = readFileSync(new URL('../public/vendor/spine/spine-player-4.1.56.js', import.meta.url), 'utf8');
const spine = runInNewContext(runtime + '\nspine');

function portrait(base = 'idle', motionDuration = 4) {
  const data = new spine.SkeletonData();
  data.animations.push(new spine.Animation(base, [], 4));
  if (base !== 'motion' && motionDuration !== null) {
    data.animations.push(new spine.Animation('motion', [], motionDuration));
  }
  const state = new spine.AnimationState(new spine.AnimationStateData(data));
  const skeleton = new spine.Skeleton(data);
  const start = state.setAnimation(0, base, true);
  const motion = queuePortraitMotion(state, start.animation);
  const advance = (frames, delta = 1 / 16) => {
    for (let i = 0; i < frames; i++) {
      state.update(delta);
      state.apply(skeleton);
    }
    return state.getCurrent(0);
  };
  return { state, motion, advance };
}

test('Sylvia 92 idles for five seconds, plays motion once for four seconds, and repeats', () => {
  const { advance, motion } = portrait();
  assert.equal(advance(79).animation.name, 'idle');
  const firstReaction = advance(2);
  assert.equal(firstReaction.animation, motion);
  assert.equal(firstReaction.loop, false);
  assert.equal(advance(62).animation, motion);
  assert.equal(advance(2).animation.name, 'idle');
  assert.equal(advance(78).animation.name, 'idle');
  assert.equal(advance(2).animation, motion);
  assert.equal(advance(64).animation.name, 'idle');
});

test('a paused track keeps its place and returns to the configured base after the actual motion duration', () => {
  const { advance, motion } = portrait('rest', 1.5);
  assert.equal(advance(48).animation.name, 'rest');
  assert.equal(advance(160, 0).trackTime, 3);
  assert.equal(advance(33).animation, motion);
  const reactionTime = advance(8).trackTime;
  assert.equal(advance(160, 0).trackTime, reactionTime);
  assert.equal(advance(16).animation.name, 'rest');
});

test('a missing, empty, or already selected motion leaves the base loop alone', () => {
  for (const [base, duration] of [['idle', null], ['idle', 0], ['motion', 4]]) {
    const { advance, motion } = portrait(base, duration);
    assert.equal(motion, null);
    const entry = advance(320);
    assert.equal(entry.animation.name, base);
    assert.equal(entry.loop, true);
    assert.equal(entry.next, null);
  }
});

test('clearing the track cancels future portrait reactions', () => {
  const { state, advance } = portrait();
  advance(85);
  state.clearTracks();
  assert.equal(advance(320), null);
});
