// Answers the page's /api requests inside the Chrome extension, in the shapes
// server.py uses, so app.js runs unchanged on either. Service monitoring and
// the link check need network access the extension does not ask for yet.
import { siteMetadata, StateError } from './state-model.js';

const parse = (body) => {
  if (body === undefined || body === null || body === '') return {};
  try { return typeof body === 'string' ? JSON.parse(body) : body; }
  catch { throw new StateError('请求内容不是有效的 JSON'); }
};

export function createLocalBackend({ store, knownSites, sync }) {
  async function metadata(url, categories, remote) {
    const result = siteMetadata(url, categories, knownSites);
    // Like server.py, an unknown site starts with its /favicon.ico.
    if (remote && !result.icon) result.icon = new URL('/favicon.ico', result.url).href;
    return result;
  }

  const routes = {
    'GET /api/state': () => store.state(),
    'PUT /api/state': (body) => store.save(body),
    'GET /api/health': async () => {
      const { links } = await store.state();
      const services = {};
      for (const link of links.filter((item) => item.kind === 'service')) {
        services[link.id] = link.monitorEnabled
          ? { status: 'unknown', latencyMs: null, lastChecked: null, consecutiveFailures: 0, message: '插件版暂不检测服务状态' }
          : { status: 'disabled', latencyMs: null, lastChecked: null, consecutiveFailures: 0, message: '未启用监控' };
      }
      return { services };
    },
    'POST /api/check': () => ({ queued: 0 }),
    'GET /api/link-check': () => ({ job: null, results: {} }),
    'POST /api/link-check': () => { throw new StateError('插件版暂不支持网址体检', 501); },
    'POST /api/metadata': async (body) => {
      const { categories } = await store.state();
      if ('urls' in body) {
        if (!Array.isArray(body.urls) || body.urls.length > 5000) throw new StateError('网址列表格式不正确');
        const items = [];
        for (const url of body.urls) {
          try { items.push(await metadata(url, categories, false)); } catch { items.push(null); }
        }
        return { items };
      }
      return metadata(body.url, categories, true);
    },
    'GET /api/backups': async () => ({ backups: await store.backups() }),
    'POST /api/backups': async () => { await store.backupNow(); return { backups: await store.backups() }; },
    'POST /api/backups/restore': (body) => store.restoreBackup(body.id),
    'GET /api/sync': async () => ({ status: await sync.status() }),
    'POST /api/sync': async (body) => {
      if (body.action === 'inspect') return { status: await sync.status(), ...await sync.inspect() };
      if (body.action === 'enable') {
        if (!['merge', 'remote', 'local'].includes(body.mode || 'merge')) throw new StateError('同步方式不正确');
        return { status: await sync.enable(body.mode || 'merge') };
      }
      if (body.action === 'disable') return { status: await sync.disable() };
      if (body.action === 'now') return { status: await sync.run() };
      throw new StateError('同步操作不正确');
    },
  };

  return {
    async request(path, { method = 'GET', body } = {}) {
      const pathname = new URL(path, 'http://litenav.invalid').pathname;
      const verb = method.toUpperCase();
      if (verb === 'GET' && pathname.startsWith('/api/backups/')) return store.readBackup(decodeURIComponent(pathname.slice('/api/backups/'.length)));
      const route = routes[verb + ' ' + pathname];
      if (!route) throw new StateError('接口不存在', 404);
      return route(parse(body));
    },
  };
}
