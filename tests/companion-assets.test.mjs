import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetFetcher, ASSET_CACHE_NAME } from '../public/companion-assets.js';

const BASE = 'https://assets.example/pinned/';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function fakeCacheStorage({ failOpen = false, failPut = false } = {}) {
  const entries = new Map();
  const opened = [];
  return {
    entries, opened,
    async open(name) {
      opened.push(name);
      if (failOpen) throw new Error('SecurityError');
      return {
        async match(url) { return entries.get(url); },
        async put(url, response) { if (failPut) throw new Error('QuotaExceededError'); entries.set(url, response); },
        async keys() { return [...entries.keys()]; },
        async delete(url) { return entries.delete(url); },
      };
    },
  };
}

function network() {
  const calls = [];
  const fetchResource = async (url, signal, cache = 'default') => {
    calls.push({ url, cache });
    return { url, body: 'network', clone() { return { url, body: 'stored' }; } };
  };
  return { calls, fetchResource };
}

test('pinned upstream assets download once and are served from the asset cache afterwards', async () => {
  const cacheStorage = fakeCacheStorage();
  const { calls, fetchResource } = network();
  const fetchAsset = createAssetFetcher({ base: BASE, fetchResource, cacheStorage });
  const first = await fetchAsset(BASE + 'a.png');
  await settle();
  const second = await fetchAsset(BASE + 'a.png');
  assert.equal(first.body, 'network');
  assert.equal(second.body, 'stored');
  assert.deepEqual(calls, [{ url: BASE + 'a.png', cache: 'force-cache' }],
    'the first download may reuse a stale HTTP cache entry; later visits need no request');
  assert.deepEqual(cacheStorage.opened, [ASSET_CACHE_NAME], 'the store is opened once');
});

test('same-origin files bypass the asset cache and keep normal HTTP revalidation', async () => {
  const cacheStorage = fakeCacheStorage();
  const { calls, fetchResource } = network();
  const fetchAsset = createAssetFetcher({ base: BASE, fetchResource, cacheStorage });
  await fetchAsset('/companion/assets/char000201.png');
  await settle();
  assert.deepEqual(calls, [{ url: '/companion/assets/char000201.png', cache: 'default' }]);
  assert.equal(cacheStorage.entries.size, 0);
});

test('without a usable Cache API the network copy still loads from the HTTP cache', async () => {
  for (const cacheStorage of [undefined, fakeCacheStorage({ failOpen: true }), fakeCacheStorage({ failPut: true })]) {
    const { calls, fetchResource } = network();
    const fetchAsset = createAssetFetcher({ base: BASE, fetchResource, cacheStorage });
    assert.equal((await fetchAsset(BASE + 'a.skel')).body, 'network');
    await settle();
    assert.equal((await fetchAsset(BASE + 'a.skel')).body, 'network');
    assert.deepEqual(calls.map(call => call.cache), ['force-cache', 'force-cache']);
  }
});

test('the oldest stored assets are dropped beyond the limit', async () => {
  const cacheStorage = fakeCacheStorage();
  const { fetchResource } = network();
  const fetchAsset = createAssetFetcher({ base: BASE, fetchResource, cacheStorage, limit: 2 });
  for (const name of ['a', 'b', 'c']) {
    await fetchAsset(BASE + name);
    await settle();
  }
  assert.deepEqual([...cacheStorage.entries.keys()], [BASE + 'b', BASE + 'c']);
});

test('every game asset origin is cached while other URLs pass through', async () => {
  const cacheStorage = fakeCacheStorage();
  const { calls, fetchResource } = network();
  const other = 'https://other-game.example/pinned/';
  const fetchAsset = createAssetFetcher({ base: [BASE, other], fetchResource, cacheStorage });
  await fetchAsset(other + 'b.png');
  await fetchAsset('https://unrelated.example/c.png');
  await settle();
  assert.deepEqual([...cacheStorage.entries.keys()], [other + 'b.png']);
  assert.deepEqual(calls.map(call => call.cache), ['force-cache', 'default']);
});

test('the store also keeps within a total size, dropping the oldest entries first', async () => {
  const cacheStorage = fakeCacheStorage();
  const sized = { a: 400, b: 300, c: 500 };
  const fetchResource = async url => {
    const name = url.slice(BASE.length);
    const headers = { get: header => header === 'content-length' ? String(sized[name]) : null };
    return { url, body: 'network', headers, clone() { return { url, body: 'stored', headers }; } };
  };
  const fetchAsset = createAssetFetcher({ base: BASE, fetchResource, cacheStorage, maxBytes: 1000 });
  for (const name of ['a', 'b', 'c']) {
    await fetchAsset(BASE + name);
    await settle();
    await settle();
  }
  assert.deepEqual([...cacheStorage.entries.keys()], [BASE + 'b', BASE + 'c'], '400 + 300 + 500 is over 1000, so a goes');

  // Entries left by an earlier visit are measured from their stored headers.
  const later = createAssetFetcher({ base: BASE, fetchResource, cacheStorage, maxBytes: 600 });
  await later(BASE + 'a');
  for (let i = 0; i < 6; i++) await settle();
  assert.deepEqual([...cacheStorage.entries.keys()], [BASE + 'a'], 'the newest entry stays even when the rest must go');
});
