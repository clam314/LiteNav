// Service monitoring for the Chrome extension: server.py's probe, Monitor and
// health records, run by the background worker on an alarm (and by pages for
// 立即检测), with results in chrome.storage.local.
import { memoryLock, webLock } from './local-store.js';

export const HEALTH_KEY = 'litenav.health';

// Is the service up? 2xx/3xx, or 401/403 (up, wants a sign-in). The body is
// never read. Without host access the request falls back to no-cors, which
// still tells a reachable server from an unreachable one, without a status.
export async function probe(url, timeoutSeconds = 5, fetchImpl = globalThis.fetch.bind(globalThis), clock = () => performance.now()) {
  const started = clock();
  const attempt = async (mode) => {
    const response = await fetchImpl(url, { method: 'GET', mode, cache: 'no-store', credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(timeoutSeconds * 1000) });
    response.body?.cancel?.().catch?.(() => {});
    return response;
  };
  let response;
  try { response = await attempt('cors'); }
  catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { ok: false, latencyMs: null, message: '连接失败或请求超时', httpStatus: null };
    try { response = await attempt('no-cors'); }
    catch { return { ok: false, latencyMs: null, message: '连接失败或请求超时', httpStatus: null }; }
  }
  const latencyMs = Math.round(clock() - started);
  if (response.type === 'opaque') return { ok: true, latencyMs, message: '服务可达', httpStatus: null };
  const status = response.status;
  const reachable = (status >= 200 && status < 400) || status === 401 || status === 403;
  return {
    ok: reachable,
    latencyMs: reachable ? latencyMs : null,
    message: reachable ? (status === 401 || status === 403 ? '服务可达，需登录' : '服务可达') : 'HTTP ' + status,
    httpStatus: status,
  };
}

const target = (link) => link.checkUrl || link.url;

export function createMonitor({ store, area, withLock = globalThis.navigator?.locks ? webLock('litenav-health') : memoryLock(), now = () => new Date(), probeImpl = probe }) {
  const read = async () => (await area.get(HEALTH_KEY))[HEALTH_KEY] || {};
  const inflight = new Set();

  // What server.py's /api/health answers. A record made for another address
  // (the service was edited since) no longer counts.
  async function health(state) {
    state ||= await store.state();
    const records = await read();
    const services = {};
    for (const link of state.links.filter((item) => item.kind === 'service')) {
      let record = records[link.id];
      if (!record || record.target !== target(link)) record = { status: 'unknown', latencyMs: null, lastChecked: null, consecutiveFailures: 0, message: '尚未检测' };
      if (!link.monitorEnabled) record = { status: 'disabled', latencyMs: null, lastChecked: null, consecutiveFailures: 0, message: '未启用监控' };
      const { target: _, ...shown } = record;
      services[link.id] = shown;
    }
    return { services };
  }

  async function record(link, result, threshold) {
    await withLock(async () => {
      const state = await store.state();
      const live = state.links.find((item) => item.id === link.id);
      // Edited or switched off while the check ran: the result is stale.
      if (!live || live.kind !== 'service' || !live.monitorEnabled || target(live) !== target(link)) return;
      const records = await read();
      const previous = records[link.id]?.target === target(link) ? records[link.id] : {};
      const failures = result.ok ? 0 : (previous.consecutiveFailures || 0) + 1;
      records[link.id] = {
        status: result.ok ? 'online' : failures >= threshold ? 'offline' : 'degraded',
        latencyMs: result.latencyMs ?? null,
        lastChecked: now().toISOString(),
        consecutiveFailures: failures,
        message: result.message || '',
        httpStatus: result.httpStatus ?? null,
        target: target(link),
      };
      // Drop records of services that are gone.
      const ids = new Set(state.links.filter((item) => item.kind === 'service').map((item) => item.id));
      for (const id of Object.keys(records)) if (!ids.has(id)) delete records[id];
      await area.set({ [HEALTH_KEY]: records });
    });
  }

  async function run(links, settings) {
    const queue = links.filter((link) => !inflight.has(link.id));
    queue.forEach((link) => inflight.add(link.id));
    // Four at a time, like server.py.
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let link = queue.shift(); link; link = queue.shift()) {
        try { await record(link, await probeImpl(target(link), settings.timeout), settings.failureThreshold); }
        finally { inflight.delete(link.id); }
      }
    });
    await Promise.all(workers);
  }

  return {
    health,

    // 立即检测: one service, or every monitored one. Resolves when done.
    async check(id) {
      const state = await store.state();
      const services = state.links.filter((link) => link.kind === 'service');
      if (id !== undefined && id !== null && !services.some((link) => link.id === id)) {
        const error = new Error('服务不存在');
        error.status = 404;
        throw error;
      }
      const selected = services.filter((link) => link.monitorEnabled && (id == null || link.id === id));
      await run(selected, state.settings);
      return selected.length;
    },

    // The scheduler's tick: services not checked within the interval.
    async due() {
      const state = await store.state();
      const { services } = await health(state);
      const limit = now().getTime() - state.settings.checkInterval * 1000;
      // A little slack, so an alarm that fires a moment early still checks.
      const selected = state.links.filter((link) => link.kind === 'service' && link.monitorEnabled &&
        (!services[link.id]?.lastChecked || Date.parse(services[link.id].lastChecked) <= limit + 2000));
      await run(selected, state.settings);
      return selected.length;
    },

    async offline() {
      const { services } = await health();
      return Object.values(services).filter((record) => record.status === 'offline').length;
    },
  };
}
