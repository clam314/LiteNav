import test from 'node:test';
import assert from 'node:assert/strict';
import { GAMES, DEFAULT_GAMES, gameById, selectedGames } from '../public/companion-games.js';

test('each registered game names its catalog, action and asset origin', () => {
  assert.deepEqual(GAMES.map(game => game.id), ['bd2', 'nikke', 'azurlane', 'destinychild']);
  for (const game of GAMES) {
    assert.match(game.id, /^[a-z0-9-]+$/);
    assert.ok(game.name && game.action && game.catalogUrl && game.assetBase.endsWith('/'));
  }
  assert.equal(gameById('nikke').action, '开火循环');
  assert.equal(gameById('azurlane').action, '互动');
  assert.ok(gameById('azurlane').lfsBase.startsWith('https://media.githubusercontent.com/media/'),
    'Azur Lane fetches its LFS objects from the media host');
  assert.equal(gameById('destinychild').action, '动作');
  assert.equal(gameById('destinychild').lfsBase, undefined, 'Destiny Child serves every file from git');
  assert.equal(gameById(undefined).id, 'bd2', 'catalog entries without a game are Brown Dust 2');
  assert.equal(new Set(GAMES.map(game => game.id)).size, GAMES.length, 'ids are unique');
  assert.deepEqual(DEFAULT_GAMES, GAMES.map(game => game.id));
});

test('selected games keep registry order and never resolve to an empty pool', () => {
  assert.deepEqual(selectedGames(['destinychild', 'azurlane', 'nikke', 'bd2']).map(game => game.id), ['bd2', 'nikke', 'azurlane', 'destinychild']);
  assert.deepEqual(selectedGames([]), GAMES);
  assert.deepEqual(selectedGames(['missing']), GAMES);
  assert.deepEqual(selectedGames(undefined), GAMES);
});
