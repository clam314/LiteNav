import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  performanceActions, compilePerformance, schedulePerformance, performanceLayers, layerPoseAt, shotAt,
} from '../public/companion-performance.js';

const lengths = { cut_A: 5, cut_B: 3, cut_B_coat: 3, cut_1: 2, cut_2: 1, cut_3: 1.5, loop: 2, glow: 4 };
const durationOf = (name, source) => source ? (name === 'glow' ? 4 : undefined) : lengths[name];
const plan = (definitions, name) => schedulePerformance(compilePerformance(definitions, name), durationOf);

test('only definitions that no other definition plays are offered', () => {
  const definitions = [
    { name: 'cut_B_all', composite: [['cut_B', 'cut_B_coat']] },
    { name: 'cut_all', composite: ['cut_A', 'cut_B_all'] },
    { name: 'loop_all', composite: [['loop', { name: 'glow', source: 'spine/cutscenes/x_1/x_1', loop: true }]] },
  ];
  assert.deepEqual(performanceActions(definitions), ['cut_all', 'loop_all']);
  assert.deepEqual(performanceActions(), []);
});

test('sequences play back to back, playDuration cuts short and offsets delay', () => {
  const definitions = [{ name: 'cut_all', composite: [
    { name: 'cut_1', playDuration: 0.7 }, 'cut_2', { name: 'cut_3', offset: 0.5, playDuration: 10 },
  ] }];
  const { segments, duration, shots, missing } = plan(definitions, 'cut_all');
  assert.deepEqual(segments.map(({ name, start, duration, track }) => ({ name, start, duration, track })), [
    { name: 'cut_1', start: 0, duration: 0.7, track: 0 },
    { name: 'cut_2', start: 0.7, duration: 1, track: 0 },
    { name: 'cut_3', start: 2.2, duration: 1.5, track: 0 },
  ], 'playDuration never exceeds the animation; the offset pushes the step back');
  assert.equal(duration, 3.7);
  assert.deepEqual(shots, [{ start: 0, end: 0.7 }, { start: 0.7, end: 1.7 }, { start: 1.7, end: 3.7 }]);
  assert.deepEqual(missing, []);
});

test('parallel steps get their own tracks in layerOrder, and held steps last the whole phase', () => {
  const definitions = [
    { name: 'cut_B_all', composite: [[
      { name: 'cut_B', playDuration: 2.5 },
      { name: 'cut_B_coat', layerOrder: -1 },
      { name: 'cut_2', hold: true },
    ]] },
    { name: 'cut_all', composite: [{ name: 'cut_A', playDuration: 4 }, 'cut_B_all'] },
  ];
  const { segments, duration, shots } = plan(definitions, 'cut_all');
  const byName = Object.fromEntries(segments.map(segment => [segment.name, segment]));
  assert.equal(byName.cut_A.track, 0);
  assert.equal(byName.cut_B_coat.track, 0, 'the lowest layerOrder is drawn first');
  assert.equal(byName.cut_B.track, 1);
  assert.equal(byName.cut_2.track, 2);
  assert.equal(byName.cut_2.holdUntil, 7, 'held until the 3 s phase ends');
  assert.equal(duration, 7);
  assert.deepEqual(shots, [{ start: 0, end: 4 }, { start: 4, end: 7 }], 'a parallel phase is one shot');

  const layers = performanceLayers(segments);
  assert.deepEqual(layers.map(layer => [layer.key, layer.segments.map(segment => segment.name)]),
    [[':0', ['cut_A', 'cut_B_coat']], [':1', ['cut_B']], [':2', ['cut_2']]]);
  assert.deepEqual(layerPoseAt(layers[2], 4.5), { name: 'cut_2', time: 0.5 });
  assert.deepEqual(layerPoseAt(layers[2], 6.5), { name: 'cut_2', time: 1 }, 'a held step keeps its last frame');
  assert.equal(layerPoseAt(layers[1], 6.8), null, 'a finished step leaves the screen');
  assert.equal(layerPoseAt(layers[1], 1), null, 'a later step is not drawn early');
  assert.deepEqual(layerPoseAt(layers[0], 2), { name: 'cut_A', time: 2 });
});

test('looping steps from another skeleton wrap inside their phase; missing animations are reported', () => {
  const source = 'spine/cutscenes/cutscene_char067803_1/cutscene_char067803_1';
  const definitions = [{ name: 'loop_all', composite: [[
    { name: 'cut_A', playDuration: 5 }, { name: 'glow', source, loop: true, playDuration: 1.5 }, 'nope',
  ]] }];
  const { segments, missing } = plan(definitions, 'loop_all');
  const glow = performanceLayers(segments).find(layer => layer.source === source);
  assert.deepEqual(layerPoseAt(glow, 3.2), { name: 'glow', time: 3.2 % 1.5 });
  assert.deepEqual(missing, ['nope']);
});

test('layers between two of their steps hold the earlier one; skins come from the steps', () => {
  const layer = performanceLayers([
    { track: 0, start: 0, duration: 1, name: 'a', source: null },
    { track: 0, start: 2, duration: 1, name: 'b', source: null, skin: 'alt' },
  ])[0];
  assert.equal(layer.skin, 'alt');
  assert.deepEqual(layerPoseAt(layer, 1.5), { name: 'a', time: 1 });
  assert.deepEqual(layerPoseAt(layer, 2.5), { name: 'b', time: 0.5 });
  assert.deepEqual(shotAt([{ start: 0, end: 1 }, { start: 1, end: 3 }], 2), { start: 1, end: 3 });
  assert.deepEqual(shotAt([{ start: 0, end: 1 }], 5), { start: 0, end: 1 }, 'the last shot covers the very end');
});

test('circular and unknown definitions are rejected', () => {
  assert.throws(() => compilePerformance([{ name: 'a', composite: ['b'] }, { name: 'b', composite: ['a'] }], 'a'), /circular/);
  assert.throws(() => compilePerformance([], 'cut_all'), /unknown/);
});

test('the shipped performances compile, and every external source is a pinned cutscene skeleton', () => {
  const data = JSON.parse(readFileSync(new URL('../public/companion/bd2-performances.json', import.meta.url), 'utf8'));
  assert.match(data.commit, /^[a-f0-9]{40}$/);
  assert.equal(data.license, 'MIT');
  const ids = Object.keys(data.costumes);
  assert.ok(ids.length > 100);
  for (const id of ids) {
    assert.match(id, /^char\d{6}$/);
    const definitions = data.costumes[id];
    const actions = performanceActions(definitions);
    assert.ok(actions.length, `${id} offers a performance`);
    for (const name of actions) {
      const { segments, duration } = schedulePerformance(compilePerformance(definitions, name), () => 1);
      assert.ok(segments.length && duration > 0, `${id} ${name}`);
      for (const segment of segments) {
        if (segment.source) assert.match(segment.source, /^spine\/cutscenes\/(cutscene_char\d{6}_\w+)\/\1$/);
      }
    }
  }
});
