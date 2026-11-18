import test from 'node:test';
import assert from 'node:assert/strict';
import { GAMES, DEFAULT_GAMES, selectedGames } from '../public/companion-games.js';

test('each registered game names its catalog, camera presets and asset origin', () => {
  assert.ok(GAMES.length >= 1);
  for (const game of GAMES) {
    assert.match(game.id, /^[a-z0-9-]+$/);
    assert.ok(game.name && game.catalogUrl && game.presentationsUrl && game.assetBase.endsWith('/'));
  }
  assert.equal(new Set(GAMES.map(game => game.id)).size, GAMES.length, 'ids are unique');
  assert.deepEqual(DEFAULT_GAMES, GAMES.map(game => game.id));
});

test('selected games keep registry order and never resolve to an empty pool', () => {
  assert.deepEqual(selectedGames(['bd2']).map(game => game.id), ['bd2']);
  assert.deepEqual(selectedGames([]), GAMES);
  assert.deepEqual(selectedGames(['missing']), GAMES);
  assert.deepEqual(selectedGames(undefined), GAMES);
});
