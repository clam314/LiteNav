import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetFetcher, ASSET_CACHE_NAME, KEPT_CACHE_NAME } from '../public/companion-assets.js';

const BASE = 'https://assets.example/pinned/';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// One map per store; entries is the asset cache's.
function fakeCacheStorage({ failOpen = false, failPut = false } = {}) {
  const stores = new Map();
  const opened = [];
  const storage = {
    opened, stores,
    get entries() { return stores.get(ASSET_CACHE_NAME) || new Map(); },
    async open(name) {
      opened.push(name);
      if (failOpen) throw new Error('SecurityError');
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(url) { return entries.get(url); },
        async put(url, response) { if (failPut) throw new Error('QuotaExceededError'); entries.set(url, response); },
        async keys() { return [...entries.keys()]; },
        async delete(url) { return entries.delete(url); },
      };
    },
  };
  return storage;
}

function network() {
  const calls = [];
  const fetchResource = async (url, signal, cache = 'default') => {
    calls.push({ url, cache });
    const stored = { url, body: 'stored', clone() { return stored; } };
    return { url, body: 'network', clone() { return stored; } };
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
  assert.deepEqual(cacheStorage.opened.sort(), [ASSET_CACHE_NAME, KEPT_CACHE_NAME].sort(), 'each store is opened once');
});

test('kept assets move out of the trimmed store, survive trimming and are served first', async () => {
  const cacheStorage = fakeCacheStorage();
  const { calls, fetchResource } = network();
  const fetchAsset = createAssetFetcher({ base: BASE, fetchResource, cacheStorage, limit: 1 });
  const controller = new AbortController();
  const urls = fetchAsset.collect(controller.signal);
  await fetchAsset(BASE + 'a.png', controller.signal);
  await fetchAsset('/local/b.png', controller.signal);
  await settle();
  assert.deepEqual([...urls], [BASE + 'a.png', '/local/b.png']);
  await fetchAsset.keep([...urls, BASE + 'c.png']);
  const kept = cacheStorage.stores.get(KEPT_CACHE_NAME);
  assert.deepEqual([...kept.keys()].sort(), [BASE + 'a.png', BASE + 'c.png'], 'only upstream files are kept; missing ones are downloaded');
  assert.equal(cacheStorage.entries.has(BASE + 'a.png'), false, 'one copy is enough');
  // Filling the trimmed store does not touch kept files.
  await fetchAsset(BASE + 'd.png');
  await fetchAsset(BASE + 'e.png');
  await settle();
  const before = calls.length;
  assert.equal((await fetchAsset(BASE + 'a.png')).body, 'stored');
  assert.equal(calls.length, before);
  await fetchAsset.release([BASE + 'a.png']);
  assert.deepEqual([...kept.keys()], [BASE + 'c.png']);
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
