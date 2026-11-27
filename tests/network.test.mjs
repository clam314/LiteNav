import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLocalStore, memoryLock } from '../public/local-store.js';
import { probe, createMonitor, HEALTH_KEY } from '../public/monitor.js';
import { classifyResponse, classifyNetError, linkStatus, checkLink, createLinkChecker, movedElsewhere, LINK_CHECK_KEY } from '../public/link-check.js';
import { parsePage, pageCharset, fetchPage } from '../public/site-page.js';
import { parseBookmarks, bookmarksFromTree } from '../public/bookmarks.js';
import { createLocalBackend } from '../public/local-backend.js';

const seed = JSON.parse(await readFile(new URL('../seed.json', import.meta.url), 'utf8'));
const knownSites = JSON.parse(await readFile(new URL('../public/known-sites.json', import.meta.url), 'utf8'));

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

const reply = (status, { url = '', headers = {}, type = 'basic' } = {}) => ({ status, url, type, headers: new Headers(headers), body: null });
const netFailure = () => Object.assign(new TypeError('Failed to fetch'));
const timeoutFailure = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });

function clock(start = '2026-11-27T08:00:00Z') {
  let time = Date.parse(start);
  const now = () => new Date(time);
  now.tick = (ms) => { time += ms; };
  return now;
}

async function storeWithServices(now = clock()) {
  const area = fakeArea();
  const store = createLocalStore({ area, withLock: memoryLock(), seed: async () => structuredClone(seed), now });
  const state = await store.state();
  state.links.push(
    { id: 'nas', name: 'NAS', url: 'http://nas.lan:5000', kind: 'service', categoryId: null, monitorEnabled: true },
    { id: 'tv', name: 'TV', url: 'http://tv.lan', checkUrl: 'http://tv.lan/health', kind: 'service', categoryId: null, monitorEnabled: true },
    { id: 'off', name: 'Off', url: 'http://off.lan', kind: 'service', categoryId: null, monitorEnabled: false },
  );
  state.settings.failureThreshold = 2;
  await store.save(state);
  return { area, store, now };
}

test('probe counts 2xx, 3xx, 401 and 403 as up, without reading the body', async () => {
  for (const [status, ok, message] of [[200, true, '服务可达'], [302, true, '服务可达'], [401, true, '服务可达，需登录'], [403, true, '服务可达，需登录'], [500, false, 'HTTP 500'], [404, false, 'HTTP 404']]) {
    const result = await probe('http://x.lan', 5, async () => reply(status), () => 0);
    assert.equal(result.ok, ok, String(status));
    assert.equal(result.message, message);
    assert.equal(result.httpStatus, status);
  }
});

test('probe without host access falls back to no-cors and still tells up from down', async () => {
  const modes = [];
  const up = await probe('http://x.lan', 5, async (url, options) => { modes.push(options.mode); if (options.mode === 'cors') throw netFailure(); return reply(0, { type: 'opaque' }); });
  assert.deepEqual(modes, ['cors', 'no-cors']);
  assert.deepEqual([up.ok, up.httpStatus, up.message], [true, null, '服务可达']);
  const down = await probe('http://x.lan', 5, async () => { throw netFailure(); });
  assert.equal(down.ok, false);
  // A timeout is not retried.
  let calls = 0;
  const slow = await probe('http://x.lan', 5, async () => { calls += 1; throw timeoutFailure(); });
  assert.equal(slow.ok, false);
  assert.equal(calls, 1);
});

test('monitor records degraded, then offline at the threshold, and recovers', async () => {
  const { area, store, now } = await storeWithServices();
  let up = false;
  const seen = [];
  const monitor = createMonitor({ store, area, withLock: memoryLock(), now, probeImpl: async (url) => { seen.push(url); return up ? { ok: true, latencyMs: 12, message: '服务可达', httpStatus: 200 } : { ok: false, latencyMs: null, message: '连接失败或请求超时', httpStatus: null }; } });
  assert.equal(await monitor.check(), 2);
  assert.deepEqual(seen.sort(), ['http://nas.lan:5000', 'http://tv.lan/health']);
  let { services } = await monitor.health();
  assert.equal(services.nas.status, 'degraded');
  assert.equal(services.off.status, 'disabled');
  await monitor.check('nas');
  ({ services } = await monitor.health());
  assert.equal(services.nas.status, 'offline');
  assert.equal(services.nas.consecutiveFailures, 2);
  assert.equal(await monitor.offline(), 1);
  up = true;
  await monitor.check('nas');
  ({ services } = await monitor.health());
  assert.deepEqual([services.nas.status, services.nas.latencyMs, services.nas.consecutiveFailures], ['online', 12, 0]);
  assert.equal('target' in services.nas, false);
  await assert.rejects(monitor.check('missing'), (error) => error.status === 404);
});

test('monitor forgets a result once the service address changes, and checks only what is due', async () => {
  const { area, store, now } = await storeWithServices();
  const seen = [];
  const monitor = createMonitor({ store, area, withLock: memoryLock(), now, probeImpl: async (url) => { seen.push(url); return { ok: true, latencyMs: 5, message: '服务可达', httpStatus: 200 }; } });
  assert.equal(await monitor.due(), 2);
  assert.equal(await monitor.due(), 0, 'nothing due within the interval');
  now.tick(61 * 1000);
  assert.equal(await monitor.due(), 2);
  const state = await store.state();
  state.links.find((link) => link.id === 'nas').url = 'http://nas2.lan:5000';
  await store.save(state);
  assert.equal((await monitor.health()).services.nas.status, 'unknown');
  assert.equal(await monitor.due(), 1);
  // Deleted services lose their records at the next check.
  const fewer = await store.state();
  fewer.links = fewer.links.filter((link) => link.id !== 'tv');
  await store.save(fewer);
  await monitor.check('nas');
  assert.deepEqual(Object.keys(area.data[HEALTH_KEY]).sort(), ['nas']);
});

test('link classification matches server.py', () => {
  assert.deepEqual(classifyResponse('https://a.com', reply(200, { url: 'https://a.com/' })), { status: 'ok', httpStatus: 200, finalUrl: null, message: '可以访问' });
  assert.equal(classifyResponse('https://notion.so', reply(200, { url: 'https://www.notion.com/' })).status, 'redirected');
  assert.equal(classifyResponse('https://a.com', reply(200, { url: 'https://accounts.google.com/signin' })).status, 'ok', 'sign-in redirects do not count');
  assert.equal(classifyResponse('https://a.com', reply(200, { url: 'https://login.other.com/' })).status, 'ok');
  assert.equal(classifyResponse('https://www.bbc.co.uk', reply(200, { url: 'https://news.bbc.co.uk/' })).status, 'ok', 'same registrable domain');
  assert.equal(classifyResponse('https://a.com', reply(404, { url: 'https://a.com/' })).status, 'broken');
  assert.equal(classifyResponse('https://a.com', reply(410)).message, '页面不存在（HTTP 410）');
  assert.equal(classifyResponse('https://a.com', reply(429)).status, 'restricted');
  assert.equal(classifyResponse('https://a.com', reply(503, { headers: { server: 'cloudflare' } })).status, 'restricted');
  assert.equal(classifyResponse('https://a.com', reply(503)).status, 'unreachable');
  assert.equal(movedElsewhere('https://a.com', null), false);
  assert.deepEqual(classifyNetError('net::ERR_NAME_NOT_RESOLVED'), { status: 'broken', httpStatus: null, finalUrl: null, message: '域名无法解析' });
  assert.equal(classifyNetError('net::ERR_CERT_DATE_INVALID').message, '证书无效或加密连接失败');
  assert.equal(classifyNetError('net::ERR_CONNECTION_REFUSED').message, '连接被拒绝');
  assert.equal(classifyNetError('net::ERR_CONNECTION_TIMED_OUT').message, '请求超时');
  assert.equal(classifyNetError('').message, '连接失败');
});

test('linkStatus retries a failed HEAD as GET, and asks Chrome why a request failed', async () => {
  const methods = [];
  const result = await linkStatus('https://a.com', { fetchImpl: async (url, options) => { methods.push(options.method); return reply(options.method === 'HEAD' ? 405 : 200, { url }); } });
  assert.deepEqual(methods, ['HEAD', 'GET']);
  assert.equal(result.status, 'ok');
  const gone = await linkStatus('https://gone.invalid', { fetchImpl: async () => { throw netFailure(); }, netError: async () => 'net::ERR_NAME_NOT_RESOLVED' });
  assert.equal(gone.status, 'broken');
  const slow = await linkStatus('https://slow.example', { fetchImpl: async () => { throw timeoutFailure(); } });
  assert.equal(slow.message, '请求超时');
  let attempts = 0;
  const flaky = await checkLink('https://flaky.example', { retryDelay: 1, fetchImpl: async (url) => { attempts += 1; if (attempts === 1) throw netFailure(); return reply(200, { url }); } });
  assert.equal(flaky.status, 'ok');
});

test('the link checker runs one job at a time and keeps results per address', async () => {
  const now = clock();
  const area = fakeArea();
  const store = createLocalStore({ area, withLock: memoryLock(), seed: async () => structuredClone(seed), now });
  const checker = createLinkChecker({ store, area, withLock: memoryLock(), now, check: async (url) => (url.includes('github') ? { status: 'broken', httpStatus: 404, finalUrl: null, message: '页面不存在（HTTP 404）' } : { status: 'ok', httpStatus: 200, finalUrl: null, message: '可以访问' }) });
  const started = await checker.start();
  assert.equal(started.job.running, true);
  await assert.rejects(checker.start(), (error) => error.status === 409);
  await started.done;
  const { job, results } = await checker.status();
  const websites = seed.links.filter((link) => link.kind === 'website').length;
  assert.deepEqual([job.running, job.done, job.total], [false, websites, websites]);
  assert.equal(results.github.status, 'broken');
  // A result describes one address: editing it hides the result.
  const state = await store.state();
  state.links.find((link) => link.id === 'github').url = 'https://github.com/new';
  await store.save(state);
  assert.equal((await checker.status()).results.github, undefined);
  await assert.rejects(checker.start(['nope']), /没有可检测的网址/);
  // A job left running by a worker that stopped stops counting after a while.
  const value = area.data[LINK_CHECK_KEY];
  value.job = { ...value.job, running: true, finishedAt: null, heartbeat: now().toISOString() };
  now.tick(2 * 60 * 1000);
  assert.equal((await checker.status()).job.running, false);
});

test('parsePage reads the name and icon like server.py', () => {
  const html = `<!doctype html><html><head><base href="/static/"><title>  Example &amp; Co
    Home </title><meta property="og:site_name" content="Example Site"><!-- <link rel="icon" href="/commented.ico"> -->
    <script>document.write('<link rel="icon" href="/script.ico">')</script>
    <link rel="apple-touch-icon" href="touch.png"><link rel="shortcut icon" href="fav.png"></head></html>`;
  assert.deepEqual(parsePage(html, 'https://example.com/page'), { name: 'Example Site', icon: 'https://example.com/static/fav.png' });
  assert.deepEqual(parsePage('<title>Only &#x4E2D;&#25991; title</title><link rel=apple-touch-icon href=//cdn.example.com/t.png>', 'https://a.com/'), { name: 'Only 中文 title', icon: 'https://cdn.example.com/t.png' });
  assert.deepEqual(parsePage('<p>nothing</p><link rel="icon" href="javascript:alert(1)">', 'https://a.com/x'), { name: '', icon: 'https://a.com/favicon.ico' });
  assert.equal(pageCharset('text/html; charset=GBK', ''), 'GBK');
  assert.equal(pageCharset('text/html', '<meta charset="gb2312">'), 'gb2312');
  assert.equal(pageCharset('', '<meta http-equiv="Content-Type" content="text/html; charset=big5">'), 'big5');
});

test('fetchPage decodes a GBK page and skips what is not HTML', async () => {
  const gbk = Uint8Array.from([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0xd6, 0xd0, 0xce, 0xc4, 0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e]); // <title>中文</title>
  const page = await fetchPage('https://a.cn/', { fetchImpl: async () => new Response(gbk, { headers: { 'content-type': 'text/html; charset=gbk' } }) });
  assert.equal(parsePage(page.html, 'https://a.cn/').name, '中文');
  assert.equal(await fetchPage('https://a.cn/x.png', { fetchImpl: async () => new Response('x', { headers: { 'content-type': 'image/png' } }) }), null);
  assert.equal(await fetchPage('https://a.cn/', { fetchImpl: async () => { throw netFailure(); } }), null);
});

test('Chrome bookmarks group like an exported bookmark file', () => {
  const exported = `<DL><p><DT><H3 PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3><DL><p>
    <DT><A HREF="https://a.com">A</A><DT><H3>开发</H3><DL><p><DT><A HREF="https://g.com">G</A><DT><H3>子</H3><DL><p><DT><A HREF="https://x.com">X</A></DL><p></DL><p>
    <DT><A HREF="chrome://settings">S</A></DL><p><DT><H3 UNFILED_BOOKMARKS_FOLDER="true">其他书签</H3><DL><p><DT><H3>阅读</H3><DL><p><DT><A HREF="https://r.com">R</A></DL><p></DL><p></DL>`;
  const tree = [{ id: '0', title: '', children: [
    { id: '1', title: '书签栏', children: [{ title: 'A', url: 'https://a.com' }, { title: '开发', children: [{ title: 'G', url: 'https://g.com' }, { title: '子', children: [{ title: 'X', url: 'https://x.com' }] }] }, { title: 'S', url: 'chrome://settings' }] },
    { id: '2', title: '其他书签', children: [{ title: '阅读', children: [{ title: 'R', url: 'https://r.com' }] }] },
    { id: '3', title: '移动设备书签', children: [] },
  ] }];
  assert.deepEqual(bookmarksFromTree(tree), parseBookmarks(exported));
});

test('the local backend reads unknown sites only with host access, and runs checks', async () => {
  const { area, store } = await storeWithServices();
  let allowed = false;
  const pages = [];
  const monitor = createMonitor({ store, area, withLock: memoryLock(), probeImpl: async () => ({ ok: true, latencyMs: 3, message: '服务可达', httpStatus: 200 }) });
  const backend = createLocalBackend({
    store, knownSites, area, monitor, sync: null, hostAccess: async () => allowed,
    fetchPageImpl: async (url) => { pages.push(url); return { html: '<title>Blog</title><link rel=icon href=/i.svg>', url }; },
    linkCheck: { status: async () => ({ job: null, results: {} }), start: async () => ({ job: { running: true }, results: {}, done: Promise.resolve() }) },
  });
  const offline = await backend.request('/api/metadata', { method: 'POST', body: JSON.stringify({ url: 'blog.example' }) });
  assert.deepEqual([offline.name, offline.icon, pages.length], ['blog.example', 'https://blog.example/favicon.ico', 0]);
  await assert.rejects(backend.request('/api/link-check', { method: 'POST', body: '{}' }), (error) => error.status === 403);
  allowed = true;
  const online = await backend.request('/api/metadata', { method: 'POST', body: JSON.stringify({ url: 'blog.example' }) });
  assert.deepEqual([online.name, online.icon], ['Blog', 'https://blog.example/i.svg']);
  assert.equal((await backend.request('/api/metadata', { method: 'POST', body: JSON.stringify({ url: 'github.com' }) })).name, 'GitHub');
  assert.equal(pages.length, 1, 'known sites are not fetched');
  assert.deepEqual((await backend.request('/api/link-check', { method: 'POST', body: '{}' })).job, { running: true });
  assert.deepEqual(await backend.request('/api/check', { method: 'POST', body: JSON.stringify({}) }), { queued: 2 });
  await assert.rejects(backend.request('/api/check', { method: 'POST', body: JSON.stringify({ id: 'missing' }) }), (error) => error.status === 404);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await backend.request('/api/health')).services.nas.status, 'online');
});
