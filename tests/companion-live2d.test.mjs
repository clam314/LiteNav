import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  live2dMotionPlan, live2dFiles, withLive2DFiles, live2dArtBounds, placeLive2D, createActionOrder,
} from '../public/companion-live2d.js';

const motion = name => [{ File: `motions/${name}.motion3.json` }];
const groups = names => Object.fromEntries(names.map(name => [name, motion(name)]));
const settings = (names = ['idle', 'effect', 'home', 'touch_head', 'main_1', 'idle3', 'touch_idle4', 'touch_drag2', 'wedding']) => ({
  Version: 3,
  url: 'https://example.test/Live2D/z23/z23.model3.json',
  FileReferences: {
    Moc: 'z23.moc3', Textures: ['textures/texture_00.png', 'textures/texture_01.png'],
    Physics: 'z23.physics3.json', DisplayInfo: 'z23.cdi3.json', Motions: groups(names),
  },
});

test('the plan loops idle, runs effect alongside and keeps only main-screen and touch reactions', () => {
  assert.deepEqual(live2dMotionPlan(settings().FileReferences.Motions),
    { idle: 'idle', effect: 'effect', actions: ['home', 'touch_head', 'main_1'] },
    'L2D+ drag states (idleN, touch_idleN, touch_dragN) and the oath motion are not played');
  assert.deepEqual(live2dMotionPlan(groups(['home'])), { idle: null, effect: null, actions: ['home'] });
  assert.deepEqual(live2dMotionPlan(undefined), { idle: null, effect: null, actions: [] });
  assert.deepEqual(live2dMotionPlan({ idle: [], home: motion('home') }).idle, null, 'a group without a file is not playable');
});

test('the moc and textures come from LFS; physics and the planned motions from git', () => {
  const model = settings();
  const plan = live2dMotionPlan(model.FileReferences.Motions);
  assert.deepEqual(live2dFiles(model, plan), [
    { path: 'z23.moc3', lfs: true },
    { path: 'textures/texture_00.png', lfs: true },
    { path: 'textures/texture_01.png', lfs: true },
    { path: 'z23.physics3.json', lfs: false },
    ...['idle', 'effect', 'home', 'touch_head', 'main_1'].map(name => ({ path: `motions/${name}.motion3.json`, lfs: false })),
  ]);
  assert.throws(() => live2dFiles({ FileReferences: { Moc: 'a.moc3', Textures: [] } }, plan), /配置不完整/);
});

test('the rewritten settings point every file at its URL and drop unplanned motions', () => {
  const model = settings();
  const plan = live2dMotionPlan(model.FileReferences.Motions);
  const urls = Object.fromEntries(live2dFiles(model, plan).map(file => [file.path, 'blob:' + file.path]));
  const rewritten = withLive2DFiles(model, plan, urls);
  assert.equal(rewritten.url, model.url);
  assert.deepEqual(rewritten.FileReferences, {
    Moc: 'blob:z23.moc3',
    Textures: ['blob:textures/texture_00.png', 'blob:textures/texture_01.png'],
    Physics: 'blob:z23.physics3.json',
    Motions: Object.fromEntries(['idle', 'effect', 'home', 'touch_head', 'main_1']
      .map(name => [name, [{ File: `blob:motions/${name}.motion3.json` }]])),
  });
  assert.ok(model.FileReferences.Motions.wedding, 'the original settings are left untouched');
  assert.throws(() => withLive2DFiles(model, plan, {}), /文件缺失/);
});

test('art bounds skip hidden, transparent and touch-target meshes and stay on the canvas', () => {
  const mesh = (id, points, overrides = {}) => ({ id, vertices: new Float32Array(points), opacity: 1, visible: true, ...overrides });
  const canvas = { width: 1000, height: 800 };
  const bounds = live2dArtBounds([
    mesh('D_BODY', [200, 100, 600, 700]),
    mesh('D_HAIR', [150, 50, 300, 750]),
    mesh('D_HIDDEN', [0, 0, 1000, 800], { visible: false }),
    mesh('D_FADED', [0, 0, 1000, 800], { opacity: 0.01 }),
    mesh('TouchDrag18', [-104485, -6158, -97026, 11938]),
    mesh('touch_head', [0, 0, 1000, 800]),
    mesh('D_SLEEVE', [580, 120, 1400, 400]),
  ], canvas);
  assert.deepEqual(bounds, { minX: 150, maxX: 1000, minY: 50, maxY: 750 });
});

test('the figure fills the rail height, stands on its bottom edge and centres in the free space', () => {
  const rail = { width: 800, height: 900 };
  // A 400 × 600 figure: scale 1.5, 600 px wide, centred 300 px from the right edge.
  const spot = placeLive2D({ minX: 100, maxX: 500, minY: 200, maxY: 800 }, rail, 600, { width: 1000, height: 1000 });
  assert.equal(spot.scale, 1.5);
  assert.equal(spot.y, -300, 'the top of the art meets the top of the rail');
  assert.equal(spot.y + 800 * spot.scale, rail.height, 'the bottom of the art meets the bottom edge');
  assert.equal(spot.x + 300 * spot.scale, 500, 'the art centre sits in the middle of the free space');

  // A wide scene runs past both sides around the same centre.
  const scene = placeLive2D({ minX: 0, maxX: 8000, minY: 0, maxY: 5436 }, rail, 600, { width: 8000, height: 5436 });
  assert.ok(Math.abs(scene.x + 4000 * scene.scale - 500) < 1e-9);
  assert.ok(8000 * scene.scale > rail.width);

  // Narrow free space never centres beyond the rail; unusable bounds fall back to the canvas.
  assert.equal(placeLive2D({ minX: 0, maxX: 100, minY: 0, maxY: 100 }, rail, 2000, null).x, 400 - 50 * 9);
  assert.deepEqual(placeLive2D({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }, rail, 600, { width: 300, height: 900 }),
    { scale: 1, x: 350, y: -0 });
});

test('reactions play once per round in a shuffled order that never repeats across rounds', () => {
  const values = [.9, .1, .5, 0, 0];
  let index = 0;
  const next = createActionOrder(['home', 'touch_head', 'main_1'], () => values[index++ % values.length]);
  const round = () => [next(), next(), next()];
  const first = round();
  assert.deepEqual([...first].sort(), ['home', 'main_1', 'touch_head']);
  for (let i = 0; i < 5; i++) {
    const last = first.at(-1);
    const again = round();
    assert.deepEqual([...again].sort(), ['home', 'main_1', 'touch_head']);
    assert.notEqual(again[0], last, 'a new round does not start with the reaction just played');
    first.splice(0, 3, ...again);
  }
  assert.equal(createActionOrder([])(), null);
  const single = createActionOrder(['home']);
  assert.deepEqual([single(), single()], ['home', 'home']);
});

test('the Azur Lane catalog pins its upstream and uses Live2D parts for both displays', () => {
  const catalog = JSON.parse(readFileSync(new URL('../public/companion/azurlane/catalog.json', import.meta.url), 'utf8'));
  assert.match(catalog.commit, /^[a-f0-9]{40}$/);
  assert.ok(catalog.characters.length > 100);
  const ids = new Set();
  for (const person of catalog.characters) {
    assert.match(person.id, /^azurlane:[a-z0-9_]+$/);
    assert.ok(person.name && person.costumes.length);
    for (const costume of person.costumes) {
      assert.ok(costume.label);
      assert.match(costume.idle.model, /^Live2D\/([^/]+)\/\1\.model3\.json$/);
      assert.equal(costume.idle.runtime, 'live2d');
      assert.deepEqual(costume.cutscene, costume.idle);
      assert.ok(!ids.has(costume.idle.model), 'each model appears once');
      ids.add(costume.idle.model);
    }
  }
});
