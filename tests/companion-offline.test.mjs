import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogSource, usableCatalog, CATALOG_REMOTE, CATALOG_CHECK_KEY } from '../public/companion-catalogs.js';
import { readKept, writeKept, keepModes, keptSource, keptEntry, catalogForKept, onlyKept, releasable, formatBytes, OFFLINE_KEY } from '../public/companion-offline.js';

const GAME = { id: 'bd2', catalogUrl: '/companion/catalog.json', presentationsUrl: '/companion/presets.json', performancesUrl: '/companion/perf.json' };
const costume = (skeleton, extra = {}) => ({ label: skeleton, idle: { skeleton: skeleton + '.skel', atlas: skeleton + '.atlas', runtime: '4.2' }, ...extra });
const catalogFile = (generatedAt, extra = {}) => ({ generatedAt, commit: 'a'.repeat(12), characters: [{ id: 'c1', name: '甲', costumes: [costume('char000101')] }], ...extra });

function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data };
}

function cacheStorage() {
  const entries = new Map();
  return { entries, async open() { return { async match(url) { return entries.get(url)?.clone(); }, async put(url, response) { entries.set(url, response); } }; } };
}

const bundledFiles = { '/companion/catalog.json': catalogFile('2026-11-20T00:00:00Z'), '/companion/presets.json': { from: 'bundled' }, '/companion/perf.json': { from: 'bundled' } };
const fetchJson = async url => { if (!(url in bundledFiles)) throw new Error('missing'); return structuredClone(bundledFiles[url]); };

test('usableCatalog refuses catalogs this build cannot play', () => {
  assert.equal(usableCatalog(catalogFile('x')), true);
  assert.equal(usableCatalog({ ...catalogFile('x'), commit: 'nope' }), false);
  assert.equal(usableCatalog({ ...catalogFile('x'), characters: [] }), false);
  const future = catalogFile('x', { characters: [{ id: 'c', costumes: [{ idle: { skeleton: 'a.skel', runtime: '5.0' } }] }] });
  assert.equal(usableCatalog(future), false);
  assert.equal(usableCatalog(catalogFile('x', { characters: [{ id: 'c', costumes: [{ idle: { skeleton: 'a.skel' } }] }] })), true, 'no runtime means 4.1');
});

test('the server version reads only its bundled catalogs', async () => {
  const source = createCatalogSource({ enabled: false, fetchJson, cacheStorage: cacheStorage() });
  const result = await source.read(GAME);
  assert.equal(result.remote, false);
  assert.equal(result.reference.from, 'bundled');
  assert.deepEqual(await source.refresh(), []);
});

test('the extension keeps newer catalogs and plays them from the next visit', async () => {
  const caches = cacheStorage();
  const storage = memoryStorage();
  let time = Date.parse('2026-11-27T08:00:00Z');
  const served = { '/companion/catalog.json': catalogFile('2026-11-27T00:00:00Z', { commit: 'b'.repeat(12) }), '/companion/presets.json': { from: 'main' }, '/companion/perf.json': { from: 'main' } };
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    const path = url.slice(CATALOG_REMOTE.length);
    return path in served ? new Response(JSON.stringify(served[path])) : new Response('no', { status: 404 });
  };
  const source = createCatalogSource({ enabled: true, fetchJson, cacheStorage: caches, fetchImpl, storage, now: () => time });
  assert.equal((await source.read(GAME)).data.commit, 'a'.repeat(12), 'nothing kept yet');
  assert.deepEqual(await source.refresh({ games: [GAME] }), ['bd2']);
  assert.equal(requests.length, 3);
  const next = await source.read(GAME);
  assert.deepEqual([next.remote, next.data.commit, next.reference.from, next.performances.from], [true, 'b'.repeat(12), 'main', 'main']);
  // Checked at most once a day.
  assert.deepEqual(await source.refresh({ games: [GAME] }), []);
  assert.equal(requests.length, 3);
  time += 21 * 60 * 60 * 1000;
  assert.deepEqual(await source.refresh({ games: [GAME] }), [], 'unchanged');
  assert.equal(requests.length, 6);
  // A newer build (bundled newer than the kept copy) plays its own.
  bundledFiles['/companion/catalog.json'] = catalogFile('2026-12-01T00:00:00Z', { commit: 'c'.repeat(12) });
  assert.equal((await source.read(GAME)).data.commit, 'c'.repeat(12));
  bundledFiles['/companion/catalog.json'] = catalogFile('2026-11-20T00:00:00Z');
});

test('a catalog needing a player this build lacks, or no network, changes nothing', async () => {
  const caches = cacheStorage();
  const storage = memoryStorage();
  const future = catalogFile('2027-01-01T00:00:00Z', { characters: [{ id: 'c', costumes: [{ idle: { skeleton: 'a.skel', runtime: '5.0' } }] }] });
  const source = createCatalogSource({ enabled: true, fetchJson, cacheStorage: caches, storage, fetchImpl: async () => new Response(JSON.stringify(future)) });
  assert.deepEqual(await source.refresh({ games: [GAME] }), []);
  assert.equal(caches.entries.size, 0);
  assert.equal((await source.read(GAME)).remote, false);
  const offline = createCatalogSource({ enabled: true, fetchJson, cacheStorage: cacheStorage(), storage: memoryStorage(), fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await offline.refresh({ games: [GAME] });
  const offlineStorage = memoryStorage();
  const again = createCatalogSource({ enabled: true, fetchJson, cacheStorage: cacheStorage(), storage: offlineStorage, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await again.refresh({ games: [GAME] });
  assert.equal(offlineStorage.getItem(CATALOG_CHECK_KEY), null, 'an offline attempt is not counted as a check');
});

test('saved costumes keep their parts and commits, and are chosen while offline', () => {
  const live2d = { idle: { model: 'a/a.model3.json', runtime: 'live2d' }, cutscene: { model: 'a/a.model3.json', runtime: 'live2d' } };
  assert.deepEqual(keepModes(live2d), ['portrait'], 'one Live2D model serves both displays');
  const bd2 = costume('char000101', { cutscene: { skeleton: 'cutscene_char000101.skel', runtime: '4.2' }, dating: { skeleton: 'npc1.skel' } });
  assert.deepEqual(keepModes(bd2), ['portrait', 'skill', 'dating']);
  const catalog = { games: { bd2: { assetBase: 'https://x/', commit: 'a'.repeat(12), performances: { char000101: [1], char000202: [2] } } },
    characters: [{ id: 'c1', name: '甲', game: 'bd2', costumes: [bd2] }, { id: 'c2', name: '乙', game: 'bd2', costumes: [costume('char000202')] }] };
  const source = keptSource(catalog, 'bd2', bd2);
  assert.deepEqual(source.performances, { char000101: [1] }, 'only its own performances');
  const entry = { key: 'char000101.skel', game: 'bd2', characterId: 'c1', name: '甲', costume: bd2, source: { ...source, commit: 'old'.repeat(4) }, urls: ['u1', 'shared'], bytes: 5 };
  const other = { key: 'char000202.skel', game: 'bd2', characterId: 'c2', name: '乙', costume: costume('char000202'), source, urls: ['shared', 'u2'], bytes: 7 };
  const storage = memoryStorage();
  writeKept([entry, other], storage);
  assert.equal(readKept(storage).length, 2);
  storage.setItem(OFFLINE_KEY, '{broken');
  assert.deepEqual(readKept(storage), []);
  assert.equal(keptEntry([entry], bd2), entry);
  assert.equal(catalogForKept(catalog, entry).games.bd2.commit, 'old'.repeat(4));
  const pool = onlyKept(catalog, [other]);
  assert.deepEqual(pool.characters.map(character => [character.id, character.costumes.length]), [['c2', 1]]);
  assert.deepEqual(releasable([entry, other], entry.key), ['u1'], 'files another saved costume uses stay');
  assert.equal(formatBytes(512), '1 KB');
  assert.equal(formatBytes(80 * 1024 * 1024), '80 MB');
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.0 GB');
});
