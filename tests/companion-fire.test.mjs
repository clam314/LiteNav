import test from 'node:test';
import assert from 'node:assert/strict';
import { fireAnimations, queueFireCycle } from '../public/companion-fire.js';

const animation = (name, duration) => ({ name, duration });
const data = animations => ({ animations, findAnimation: name => animations.find(item => item.name === name) || null });

test('the firing loop uses the aim pose, the normal shot and the sway layers that move', () => {
  const set = data([animation('aim_idle', 2), animation('aim_skill_1', 1), animation('aim_fire', 0.2),
    animation('aim_fire_hair', 0.7), animation('aim_fire_hip', 0), animation('to_cover', 0.2)]);
  const firing = fireAnimations(set);
  assert.equal(firing.idle.name, 'aim_idle');
  assert.equal(firing.fire.name, 'aim_fire');
  assert.deepEqual(firing.overlays.map(item => item.name), ['aim_fire_hair'], 'empty layers are skipped');
  assert.equal(fireAnimations(data([animation('aim_idle', 2), animation('aim_skill_fire', 1)])), null,
    'a skill shot is not the normal firing loop');
  assert.equal(fireAnimations(data([animation('idle', 2), animation('fire', 0.3)])).fire.name, 'fire');
});

test('each cycle aims, fires a burst with sway layers, and returns to the aim', () => {
  const calls = [];
  const entries = [];
  const state = {
    addAnimationWith(track, item, loop, delay) {
      const entry = { track, name: item.name, loop, delay };
      calls.push(['add', track, item.name, loop, delay]);
      entries.push(entry);
      return entry;
    },
    setAnimationWith(track, item, loop) { calls.push(['set', track, item.name, loop]); },
    setEmptyAnimation(track, mix) { calls.push(['empty', track, mix]); },
  };
  const firing = { idle: animation('aim_idle', 2), fire: animation('aim_fire', 0.2), overlays: [animation('aim_fire_hair', 0.7)] };
  const shots = queueFireCycle(state, firing, { aim: 1.2, burst: 1.6 });
  assert.equal(shots, 8);
  assert.deepEqual(calls, [['add', 0, 'aim_fire', true, 1.2], ['add', 0, 'aim_idle', true, 1.6]]);
  entries[0].listener.start();
  assert.deepEqual(calls.at(-1), ['set', 1, 'aim_fire_hair', true]);
  entries[1].listener.start();
  assert.deepEqual(calls.slice(-3), [['empty', 1, 0.1], ['add', 0, 'aim_fire', true, 1.2], ['add', 0, 'aim_idle', true, 1.6]],
    'returning to the aim clears the layers and queues the next cycle');
});
