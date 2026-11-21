import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_PROGRESS_KEY, REACTION_PROGRESS_KEY, normalizeSceneProgress, normalizeReactionProgress } from '../public/companion-model.js';
import { readSceneProgress, writeSceneProgress, readReactionProgress, writeReactionProgress } from '../public/companion-browser.js';

test('stored scene progress keeps only positions a tour can resume from', () => {
  assert.deepEqual(normalizeSceneProgress({
    'spine/char/char003604/char003604.skel': { stage: 1, played: [3, 3, 0, -1, 2.5, 'x', 1000] },
    'no-played': { stage: 0 },
    'bad-stage': { stage: -1, played: [] },
    'fraction': { stage: 1.5, played: [] },
    'too-far': { stage: 64, played: [] },
    'not-an-entry': 'stage 2',
    '': { stage: 0, played: [] },
  }), {
    'spine/char/char003604/char003604.skel': { stage: 1, played: [3, 0] },
    'no-played': { stage: 0, played: [] },
  });
  for (const value of [null, undefined, 'text', 3, [], [{ stage: 0 }]]) assert.deepEqual(normalizeSceneProgress(value), {});
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['scene' + i, { stage: 0, played: [] }]));
  assert.equal(Object.keys(normalizeSceneProgress(many)).length, 64);
});

test('scene progress is written one scene at a time and survives damaged or blocked storage', t => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
  };
  t.after(() => { delete globalThis.localStorage; });
  assert.deepEqual(readSceneProgress(), {});
  writeSceneProgress('a', { stage: 1, played: [2] });
  writeSceneProgress('b', { stage: 0, played: [] });
  writeSceneProgress('a', { stage: 1, played: [2, 4] });
  assert.deepEqual(readSceneProgress(), { a: { stage: 1, played: [2, 4] }, b: { stage: 0, played: [] } },
    'another scene, as another tab would have written it, is kept');
  assert.deepEqual(Object.keys(JSON.parse(store.get(SCENE_PROGRESS_KEY))), ['a', 'b'], 'the scene played last comes first');
  store.set(SCENE_PROGRESS_KEY, '{not json');
  assert.deepEqual(readSceneProgress(), {});
  writeSceneProgress('c', { stage: 2, played: [] });
  assert.deepEqual(readSceneProgress(), { c: { stage: 2, played: [] } }, 'damaged storage is replaced');
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readSceneProgress(), {});
  assert.doesNotThrow(() => writeSceneProgress('a', { stage: 0, played: [] }));
});

test('stored reaction rounds keep only positions a round can continue from', () => {
  assert.deepEqual(normalizeReactionProgress({
    'Live2D/longfeng_2/longfeng_2.model3.json': { queue: [4, 4, 1, -2, 1.5, 'x', 1000], last: 7 },
    'docs/jianwu/jianwu_3': { queue: [], last: null },
    'no-last': { queue: [2] },
    'bad-last': { queue: [0], last: -1 },
    'not-a-round': [1, 2],
    'text': 'queue',
    '': { queue: [1], last: 0 },
  }), {
    'Live2D/longfeng_2/longfeng_2.model3.json': { queue: [4, 1], last: 7 },
    'docs/jianwu/jianwu_3': { queue: [], last: null },
    'no-last': { queue: [2], last: null },
    'bad-last': { queue: [0], last: null },
  });
  for (const value of [null, undefined, 'text', 3, []]) assert.deepEqual(normalizeReactionProgress(value), {});
});

test('reaction rounds are stored next to scene progress without touching it', t => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
  };
  t.after(() => { delete globalThis.localStorage; });
  writeSceneProgress('scene', { stage: 1, played: [0] });
  writeReactionProgress('Live2D/a/a.model3.json', { queue: [3, 1], last: 0 });
  writeReactionProgress('docs/b/b_2', { queue: [], last: 1 });
  writeReactionProgress('Live2D/a/a.model3.json', { queue: [1], last: 3 });
  assert.deepEqual(readReactionProgress(), { 'Live2D/a/a.model3.json': { queue: [1], last: 3 }, 'docs/b/b_2': { queue: [], last: 1 } });
  assert.deepEqual(Object.keys(JSON.parse(store.get(REACTION_PROGRESS_KEY))), ['Live2D/a/a.model3.json', 'docs/b/b_2'], 'the costume played last comes first');
  assert.deepEqual(readSceneProgress(), { scene: { stage: 1, played: [0] } });
  store.set(REACTION_PROGRESS_KEY, 'not json');
  assert.deepEqual(readReactionProgress(), {});
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readReactionProgress(), {});
  assert.doesNotThrow(() => writeReactionProgress('Live2D/a/a.model3.json', { queue: [], last: 0 }));
});
