// 云同步 through a real server.py: two extension devices and the server's own
// pages editing the same configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalStore, memoryLock } from '../public/local-store.js';
import { createServerSyncChannel, serverOrigin } from '../public/sync-server.js';
import { createSyncEngine } from '../public/sync-engine.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const seed = JSON.parse(await readFile(new URL('../seed.json', import.meta.url), 'utf8'));
const PASSWORD = 'sync-test-口令';

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

async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'litenav-sync-'));
  const child = spawn('python3', ['server.py', '--port', '0', '--data-dir', dataDir], { cwd: ROOT, env: { ...process.env, LITENAV_PASSWORD: PASSWORD } });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /http:\/\/[\d.]+:\d+/.exec(output);
      if (match) resolve(match[0]);
    });
    child.on('exit', (code) => reject(new Error('server exited ' + code)));
    setTimeout(() => reject(new Error('server did not start')), 10000);
  });
  return { url, stop: async () => { child.kill(); await rm(dataDir, { recursive: true, force: true }); } };
}

const auth = { Authorization: 'Basic ' + Buffer.from('x:' + PASSWORD).toString('base64') };

// The server version's own page: GET, change, PUT with the revision.
async function webEdit(url, change) {
  const state = await (await fetch(url + '/api/state', { headers: auth })).json();
  change(state);
  const response = await fetch(url + '/api/state', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

function device(url, { fetchImpl } = {}) {
  let time = Date.parse('2026-11-27T08:00:00Z') + Math.floor(Math.random() * 1000);
  const now = () => new Date(time);
  const area = fakeArea();
  const store = createLocalStore({ area, withLock: memoryLock(), seed: async () => structuredClone(seed), now });
  const channel = createServerSyncChannel({ url, password: PASSWORD, ...(fetchImpl ? { fetchImpl } : {}) });
  const engine = createSyncEngine({ store, channel, area, withLock: memoryLock(), now: () => new Date() });
  const edit = async (change) => {
    time += 1000;
    const draft = await store.state();
    change(draft);
    return store.save(draft);
  };
  return { area, store, engine, edit };
}

const site = (id, url, extra = {}) => ({ id, name: id, url, icon: '', kind: 'website', categoryId: 'ai', pinned: false, order: 20, pinnedOrder: 20, monitorEnabled: false, ...extra });
const ids = (state) => state.links.map((link) => link.id).sort();

test('serverOrigin accepts what people type', () => {
  assert.equal(serverOrigin('192.168.1.10:8765'), 'http://192.168.1.10:8765');
  assert.equal(serverOrigin('https://nav.example.com/'), 'https://nav.example.com');
  assert.equal(serverOrigin('https://example.com/litenav/?x=1'), 'https://example.com/litenav');
  assert.throws(() => serverOrigin('ftp://x'), /http/);
  assert.throws(() => serverOrigin(''), /请填写/);
});

test('extension devices and the server pages share one configuration', async (t) => {
  const server = await startServer();
  t.after(server.stop);

  const wrong = createServerSyncChannel({ url: server.url, password: 'nope' });
  await assert.rejects(wrong.read(), /访问口令不正确/);

  // The laptop has edits of its own and connects first: they go up.
  const laptop = device(server.url);
  await laptop.edit((state) => { state.links.push(site('laptop', 'https://laptop.example')); });
  await laptop.store.setPrefs({ enabled: true, games: ['bd2'] });
  assert.equal((await laptop.engine.enable()).state, 'idle');
  let remote = await (await fetch(server.url + '/api/state', { headers: auth })).json();
  assert.ok(ids(remote).includes('laptop'));
  assert.deepEqual(remote.prefs, { enabled: true, games: ['bd2'] });
  assert.ok(remote.updatedAt);

  // The server's own page edits, without knowing about prefs: they stay.
  await webEdit(server.url, (state) => { delete state.prefs; state.links.push(site('web', 'https://web.example')); state.settings.timeout = 11; });
  remote = await (await fetch(server.url + '/api/state', { headers: auth })).json();
  assert.deepEqual(remote.prefs, { enabled: true, games: ['bd2'] });

  // A fresh desktop takes the server's copy.
  const desktop = device(server.url);
  await desktop.engine.enable();
  assert.deepEqual(ids(await desktop.store.state()), ids(remote));
  assert.deepEqual((await desktop.store.prefs()).value, { enabled: true, games: ['bd2'] });

  // Everyone edits; each sync merges.
  await laptop.edit((state) => { state.links = state.links.filter((link) => link.id !== 'chatgpt'); });
  await desktop.edit((state) => { state.links.push(site('desktop', 'https://desktop.example')); state.settings.openInNewTab = false; });
  await webEdit(server.url, (state) => { state.links.push(site('web2', 'https://web2.example')); });
  await laptop.engine.run();
  await desktop.engine.run();
  await laptop.engine.run();
  remote = await (await fetch(server.url + '/api/state', { headers: auth })).json();
  for (const state of [remote, await laptop.store.state(), await desktop.store.state()]) {
    const list = ids(state);
    assert.ok(['laptop', 'web', 'web2', 'desktop'].every((id) => list.includes(id)) && !list.includes('chatgpt'), list.join(','));
    assert.equal(state.settings.timeout, 11);
    assert.equal(state.settings.openInNewTab, false);
  }
});

test('a page saving on the server between read and write is merged, not lost', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  let interfere = false;
  const sneaky = async (url, options) => {
    if (interfere && options.method === 'PUT') {
      interfere = false;
      await webEdit(server.url, (state) => { state.links.push(site('meanwhile', 'https://meanwhile.example')); });
    }
    return fetch(url, options);
  };
  const laptop = device(server.url, { fetchImpl: sneaky });
  await laptop.engine.enable();
  await laptop.edit((state) => { state.links.push(site('mine', 'https://mine.example')); });
  interfere = true;
  const status = await laptop.engine.run();
  assert.equal(status.state, 'idle', status.lastError);
  const remote = await (await fetch(server.url + '/api/state', { headers: auth })).json();
  assert.ok(ids(remote).includes('mine') && ids(remote).includes('meanwhile'));
  assert.ok(ids(await laptop.store.state()).includes('meanwhile'));
});

test('回收站 travels through the server: deletions, restores and emptying', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const laptop = device(server.url);
  await laptop.edit((state) => { state.links.push(site('keep', 'https://keep.example')); });
  await laptop.engine.enable();
  // Deleted on the server's own page: the server puts it in 回收站, the laptop gets both.
  await webEdit(server.url, (state) => { state.links = state.links.filter((link) => link.id !== 'keep'); });
  await laptop.engine.run();
  let mine = await laptop.store.state();
  assert.ok(!ids(mine).includes('keep'));
  assert.deepEqual(mine.trash.map((entry) => entry.id), ['keep']);
  // Emptied on the laptop: empty on the server too, not recorded again.
  await laptop.edit((state) => { state.trash = []; });
  await laptop.engine.run();
  const remote = await (await fetch(server.url + '/api/state', { headers: auth })).json();
  assert.equal(remote.trash, undefined);
  assert.ok(!ids(remote).includes('keep'));
});
