import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { costumeKey } from '../public/companion-model.js';
import {
  live2dMotionPlan, live2dMotions, isCubism2, live2dGeneration, live2dFiles, withLive2DFiles, live2dArtBounds, placeLive2D, backgroundBand, MAX_COVER_ZOOM, orderMotionCurves, createActionOrder, gazeFocus, reactionFraming,
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

// A Destiny Child model (Cubism 2): lower-case keys, expressions it is not asked to play.
const cubism2 = () => ({
  version: 'Sample 1.0.0', model: 'model.moc', textures: ['texture_00.png', 'texture_01.png'],
  expressions: [{ name: 'angry', file: 'angry.exp.json' }],
  motions: Object.fromEntries(['attack', 'hit', 'idle', 'idle_ls', 'banner', 'event'].map(name =>
    [name, [{ file: `c001_02_${name}.mtn`, fade_in: 0, fade_out: 0 }]])),
});

test('Cubism 2 models plan their battle moves and banner pose and fetch everything from git', () => {
  const model = cubism2();
  assert.equal(isCubism2(model), true);
  assert.equal(live2dGeneration('assets/live2d/c001_02/model.json'), 2);
  assert.equal(live2dGeneration('Live2D/z23/z23.model3.json'), 4, 'Cubism 3+ settings need the Cubism 4 framework');
  assert.equal(live2dGeneration(undefined), 2);
  assert.equal(isCubism2(settings()), false);
  assert.equal(live2dMotions(model), model.motions);
  assert.deepEqual(live2dMotions(settings()), settings().FileReferences.Motions);
  const plan = live2dMotionPlan(live2dMotions(model));
  assert.deepEqual(plan, { idle: 'idle', effect: null, actions: ['attack', 'hit', 'banner'] },
    'the other idle loops and story event motions are not played');
  assert.deepEqual(live2dFiles(model, plan), ['model.moc', 'texture_00.png', 'texture_01.png',
    ...['idle', 'attack', 'hit', 'banner'].map(name => `c001_02_${name}.mtn`)].map(path => ({ path, lfs: false })));
  assert.deepEqual(live2dFiles({ ...model, physics: 'model.physics.json' }, plan)[3], { path: 'model.physics.json', lfs: false });
  assert.throws(() => live2dFiles({ ...model, textures: [] }, plan), /配置不完整/);
  const urls = Object.fromEntries(live2dFiles(model, plan).map(file => [file.path, 'blob:' + file.path]));
  const rewritten = withLive2DFiles(model, plan, urls);
  assert.equal(rewritten.model, 'blob:model.moc');
  assert.deepEqual(rewritten.textures, ['blob:texture_00.png', 'blob:texture_01.png']);
  assert.deepEqual(Object.keys(rewritten.motions), ['idle', 'attack', 'hit', 'banner']);
  assert.deepEqual(rewritten.motions.hit, [{ file: 'blob:c001_02_hit.mtn', fade_in: 0, fade_out: 0 }]);
  assert.equal(rewritten.expressions, undefined, 'expressions are not fetched, so not listed');
  assert.ok(model.expressions && model.motions.event, 'the original settings are left untouched');
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

test('the action display leaves room above for where reactions usually reach, on the idle floor', () => {
  const canvas = { width: 1000, height: 2000 };
  const idle = { minX: 200, maxX: 800, minY: 400, maxY: 1900 };
  const frame = (minY, extra = {}) => ({ minX: 200, maxX: 800, minY, maxY: 1900, ...extra });
  // Twenty frames: most reach 300, one flick of hair reaches the canvas top.
  const frames = [...Array(19).fill(0).map(() => frame(300)), frame(0)];
  assert.deepEqual(reactionFraming(idle, frames, canvas), { ...idle, minY: 300 },
    'a moment past the usual top does not shrink the figure');
  const low = [...Array(20).fill(0).map(() => frame(450, { maxY: 2000, minX: 0 }))];
  assert.deepEqual(reactionFraming(idle, low, canvas), idle, 'floor, sides and a lower top stay those of idle');
  const closeUp = Array(20).fill(0).map(() => ({ minX: 0, maxX: 1000, minY: 0, maxY: 2000 }));
  assert.deepEqual(reactionFraming(idle, [...closeUp, frame(350)], canvas), { ...idle, minY: 350 },
    'close-ups that fill the canvas are left to the canvas clip');
  assert.deepEqual(reactionFraming(idle, [], canvas), idle);
  assert.deepEqual(reactionFraming({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }, frames, canvas).minY, Infinity);
});

test('a round of reactions continues where an earlier visit left it', () => {
  const actions = ['home', 'touch_head', 'main_1', 'login'];
  const first = createActionOrder(actions, () => 0);
  const seen = [first(), first()];
  const saved = first.progress();
  assert.equal(saved.queue.length, 2);
  assert.equal(actions[saved.last], seen[1]);
  const later = createActionOrder(actions, () => 0, JSON.parse(JSON.stringify(saved)));
  const rest = [later(), later()];
  assert.deepEqual([...seen, ...rest].sort(), [...actions].sort(), 'the round finishes with the reactions not seen yet');
  assert.notEqual(later(), rest[1], 'the next round still avoids the reaction played last');
  // Lists of animations (paintings) resume by position as well.
  const steps = [['drag', 'ex'], ['login']];
  const painting = createActionOrder(steps, () => 0);
  const played = painting();
  assert.notEqual(createActionOrder(steps, () => 0, painting.progress())(), played);
  // Unknown or stale progress starts a fresh round.
  for (const stale of [null, {}, { queue: [7, -1, 'home', 1.5], last: 9 }, { queue: 'x' }]) {
    const order = createActionOrder(actions, () => 0, stale);
    assert.deepEqual([order(), order(), order(), order()].sort(), [...actions].sort());
  }
  assert.deepEqual(createActionOrder(actions, () => 0, { queue: [2, 2], last: null }).progress().queue, [2], 'positions are not repeated');
});

test('the Azur Lane catalog pins its upstreams: Live2D models for both displays, dynamic paintings as portraits or with their reactions', () => {
  const catalog = JSON.parse(readFileSync(new URL('../public/companion/azurlane/catalog.json', import.meta.url), 'utf8'));
  assert.match(catalog.commit, /^[a-f0-9]{40}$/);
  assert.match(catalog.paintingCommit, /^[a-f0-9]{40}$/);
  assert.match(catalog.voiceCommit, /^[a-f0-9]{40}$/);
  let spoken = 0;
  for (const costume of catalog.characters.flatMap(person => person.costumes)) {
    if (!costume.voices) continue;
    spoken += 1;
    assert.ok(costume.cutscene, 'only costumes with reactions speak');
    for (const [motion, path] of Object.entries(costume.voices)) {
      assert.match(motion, /^(login|home|mail|mission|mission_complete|complete|touch|touch_head|touch_body|touch_special|main_\d+)$/);
      assert.match(path, /^\d+\/\w+$/);
    }
  }
  assert.ok(spoken > 200, 'most models have their Japanese voice lines');
  assert.ok(catalog.characters.length > 100);
  const keys = new Set();
  let paintings = 0;
  let reacting = 0;
  for (const person of catalog.characters) {
    assert.match(person.id, /^azurlane:[a-z0-9_]+$/);
    assert.ok(person.name && person.costumes.length);
    const labels = person.costumes.map(costume => costume.label);
    assert.equal(new Set(labels).size, labels.length, `${person.name} has no two costumes with one label`);
    for (const costume of person.costumes) {
      assert.ok(costume.label);
      if (costume.idle.runtime === 'live2d') {
        assert.match(costume.idle.model, /^Live2D\/([^/]+)\/\1\.model3\.json$/);
        assert.deepEqual(costume.cutscene, costume.idle);
      } else {
        paintings += 1;
        assert.equal(costume.idle.runtime, '3.8');
        assert.match(costume.idle.painting, /^docs\/[\w.-]+\/[\w.-]+$/);
        assert.ok(costume.idle.layers.length >= 1);
        for (const layer of costume.idle.layers) {
          assert.match(layer.skeleton, /^[\w.-]+\.skel$/);
          assert.doesNotMatch(layer.skeleton, /_hx\.skel$/, 'censored layers are left out');
          assert.match(layer.atlas, /^[\w.-]+\.atlas$/);
        }
        if (costume.cutscene) {
          reacting += 1;
          const { actions, ...part } = costume.cutscene;
          assert.deepEqual(part, costume.idle, 'reactions play on the same painting');
          assert.ok(actions.length && actions.every(steps => steps.length && steps.every(name => typeof name === 'string')));
        }
      }
      const key = costumeKey(costume);
      assert.ok(!keys.has(key), 'each model or painting appears once');
      keys.add(key);
    }
  }
  assert.ok(paintings > 100);
  assert.ok(reacting >= 10 && reacting < paintings, 'only the paintings with reactions get an action display');
});

test('painting helpers repair 3.8 region names, pick the loop and place the camera', async () => {
  const { recoverUtf8, regionCandidates, paintingAnimation, placePainting } = await import('../public/companion-painting.js');
  // How the 3.8 reader garbles "图层": every UTF-8 byte becomes U+FF00 + byte.
  const garbled = [...new TextEncoder().encode('图层 664')].map(byte => String.fromCharCode(byte < 0x80 ? byte : 0xFF00 + byte)).join('');
  assert.equal(recoverUtf8(garbled), '图层 664');
  assert.equal(recoverUtf8('ab_sync_3_1'), 'ab_sync_3_1');
  assert.equal(recoverUtf8('图层'), '图层', 'correctly read names stay as they are');
  assert.deepEqual(regionCandidates('ab_sync_3_1_zuoxiong_1_2 '), ['ab_sync_3_1_zuoxiong_1_2 ', 'ab_sync_3_1_zuoxiong_1_2']);
  assert.equal(paintingAnimation(['1', '2', 'drag', 'normal']), 'normal');
  assert.equal(paintingAnimation(['click', 'idle']), 'idle');
  assert.equal(paintingAnimation(['a', 'b']), 'b');
  assert.equal(paintingAnimation([]), null);
  // A 1000 × 2000 view on an 800 × 1000 rail with 600 px free: two units per
  // pixel, centred 300 px from the right edge, standing on the floor.
  const camera = placePainting({ x: -500, y: 0, width: 1000, height: 2000 }, { width: 800, height: 1000 }, 600);
  assert.deepEqual(camera, { zoom: 2, x: 0 - (500 - 400) * 2, y: 1000 });
});

test('the gaze turns toward the pointer from the face, growing with distance up to most of the range', () => {
  const bounds = { minX: 0, maxX: 1000, minY: 0, maxY: 2000 };
  // The face is at (500, 400); the reach is 1200 px.
  assert.deepEqual(gazeFocus({ x: 500, y: 400 }, bounds), { x: 0, y: 0 });
  const near = gazeFocus({ x: 800, y: 400 }, bounds);
  assert.ok(Math.abs(near.x - 0.2) < 1e-9 && near.y === 0, 'a pointer close by turns the head a little');
  const far = gazeFocus({ x: -10000, y: 400 }, bounds);
  assert.ok(Math.abs(far.x + 0.8) < 1e-9, 'far away the turn stops at 80% of the range');
  assert.ok(gazeFocus({ x: 500, y: -5000 }, bounds).y > 0.79, 'above the face looks up');
  assert.deepEqual(gazeFocus({ x: 1, y: 1 }, { minX: Infinity }), { x: 0, y: 0 });
});

// A rail of 20 columns × 20 rows: rows lists, for each row, the columns drawn opaque.
const railMask = rows => {
  const mask = new Uint8Array(20 * 20);
  rows.forEach((columns, row) => { for (const column of columns) mask[row * 20 + column] = 255; });
  return mask;
};
const span = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

test('a scene is framed by the rows its background fills, not by what sticks out of it', () => {
  // A rope down the first four rows, then a background over the rest.
  const roped = railMask([...Array(4).fill([15]), ...Array(16).fill(span(0, 20))]);
  assert.deepEqual(backgroundBand(roped, 20, 20), { top: 0.2, bottom: 1 });
  // A brushed edge: the last two rows only reach part of the visible half.
  const brushed = railMask([...Array(18).fill(span(0, 20)), span(0, 15), span(0, 12)]);
  assert.deepEqual(backgroundBand(brushed, 20, 20), { top: 0, bottom: 0.9 });
  // Only the visible half (columns 10 and up) counts: the left may stay bare.
  const leftBare = railMask(Array(20).fill(span(10, 20)));
  assert.deepEqual(backgroundBand(leftBare, 20, 20), { top: 0, bottom: 1 });
});

test('the head above a background stays in view, and figures or thin bands keep their framing', () => {
  const roped = railMask([...Array(4).fill([15]), ...Array(16).fill(span(0, 20))]);
  assert.deepEqual(backgroundBand(roped, 20, 20, { keep: 0.1 }), { top: 0.1, bottom: 1 }, 'never cut above the top of the head');
  assert.deepEqual(backgroundBand(roped, 20, 20, { keep: -0.2 }), { top: 0, bottom: 1 });
  const figure = railMask(Array(20).fill(span(13, 17)));
  assert.equal(backgroundBand(figure, 20, 20), null, 'a figure on its own');
  const strip = railMask([...Array(12).fill(span(10, 15)), ...Array(8).fill(span(0, 20))]);
  assert.equal(backgroundBand(strip, 20, 20), null, 'a band under 55% of the height');
});

test('a background band fills the height with the figure in its place, within the zoom limit', () => {
  const bounds = { minX: 0, maxX: 1000, minY: 0, maxY: 1000 };
  const rail = { width: 800, height: 500 };
  const plain = placeLive2D(bounds, rail, 400, rail);
  assert.deepEqual(plain, { scale: 0.5, x: 350, y: -0 });
  const banded = placeLive2D(bounds, rail, 400, rail, { minY: 200, maxY: 1000 });
  assert.equal(banded.scale, 0.625);
  assert.equal(banded.y, -125, 'the band starts at the top');
  assert.equal(banded.x + 500 * banded.scale, plain.x + 500 * plain.scale, 'the middle of the art stays where it was');
  const headed = placeLive2D(bounds, rail, 400, rail, { minY: 200, maxY: 1000, anchorX: 300 });
  assert.equal(headed.x + 300 * headed.scale, plain.x + 300 * plain.scale, 'with a head, the head stays where it was');
  const tooFar = placeLive2D(bounds, rail, 400, rail, { minY: 0, maxY: 1000 / (MAX_COVER_ZOOM + 0.1) });
  assert.deepEqual(tooFar, plain, 'more than the zoom limit keeps the plain framing');
  assert.deepEqual(placeLive2D(bounds, rail, 400, rail, { minY: 0, maxY: 1000 }), plain);
});

test('motion curves are read in the order the framework expects, all of them kept', () => {
  const curve = (Target, Id) => ({ Target, Id, Segments: [0, 0, 0, 1, 0] });
  // As 爱宕「盛夏进行曲」's reactions: parameters, parts, more parameters, more parts.
  const motion = { Version: 3, Meta: { CurveCount: 6 }, Curves: [
    curve('Model', 'Opacity'), curve('Parameter', 'A'), curve('PartOpacity', 'P1'),
    curve('Parameter', 'B'), curve('PartOpacity', 'P2'), curve('Parameter', 'C'),
  ] };
  const ordered = orderMotionCurves(motion);
  assert.deepEqual(ordered.Curves.map(c => c.Id), ['Opacity', 'A', 'B', 'C', 'P1', 'P2'], 'kinds in order, each kind in its own order');
  assert.equal(ordered.Meta, motion.Meta);
  assert.equal(motion.Curves[2].Id, 'P1', 'the file read is left as it was');
  const tidy = { Curves: [curve('Parameter', 'A'), curve('PartOpacity', 'P1')] };
  assert.equal(orderMotionCurves(tidy), tidy, 'a motion already in order is passed on as it is');
  assert.deepEqual(orderMotionCurves({ Curves: [curve('Other', 'X'), curve('Parameter', 'A')] }).Curves.map(c => c.Id), ['A', 'X']);
  for (const value of [null, {}, { Curves: 'x' }]) assert.equal(orderMotionCurves(value), value);
});
