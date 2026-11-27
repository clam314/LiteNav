// 网址体检 for the Chrome extension: server.py's link_status, check_link and
// LinkChecker, run by the background worker, with progress and results in
// chrome.storage.local so the page can follow them and leaving it is fine.
//
// fetch() reports every network failure as the same TypeError; the worker's
// webRequest listener (net-errors.js) supplies Chrome's error code, so a
// domain that no longer resolves still counts as broken.
import { memoryLock, webLock } from './local-store.js';

export const LINK_CHECK_KEY = 'litenav.linkCheck';
// A job whose worker stopped (Chrome closed mid-check) is not running anymore.
const STALE_MS = 90 * 1000;

const SHARED_SUFFIXES = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'com.hk', 'com.tw', 'co.jp', 'co.uk', 'org.uk', 'com.au', 'co.kr']);
const LOGIN_PATH = /(^|[/._-])(login|signin|sign-in|sso|oauth|auth|passport|account)s?([/._?-]|$)/i;

export const siteHost = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

export function baseDomain(host) {
  if (/^\[.*\]$/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const labels = host.split('.');
  const size = labels.length >= 3 && SHARED_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-size).join('.');
}

// A redirect counts only when it leaves the site, and not when it merely asks you to sign in.
export function movedElsewhere(url, finalUrl) {
  if (!finalUrl || baseDomain(siteHost(finalUrl)) === baseDomain(siteHost(url))) return false;
  const final = new URL(finalUrl);
  return !LOGIN_PATH.test(final.hostname) && !LOGIN_PATH.test(final.pathname);
}

const outcome = (status, message, httpStatus = null, finalUrl = null) => ({ status, httpStatus, finalUrl, message });

// Chrome's net error (net::ERR_…) as server.py words the matching socket error.
export function classifyNetError(code) {
  const error = String(code || '');
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(error)) return outcome('broken', '域名无法解析');
  if (/ERR_CERT_|ERR_SSL_|ERR_BAD_SSL/.test(error)) return outcome('unreachable', '证书无效或加密连接失败');
  if (/TIMED_OUT/.test(error)) return outcome('unreachable', '请求超时');
  if (/ERR_CONNECTION_REFUSED/.test(error)) return outcome('unreachable', '连接被拒绝');
  return outcome('unreachable', '连接失败');
}

export function classifyResponse(url, response) {
  const status = response.status;
  const moved = movedElsewhere(url, response.url) ? response.url : null;
  if (status >= 200 && status < 400) {
    return moved ? outcome('redirected', '已跳转到 ' + siteHost(moved), status, moved) : outcome('ok', '可以访问', status);
  }
  if (status === 404 || status === 410) return outcome('broken', '页面不存在（HTTP ' + status + '）', status, moved);
  const server = response.headers.get('server') || '';
  const challenged = Boolean(response.headers.get('cf-mitigated')) || server.toLowerCase().includes('cloudflare');
  if (status === 401 || status === 403 || status === 429 || (status === 503 && challenged)) {
    return outcome('restricted', '网站可达，但拒绝了自动访问（HTTP ' + status + '）', status);
  }
  return outcome('unreachable', '网站返回错误（HTTP ' + status + '）', status);
}

// One attempt. netError(url) resolves Chrome's error code for a failed request, or ''.
export async function linkStatus(url, { timeout = 8, fetchImpl = globalThis.fetch.bind(globalThis), netError = async () => '' } = {}) {
  const request = (method) => fetchImpl(url, { method, credentials: 'omit', cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(timeout * 1000) });
  let response;
  try {
    response = await request('HEAD');
    // Plenty of servers mishandle HEAD; only trust a non-success answer after a real GET.
    if (!(response.status >= 200 && response.status < 300)) {
      response = await request('GET');
      response.body?.cancel?.().catch?.(() => {});
    }
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return outcome('unreachable', '请求超时');
    return classifyNetError(await netError(url));
  }
  return classifyResponse(url, response);
}

export async function checkLink(url, options = {}) {
  const { retryDelay = 1500 } = options;
  let result = await linkStatus(url, options);
  if (result.status === 'broken' || result.status === 'unreachable') {
    // One retry keeps a brief hiccup from labelling a site dead.
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
    result = await linkStatus(url, options);
  }
  return result;
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function createLinkChecker({ store, area, withLock = globalThis.navigator?.locks ? webLock('litenav-link-check') : memoryLock(), now = () => new Date(),
  check = checkLink, workers = 8 }) {
  const read = async () => ({ job: null, results: {}, ...((await area.get(LINK_CHECK_KEY))[LINK_CHECK_KEY] || {}) });
  const write = (value) => area.set({ [LINK_CHECK_KEY]: value });
  const iso = () => now().toISOString();
  const alive = (job) => Boolean(job?.running) && now().getTime() - Date.parse(job.heartbeat || job.startedAt) < STALE_MS;

  async function update(change) {
    await withLock(async () => {
      const value = await read();
      change(value);
      await write(value);
    });
  }

  // What server.py's GET /api/link-check answers: results still describing
  // the address each site has now.
  async function status() {
    const [{ job, results }, state] = await Promise.all([read(), store.state()]);
    const urls = new Map(state.links.filter((link) => link.kind === 'website').map((link) => [link.id, link.url]));
    const current = Object.fromEntries(Object.entries(results).filter(([id, result]) => urls.get(id) === result.url));
    const shown = job ? { running: alive(job), total: job.total, done: job.done, startedAt: job.startedAt, finishedAt: job.finishedAt || (alive(job) ? null : job.heartbeat) } : { running: false, total: 0, done: 0, startedAt: null, finishedAt: null };
    return { job: shown, results: current };
  }

  async function runJob(links, timeout) {
    const queue = [...links];
    const one = async () => {
      for (let link = queue.shift(); link; link = queue.shift()) {
        let result;
        try { result = await check(link.url, { timeout }); }
        catch { result = outcome('unreachable', '连接失败'); }
        await update((value) => {
          value.results[link.id] = { ...result, url: link.url, checkedAt: iso() };
          value.job.done += 1;
          value.job.heartbeat = iso();
        });
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(workers, links.length) }, one)); }
    finally { await update((value) => { value.job.running = false; value.job.finishedAt = iso(); }); }
  }

  return {
    status,

    // Starts a check and resolves with the job; done() resolves when it ends.
    async start(ids) {
      if (ids !== undefined && ids !== null && (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string'))) throw fail('网址 ID 格式不正确');
      const state = await store.state();
      const links = state.links.filter((link) => link.kind === 'website' && (ids == null || ids.includes(link.id)));
      if (!links.length) throw fail('没有可检测的网址');
      let started = false;
      await withLock(async () => {
        const value = await read();
        if (alive(value.job)) return;
        // Results of sites that are gone or moved go; the rest stay until rechecked.
        const urls = new Map(state.links.map((link) => [link.id, link.url]));
        for (const [id, result] of Object.entries(value.results)) if (urls.get(id) !== result.url) delete value.results[id];
        value.job = { running: true, total: links.length, done: 0, startedAt: iso(), heartbeat: iso(), finishedAt: null };
        await write(value);
        started = true;
      });
      if (!started) throw fail('正在检测中，请等待本次检测完成', 409);
      const timeout = Math.max(8, Number(state.settings.timeout) || 8);
      const done = runJob(links, timeout);
      return { ...(await status()), done };
    },
  };
}
