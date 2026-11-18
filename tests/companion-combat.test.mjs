import test from 'node:test';
import assert from 'node:assert/strict';
import { combatAnimations, combatSteps, createCombatCycle } from '../public/companion-combat.js';

const animation = (name, duration) => ({ name, duration });
const data = animations => ({ animations, findAnimation: name => animations.find(item => item.name === name) || null });
const cover = data([animation('cover_idle', 2), animation('cover_reload', 1), animation('to_aim', 0.2), animation('to_cover', 0.2)]);
const aim = data([animation('aim_idle', 2), animation('aim_fire', 0.2), animation('aim_fire_hair', 0.7), animation('to_cover', 0.2)]);

function side(name, log) {
  return {
    show: () => log.push(['show', name]),
    state: {
      setAnimationWith: (track, item, loop) => log.push([name, 'set', track, item.name, loop]),
      addAnimationWith: (track, item, loop, delay) => log.push([name, 'add', track, item.name, loop, delay]),
      setEmptyAnimation: (track, mix) => log.push([name, 'empty', track, mix]),
    },
  };
}

test('combat uses both skeletons and needs a cover idle and a normal shot', () => {
  const set = combatAnimations(cover, aim);
  assert.deepEqual(
    [set.coverIdle, set.toAim, set.reload, set.aimIdle, set.fire, set.toCover].map(item => item.name),
    ['cover_idle', 'to_aim', 'cover_reload', 'aim_idle', 'aim_fire', 'to_cover']);
  assert.deepEqual(set.overlays.map(item => item.name), ['aim_fire_hair']);
  assert.equal(set.skill, null);
  assert.equal(combatAnimations(data([animation('cover_reload', 1)]), aim), null);
  assert.equal(combatAnimations(cover, data([animation('aim_idle', 2)])), null);
  assert.equal(combatAnimations(cover, data([...aim.animations, animation('aim_skill_fire', 1)])).skill.name, 'aim_skill_fire');
});

test('a cycle rises to aim, fires, returns to cover and reloads, each transition on the skeleton it leaves', () => {
  const steps = combatSteps(combatAnimations(cover, aim));
  assert.deepEqual(steps.map(step => [step.on, step.show || '', step.play.name]), [
    ['cover', '', 'to_aim'], ['aim', 'aim', 'aim_idle'], ['aim', '', 'aim_fire'], ['aim', '', 'aim_idle'],
    ['aim', '', 'to_cover'], ['cover', 'cover', 'cover_idle'], ['cover', '', 'cover_reload'],
  ]);
  assert.equal(steps[2].hold, 1.15, 'a short shot still fires for at least 1.15 s');
  assert.equal(steps.at(-1).then.name, 'cover_idle', 'reloading returns to the cover idle');
  const skilled = combatSteps(combatAnimations(cover, data([...aim.animations, animation('aim_skill_fire', 1)])));
  assert.deepEqual(skilled.slice(2, 4).map(step => step.play.name), ['aim_fire', 'aim_skill_fire']);
});

test('the cycle follows the frame clock and toggles sway layers only while firing', () => {
  const log = [];
  const cycle = createCombatCycle(combatAnimations(cover, aim), side('cover', log), side('aim', log), { intro: 0.5 });
  assert.deepEqual(log, [['show', 'cover'], ['cover', 'set', 0, 'cover_idle', true]]);
  cycle.advance(0.4);
  assert.equal(log.length, 2, 'nothing changes before the intro ends');
  cycle.advance(0.2);
  assert.deepEqual(log.slice(2), [['cover', 'set', 0, 'to_aim', false]]);
  log.length = 0;
  cycle.advance(0.34 + 0.22);
  assert.deepEqual(log, [
    ['show', 'aim'], ['aim', 'set', 0, 'aim_idle', true], ['aim', 'empty', 1, 0.1],
    ['aim', 'set', 0, 'aim_fire', true], ['aim', 'set', 1, 'aim_fire_hair', true],
  ]);
  log.length = 0;
  cycle.advance(0);
  assert.deepEqual(log, [], 'a paused frame (no delta) does not advance');
  assert.ok(Math.abs(cycle.cycleSeconds - (0.34 + 0.22 + 1.15 + 0.26 + 0.39 + 0.52 + 1.6)) < 1e-9);
});
