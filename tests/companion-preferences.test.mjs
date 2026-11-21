import test from 'node:test';
import assert from 'node:assert/strict';
import { PREFERENCES_KEY, normalizePreferences, displayChanged } from '../public/companion-model.js';
import { readPreferences, writePreferences } from '../public/companion-browser.js';

const fixed = normalizePreferences({ random: false, portraits: true, skills: true, characterId: '0002', costumeKey: 'a.skel', skillAction: 'loop' });

test('only a change in what is shown makes another page restart its companion', () => {
  const change = changes => displayChanged(fixed, normalizePreferences({ ...fixed, ...changes }));
  for (const changes of [{ skillAction: 'skill_2' }, { voice: true }, { voiceVolume: 0.2 }, { rotation: 10 }, { resume: 'skill' }, {}]) {
    assert.equal(change(changes), false, JSON.stringify(changes));
  }
  for (const changes of [{ portraits: false }, { skills: false }, { random: true }, { games: ['bd2'] }, { characterId: '0001', costumeKey: 'b.skel' }, { costumeKey: 'c.skel' }]) {
    assert.equal(change(changes), true, JSON.stringify(changes));
  }
  const random = normalizePreferences({ ...fixed, random: true });
  assert.equal(displayChanged(random, normalizePreferences({ ...random, characterId: '0009', costumeKey: 'z.skel' })), false,
    'in random rotation each page moves on to its own people');
});

test('preferences saved by an older page keep the fields it does not know, and equal copies are not rewritten', t => {
  const store = new Map();
  let writes = 0;
  globalThis.localStorage = {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => { writes += 1; store.set(key, String(value)); },
  };
  t.after(() => { delete globalThis.localStorage; });
  const mine = normalizePreferences({ ...fixed, voice: true, voiceVolume: 0.3 });
  writePreferences(mine);
  assert.equal(writes, 1, 'the first save is written');
  const { voice, voiceVolume, ...older } = mine;
  store.set(PREFERENCES_KEY, JSON.stringify({ ...older, skillAction: 'skill_2' }));
  const read = readPreferences(mine);
  assert.equal(read.skillAction, 'skill_2');
  assert.deepEqual([read.voice, read.voiceVolume], [true, 0.3], 'fields the older copy lacks keep their values here');
  assert.deepEqual([readPreferences().voice, readPreferences().voiceVolume], [false, 0.6], 'without a current copy they take their defaults');
  writes = 0;
  const reordered = Object.fromEntries(Object.entries(normalizePreferences({ ...fixed })).reverse());
  store.set(PREFERENCES_KEY, JSON.stringify(reordered));
  writePreferences(normalizePreferences({ ...fixed }));
  assert.equal(writes, 0, 'the same preferences in another key order are not rewritten');
  store.set(PREFERENCES_KEY, JSON.stringify(older));
  writePreferences(mine);
  assert.equal(writes, 1, 'turning the voice on is saved even when the stored copy lacks the field');
  store.set(PREFERENCES_KEY, '{broken');
  writePreferences(mine);
  assert.equal(writes, 2, 'unreadable storage is replaced');
});
