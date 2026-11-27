import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLocalStore, memoryLock, STATE_KEY, BACKUP_KEEP } from '../public/local-store.js';
import { mergeDocuments, emptyDocument } from '../public/sync-merge.js';
import { createChromeSyncChannel, encodeDocument, decodeDocument, META_KEY, SyncQuotaError } from '../public/sync-chrome.js';
import { createSyncEngine } from '../public/sync-engine.js';
import { createLocalBackend } from '../public/local-backend.js';

const seed = JSON.parse(await readFile(new URL('../seed.json', import.meta.url), 'utf8'));
const knownSites = JSON.parse(await readFile(new URL('../public/known-sites.json', import.meta.url), 'utf8'));

// chrome.storage.local / .sync stand-in.
function fakeArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(data);
      const result = {};
      for (const key of [].concat(keys)) if (key in data) result[key] = structuredClone(data[key]);
      return result;
    },
    async set(items) { Object.assign(data, structuredClone(items)); },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
  };
}

function clock(start = '2026-11-26T08:00:00Z') {
  let time = Date.parse(start);
  const now = () => new Date(time);
  now.tick = (ms = 1000) => { time += ms; };
  return now;
}

// One browser: its own local storage, a shared sync area.
function device(syncArea, now = clock()) {
  const area = fakeArea();
  const store = createLocalStore({ area, withLock: memoryLock(), seed: async () => structuredClone(seed), now });
  const engine = createSyncEngine({ store, channel: createChromeSyncChannel({ area: syncArea }), area, withLock: memoryLock(), now });
  const edit = async (change) => {
    now.tick();
    const draft = await store.state();
    change(draft);
    return store.save(draft);
  };
  return { area, store, engine, edit, now };
}

const site = (id, url, extra = {}) => ({ id, name: id, url, icon: '', kind: 'website', categoryId: 'ai', pinned: false, order: 9, pinnedOrder: 9, monitorEnabled: false, ...extra });
const ids = (state) => state.links.map((link) => link.id).sort();

test('local store keeps revisions and refuses stale saves like the server', async () => {
  const { store, edit } = device(fakeArea());
  const first = await store.state();
  assert.equal(first.revision, 1);
  const saved = await edit((state) => { state.links.push(site('extra', 'https://extra.example')); });
  assert.equal(saved.revision, 2);
  await assert.rejects(store.save({ ...first }), (error) => error.status === 409);
  await assert.rejects(store.save({ ...saved, links: [{ id: 'x' }] }), (error) => error.status === 400);
});

test('local store backs up before the day\'s first change and big removals, keeping 30', async () => {
  const { store, edit, now } = device(fakeArea());
  await edit((state) => { state.settings.timeout = 7; });
  assert.deepEqual((await store.backups()).map((item) => item.reason), ['daily']);
  await edit((state) => { state.settings.timeout = 8; });
  assert.equal((await store.backups()).length, 1);
  await edit((state) => { state.categories = state.categories.slice(1); state.links = state.links.filter((link) => link.categoryId !== 'ai'); });
  assert.equal((await store.backups())[0].reason, 'bulk');
  for (let index = 0; index < BACKUP_KEEP + 3; index += 1) { now.tick(); await store.backupNow(); }
  const listed = await store.backups();
  assert.equal(listed.length, BACKUP_KEEP);
  const restored = await store.restoreBackup(listed.at(-1).id);
  assert.equal((await store.backups())[0].reason, 'before-restore');
  assert.ok(restored.revision > 1);
});

test('merge keeps edits made to different items on each side', () => {
  const base = { ...emptyDocument(), categories: [{ id: 'ai', name: 'AI' }], links: [site('a', 'https://a.com'), site('b', 'https://b.com')], settings: { timeout: 5, openInNewTab: true } };
  const local = structuredClone(base);
  local.links[0].name = 'A local';
  local.links.push(site('c', 'https://c.com'));
  local.settings.timeout = 9;
  const remote = structuredClone(base);
  remote.links = remote.links.filter((link) => link.id !== 'b');
  remote.settings.openInNewTab = false;
  const { document, conflicts } = mergeDocuments(base, local, remote);
  assert.deepEqual(ids(document), ['a', 'c']);
  assert.equal(document.links.find((link) => link.id === 'a').name, 'A local');
  assert.deepEqual(document.settings, { timeout: 9, openInNewTab: false });
  assert.deepEqual(conflicts, []);
});

test('merge resolves a field both sides changed by the newer edit, field by field', () => {
  const base = { ...emptyDocument(), categories: [{ id: 'ai', name: 'AI' }], links: [site('a', 'https://a.com')] };
  const local = structuredClone(base);
  local.links[0].name = 'local name';
  local.links[0].pinned = true;
  const remote = structuredClone(base);
  remote.links[0].name = 'remote name';
  remote.links[0].order = 3;
  const remoteWins = mergeDocuments(base, local, remote, { preferLocal: false });
  assert.deepEqual({ ...remoteWins.document.links[0] }, { ...site('a', 'https://a.com'), name: 'remote name', pinned: true, order: 3 });
  assert.equal(remoteWins.conflicts.length, 1);
  assert.equal(mergeDocuments(base, local, remote, { preferLocal: true }).document.links[0].name, 'local name');
});

test('merge keeps an item edited on one side and deleted on the other, and its category', () => {
  const base = { ...emptyDocument(), categories: [{ id: 'ai', name: 'AI' }, { id: 'x', name: 'X' }], links: [site('a', 'https://a.com', { categoryId: 'x' })] };
  const local = structuredClone(base);
  local.links[0].name = 'renamed';
  const remote = { ...structuredClone(base), categories: [{ id: 'ai', name: 'AI' }], links: [] };
  const { document, conflicts } = mergeDocuments(base, local, remote);
  assert.equal(document.links[0].name, 'renamed');
  assert.ok(document.categories.some((item) => item.id === 'x'));
  assert.equal(conflicts[0].kind, 'kept-edited');
  // A site added on one side into a category deleted on the other brings it back.
  const added = structuredClone(base);
  added.links.push(site('b', 'https://b.com', { categoryId: 'x' }));
  const merged = mergeDocuments(base, added, remote).document;
  assert.deepEqual(ids(merged), ['b']);
  assert.ok(merged.categories.some((item) => item.id === 'x'));
});

test('merge keeps one copy of an address added on both devices', () => {
  const base = { ...emptyDocument(), categories: [{ id: 'ai', name: 'AI' }] };
  const local = { ...structuredClone(base), links: [site('l1', 'https://same.com')] };
  const remote = { ...structuredClone(base), links: [site('r1', 'https://same.com/')] };
  assert.deepEqual(ids(mergeDocuments(base, local, remote).document), ['r1']);
});

test('the sync document survives gzip, chunks and hash checks', async () => {
  // Real ids are random UUIDs, which compress far less than counters.
  const document = { ...emptyDocument(), links: Array.from({ length: 400 }, (_, index) => site(crypto.randomUUID(), 'https://' + crypto.randomUUID().slice(0, 8) + '.example.com/' + index)) };
  const encoded = await encodeDocument(document);
  assert.ok(encoded.chunks.length > 1);
  assert.ok(encoded.chunks.every((chunk) => chunk.length <= 7000));
  assert.ok(encoded.bytes < encoded.rawBytes / 3, 'gzip keeps it well under the raw size');
  assert.deepEqual(await decodeDocument(encoded.chunks, encoded.hash), document);
  assert.equal(await decodeDocument(encoded.chunks, 'f'.repeat(64)), null);
});

test('the channel waits for missing chunks, replaces old ones and refuses oversize documents', async () => {
  const area = fakeArea();
  const channel = createChromeSyncChannel({ area });
  assert.equal(await channel.read(), null);
  await channel.write({ ...emptyDocument(), settings: { timeout: 1 } }, { editedAt: 'e1', deviceId: 'd1' });
  await channel.write({ ...emptyDocument(), settings: { timeout: 2 } }, { editedAt: 'e2', deviceId: 'd1' });
  assert.equal(Object.keys(area.data).filter((key) => key !== META_KEY).length, 1, 'old generation removed');
  const read = await channel.read();
  assert.equal(read.document.settings.timeout, 2);
  assert.equal(read.editedAt, 'e2');
  // The meta arrived from another device before its chunk.
  for (const key of Object.keys(area.data)) if (key !== META_KEY) delete area.data[key];
  assert.deepEqual((await channel.read()).incomplete, true);
  // Random text does not compress: 200 KB of it cannot fit.
  const noise = Array.from({ length: 4000 }, () => crypto.randomUUID()).join('');
  await assert.rejects(channel.write({ ...emptyDocument(), prefs: { noise } }, {}), SyncQuotaError);
});

test('two devices converge, keeping offline edits from both', async () => {
  const cloud = fakeArea();
  const laptop = device(cloud, clock('2026-11-26T08:00:00Z'));
  const desktop = device(cloud, clock('2026-11-26T08:00:30Z'));

  // The laptop has its own sites and turns sync on first: they go up.
  await laptop.edit((state) => { state.links.push(site('laptop', 'https://laptop.example')); });
  assert.equal((await laptop.engine.enable()).state, 'idle');
  // A fresh desktop with only the starter sites takes the synced copy as is.
  await desktop.engine.enable();
  assert.deepEqual(ids(await desktop.store.state()), ids(await laptop.store.state()));

  // Both change things without syncing (offline), then sync in turn.
  await laptop.edit((state) => { state.links.push(site('only-laptop', 'https://l.example')); state.settings.timeout = 12; });
  await desktop.edit((state) => {
    state.links = state.links.filter((link) => link.id !== 'chatgpt');
    state.links.push(site('only-desktop', 'https://d.example'));
    state.settings.openInNewTab = false;
  });
  await laptop.engine.run();
  await desktop.engine.run();
  await laptop.engine.run();
  const [a, b] = [await laptop.store.state(), await desktop.store.state()];
  assert.deepEqual(ids(a), ids(b));
  assert.ok(ids(a).includes('only-laptop') && ids(a).includes('only-desktop') && !ids(a).includes('chatgpt'));
  assert.deepEqual(a.settings, b.settings);
  assert.equal(a.settings.timeout, 12);
  assert.equal(a.settings.openInNewTab, false);

  // A run with nothing new writes nothing.
  const before = JSON.stringify(cloud.data);
  const revision = (await laptop.store.state()).revision;
  await laptop.engine.run();
  assert.equal(JSON.stringify(cloud.data), before);
  assert.equal((await laptop.store.state()).revision, revision);
});

test('companion preferences sync key by key', async () => {
  const cloud = fakeArea();
  const one = device(cloud);
  const two = device(cloud, clock('2026-11-26T09:00:00Z'));
  await one.store.setPrefs({ enabled: true, games: ['bd2'], rotation: 5 });
  await one.engine.enable();
  await two.engine.enable();
  assert.deepEqual((await two.store.prefs()).value, { enabled: true, games: ['bd2'], rotation: 5 });
  assert.equal((await two.store.prefs()).origin, 'sync');
  await one.store.setPrefs({ enabled: true, games: ['bd2', 'nikke'], rotation: 5 });
  await two.store.setPrefs({ enabled: true, games: ['bd2'], rotation: 10 });
  await one.engine.run();
  await two.engine.run();
  await one.engine.run();
  for (const side of [one, two]) assert.deepEqual((await side.store.prefs()).value, { enabled: true, games: ['bd2', 'nikke'], rotation: 10 });
});

test('turning sync on with data on both sides can replace either one', async () => {
  const cloud = fakeArea();
  const first = device(cloud);
  await first.edit((state) => { state.links.push(site('cloud-only', 'https://cloud.example')); });
  await first.engine.enable();
  const second = device(cloud);
  await second.edit((state) => { state.links.push(site('local-only', 'https://local.example')); });

  const view = await second.engine.inspect();
  assert.equal(view.remote.same, false);
  assert.equal(view.local.links, seed.links.length + 1);

  await second.engine.enable('remote');
  assert.ok(ids(await second.store.state()).includes('cloud-only'));
  assert.ok(!ids(await second.store.state()).includes('local-only'));
  assert.equal((await second.store.backups())[0].reason, 'sync', 'the replaced copy was backed up');

  await second.engine.disable();
  await second.edit((state) => { state.links.push(site('mine', 'https://mine.example')); });
  await second.engine.enable('local');
  await first.engine.run();
  assert.ok(ids(await first.store.state()).includes('mine'));
});

test('a failed write is reported in the status and retried by the next run', async () => {
  const cloud = fakeArea();
  const one = device(cloud);
  const set = cloud.set;
  cloud.set = async () => { throw new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded'); };
  const failed = await one.engine.enable();
  assert.equal(failed.state, 'error');
  assert.match(failed.lastError, /quota/);
  cloud.set = set;
  const ok = await one.engine.run();
  assert.equal(ok.state, 'idle');
  assert.ok(cloud.data[META_KEY]);
});

test('the local backend answers the page\'s API like the server', async () => {
  const cloud = fakeArea();
  const one = device(cloud);
  const backend = createLocalBackend({ store: one.store, knownSites, sync: one.engine });
  const state = await backend.request('/api/state');
  assert.equal(state.revision, 1);
  const saved = await backend.request('/api/state', { method: 'PUT', body: JSON.stringify({ ...state, settings: { ...state.settings, timeout: 3 } }) });
  assert.equal(saved.settings.timeout, 3);
  const recognized = await backend.request('/api/metadata', { method: 'POST', body: JSON.stringify({ url: 'https://unknown.example/x' }) });
  assert.equal(recognized.icon, 'https://unknown.example/favicon.ico');
  const batch = await backend.request('/api/metadata', { method: 'POST', body: JSON.stringify({ urls: ['github.com', 'not a url'] }) });
  assert.equal(batch.items[0].name, 'GitHub');
  assert.equal(batch.items[1], null);
  const { backups } = await backend.request('/api/backups', { method: 'POST', body: '{}' });
  assert.ok(backups.length >= 1);
  assert.equal((await backend.request('/api/backups/' + backups[0].id)).version, 1);
  assert.deepEqual(await backend.request('/api/link-check'), { job: null, results: {} });
  await assert.rejects(backend.request('/api/link-check', { method: 'POST', body: '{}' }), (error) => error.status === 501);
  await assert.rejects(backend.request('/api/nope'), (error) => error.status === 404);
  assert.equal((await backend.request('/api/sync')).status.enabled, false);
  assert.equal((await backend.request('/api/sync', { method: 'POST', body: JSON.stringify({ action: 'enable' }) })).status.enabled, true);
  assert.ok(one.area.data[STATE_KEY]);
});
