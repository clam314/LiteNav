import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, releaseBuild, latestFromRelease, createUpdateChecker, RELEASE_API, UPDATE_KEY } from '../public/extension-update.js';

function fakeArea() {
  const data = {};
  return {
    data,
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(items) { Object.assign(data, structuredClone(items)); },
  };
}

const release = (version, extra = {}) => ({
  html_url: 'https://github.com/clam314/LiteNav/releases/tag/extension-latest', published_at: '2026-11-27T02:51:56Z',
  assets: [
    { name: `litenav-extension-${version}.zip`, browser_download_url: `https://example.test/litenav-extension-${version}.zip` },
    { name: 'litenav-extension.zip', browser_download_url: 'https://example.test/litenav-extension.zip' },
    { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.test/SHA256SUMS.txt' },
  ],
  ...extra,
});

test('versions compare number by number', () => {
  assert.equal(compareVersions('0.1.0.10', '0.1.0.9'), 1);
  assert.equal(compareVersions('0.1.0.1', '0.1.0.1'), 0);
  assert.equal(compareVersions('0.1.0', '0.1.0.0'), 0);
  assert.equal(compareVersions('0.2.0.1', '0.10.0.1'), -1);
  assert.equal(releaseBuild('0.1.0.4'), true);
  assert.equal(releaseBuild('0.1.0'), false, 'built by hand');
});

test('the release names its version through the numbered zip', () => {
  assert.deepEqual(latestFromRelease(release('0.1.0.7')), {
    version: '0.1.0.7', zipUrl: 'https://example.test/litenav-extension.zip',
    pageUrl: 'https://github.com/clam314/LiteNav/releases/tag/extension-latest', publishedAt: '2026-11-27T02:51:56Z',
  });
  assert.equal(latestFromRelease({ assets: [{ name: 'other.zip' }] }), null);
  assert.equal(latestFromRelease(null), null);
});

test('a newer published build is offered; checks are kept for a day unless forced', async () => {
  const area = fakeArea();
  let time = Date.parse('2026-11-27T08:00:00Z');
  const calls = [];
  let published = '0.1.0.5';
  const checker = createUpdateChecker({ area, currentVersion: '0.1.0.3', now: () => time,
    fetchImpl: async (url, options) => { calls.push([url, options.headers.Accept]); return new Response(JSON.stringify(release(published))); } });
  assert.deepEqual(await checker.status(), { current: '0.1.0.3', releaseBuild: true, checkedAt: null, error: null, latest: null, available: false });
  const first = await checker.check();
  assert.deepEqual([first.available, first.latest.version, calls.length], [true, '0.1.0.5', 1]);
  assert.deepEqual(calls[0], [RELEASE_API, 'application/vnd.github+json']);
  time += 60 * 60 * 1000;
  await checker.check();
  assert.equal(calls.length, 1, 'asked at most once a day');
  published = '0.1.0.6';
  assert.equal((await checker.check({ force: true })).latest.version, '0.1.0.6');
  assert.equal(calls.length, 2);
  // Same version: nothing to offer.
  published = '0.1.0.3';
  assert.equal((await checker.check({ force: true })).available, false);
});

test('a build made by hand is never told to update; failures keep what was known', async () => {
  const area = fakeArea();
  const handmade = createUpdateChecker({ area, currentVersion: '0.1.0', fetchImpl: async () => new Response(JSON.stringify(release('0.1.0.9'))) });
  const status = await handmade.check();
  assert.deepEqual([status.releaseBuild, status.latest.version, status.available], [false, '0.1.0.9', false]);

  const known = fakeArea();
  let fail = null;
  const checker = createUpdateChecker({ area: known, currentVersion: '0.1.0.1', fetchImpl: async () => { if (fail) return fail(); return new Response(JSON.stringify(release('0.1.0.2'))); } });
  await checker.check();
  fail = () => { throw new TypeError('Failed to fetch'); };
  const offline = await checker.check({ force: true });
  assert.deepEqual([offline.error, offline.latest.version, offline.available], ['无法连接 GitHub', '0.1.0.2', true]);
  fail = () => new Response('{}', { status: 403 });
  assert.match((await checker.check({ force: true })).error, /限制/);
  fail = () => new Response('{}', { status: 404 });
  const gone = await checker.check({ force: true });
  assert.deepEqual([gone.error, gone.latest, gone.available], [null, null, false]);
  assert.ok(known.data[UPDATE_KEY].checkedAt);
});
