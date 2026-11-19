import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { datingScript, datingTour, scenePicture } from '../public/companion-dating.js';
import { figureBounds, withoutBackdrops, shotBox, performanceMenu, performanceId, performanceSources, EFFECT_SLOT }
  from '../public/companion-performance-player.js';

const names = 'idle1 idle2 idle3 loop 01 mix1_1_1 mix1_1_2 mix1_2_1 mix1_8_10 mix1_8_2 mix1_8_end mix2_1_1 mix2_22_1 mix3_1_1 motion1_18 motion2_22'.split(' ');

test('a scene is read as stages with their reactions, parts in order, and transitions', () => {
  assert.deepEqual(datingScript(names), [
    { idle: 'idle1', reactions: [['mix1_1_1', 'mix1_1_2'], ['mix1_2_1'], ['mix1_8_2', 'mix1_8_10', 'mix1_8_end']], motion: 'motion1_18' },
    { idle: 'idle2', reactions: [['mix2_1_1'], ['mix2_22_1']], motion: 'motion2_22' },
    { idle: 'idle3', reactions: [['mix3_1_1']], motion: null },
  ]);
  assert.deepEqual(datingScript(['loop', 'mix1_1_1']), [], 'reactions without a stage idle are not a scene');
});

test('the tour plays a few reactions per stage and moves on, never past the last stage', () => {
  const steps = datingTour(datingScript(names), 2, () => 0);
  assert.deepEqual(steps, [
    { stage: 0, idle: 'idle1' },
    { stage: 0, reaction: ['mix1_1_1', 'mix1_1_2'] },
    { stage: 0, reaction: ['mix1_2_1'] },
    { stage: 0, motion: 'motion1_18' },
    { stage: 1, idle: 'idle2' },
    { stage: 1, reaction: ['mix2_1_1'] },
    { stage: 1, reaction: ['mix2_22_1'] },
    { stage: 1, motion: 'motion2_22' },
    { stage: 2, idle: 'idle3' },
    { stage: 2, reaction: ['mix3_1_1'] },
  ]);
  const picked = datingTour(datingScript(names), 3, () => .99).filter(step => step.stage === 0 && step.reaction);
  assert.equal(new Set(picked.map(step => step.reaction[0])).size, 3, 'a stage never repeats a reaction');
});

const part = (slot, minX, minY, maxX, maxY) => ({ slot, minX, minY, maxX, maxY });

test('a scene is framed by the picture around its origin once a solid letterbox is dropped', () => {
  const backdrops = new Set();
  const parts = [
    part('B_BG_black', -10671, -6674, 14081, 6384),
    part('B_BG_1', -1815, -2048, 1779, 1948),
    part('S_bg', -6886, -2050, -3292, 1946),
    part('body', -500, -900, 600, 900),
  ];
  assert.deepEqual(scenePicture(parts, backdrops), { x: -1815, y: -2048, width: 3594, height: 3996 });
  assert.deepEqual([...backdrops], ['B_BG_black']);

  // Letterbox frames in four pieces leave a window around the origin.
  const framed = [
    part('B_BG_black', -2000, -9000, 2000, -1800), part('B_BG_black2', 1600, -9000, 9000, 9000),
    part('B_BG_black3', -2000, 1800, 2000, 9000), part('B_BG_black4', -9000, -9000, -1600, 9000),
    part('bg', -1617, -1627, 1622, 1651), part('body', -400, -800, 500, 800),
  ];
  assert.deepEqual(scenePicture(framed), { x: -1600, y: -1800, width: 3200, height: 3600 });
  // Without a background, the window is still the scene.
  const window = [
    part('black glow side_re3', -9643, -8645, 8505, -1848), part('black glow side_re', -9247, -8857, -2139, 6173),
    part('black glow side_re2', 2146, -8796, 8296, 6119), part('black glow side_re4', -8443, 1873, 7721, 5932),
    part('Wh_fabric_4', -2741, -153, 203, 2405), part('body', -900, -1200, 1300, 900),
  ];
  assert.deepEqual(scenePicture(window), { x: -2139, y: -1848, width: 4285, height: 3721 });
  assert.equal(scenePicture([part('body', 100, 100, 400, 900)]), null, 'no picture: frame the figure instead');

  // A black frame with a window, as large as a picture, is told apart by name.
  const windowed = new Set();
  assert.deepEqual(scenePicture([part('fr (1013)', -3996, -8160, 3996, 7153), part('BG_top', -2601, 2245, 2601, 6747),
    part('BG_mid', -2601, -2251, 2601, 2251), part('BG_bottom', -2601, -6751, 2601, -2249), part('ID1_bed', -2601, -2560, 2601, -640)],
  windowed), { x: -2601, y: -2251, width: 5202, height: 4502 });
  assert.deepEqual([...windowed], ['fr (1013)']);
});

test('a frame ignores a dwarfing backdrop and parts flung far from the figure', () => {
  assert.deepEqual(withoutBackdrops([part('a', 0, 0, 10, 10), part('huge', -500, -500, 500, 500)]).map(p => p.slot), ['a']);
  // A scene's own background dwarfs each figure part but not the figure as a whole.
  const scene = [part('bg', -1700, -2000, 1700, 2000), part('leg', -400, -900, 300, -300), part('body', -300, -300, 500, 400),
    part('head', -100, 400, 300, 900)];
  assert.deepEqual(withoutBackdrops(scene).map(p => p.slot), ['bg', 'body', 'leg', 'head']);
  const body = Array.from({ length: 12 }, (_, i) => part('p' + i, i * 10, 0, i * 10 + 40, 300));
  const flung = [...body, part('chain', -17000, 100, -16900, 200), part('chain2', 12000, 100, 12100, 200)];
  assert.deepEqual(figureBounds(flung), { minX: 0, maxX: 150, minY: 0, maxY: 300 });
  assert.deepEqual(figureBounds(body.slice(0, 2).concat(part('far', 5000, 0, 5100, 10))),
    { minX: 0, maxX: 5100, minY: 0, maxY: 300 }, 'too few parts to call any of them stray');
});

test('a shot box takes the steady extent with margins and stays near the median frame', () => {
  const steady = { minX: -100, maxX: 100, minY: 0, maxY: 400 };
  const frames = [...Array(20).fill(steady), ...Array(5).fill({ minX: -9000, maxX: 9000, minY: -50, maxY: 5000 })];
  const box = shotBox(frames);
  // The flourish frames are 20% of the shot: the percentiles catch them, and
  // the median frame keeps every edge within half its size (the 50 below
  // the floor is within reach, the 9000 to the sides is not).
  assert.deepEqual(box, { x: -200 - 400 * .05, y: -50, width: 400 * 1.1, height: 650 * 1.05 });
  assert.equal(shotBox([{ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }]), null);
});

test('effect slots are told apart from the figure by name', () => {
  for (const name of ['shadow', 'footprint', 'B_wind_01', 'breath_03', 'A_weapon_effect', 'B_eye_eff_l', 'A_eye_r_glrow', 'r_foot_snow01', '레이어 47'])
    assert.match(name, EFFECT_SLOT, name);
  for (const name of ['B_body', 'hair_back01', 'A_weapon', 'chest_02', 'cloak_top01', 'deco_02'])
    assert.doesNotMatch(name, EFFECT_SLOT, name);
});

test('the skill menu keeps the showcase loops, with layered loops in place of their plain loop', () => {
  const definitions = [
    { name: 'cut_all', composite: ['cut_1', 'cut_2'] },
    { name: 'loop_2_all', composite: [['loop_2', 'loop_2_glow']] },
    { name: 'loop_all', composite: [['loop', 'missing']] },
  ];
  const lengths = { cut_1: 1, cut_2: 1, loop_2: 2, loop_2_glow: 2, loop: 2 };
  const menu = performanceMenu(definitions, [{ name: 'loop' }, { name: 'loop_2' }], name => lengths[name],
    name => ({ loop_2: '技能动作 2' })[name]);
  assert.deepEqual(menu, [
    { name: 'loop' },
    { name: 'loop_2_all', label: '技能动作 2', replaces: 'loop_2', performance: true },
  ], 'full performances of the cuts are not offered, and a composition naming a missing animation keeps the plain loop');
});

test('performance ids and borrowed skeletons are read from the data', () => {
  assert.equal(performanceId({ skeleton: 'spine/cutscenes/cutscene_char000203/CutScene_Char000203.skel' }), 'char000203');
  assert.equal(performanceId({ skeleton: 'spine/char/char000101/char000101.skel' }), undefined);
  const source = 'spine/cutscenes/cutscene_char067803_1/cutscene_char067803_1';
  assert.deepEqual(performanceSources([{ name: 'a', composite: [['x', { name: 'y', source }], { name: 'z', source }] }]), [source]);
});

test('the shipped scenes point at pinned 有缘之客 skeletons', () => {
  const data = JSON.parse(readFileSync(new URL('../public/companion/bd2-performances.json', import.meta.url), 'utf8'));
  const scenes = Object.entries(data.dating);
  assert.ok(scenes.length >= 20);
  for (const [id, scene] of scenes) {
    assert.match(id, /^char\d{6}$/);
    assert.match(scene.skeleton, /^spine\/illust\/illust_dating\/(illust_dating\w+)\/\1$/);
    assert.equal(typeof scene.tracks, 'boolean');
  }
});
