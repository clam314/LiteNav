// Answers the page's /api requests inside the Chrome extension, in the shapes
// server.py uses, so app.js runs unchanged on either.
import { siteMetadata, StateError } from './state-model.js';
import { fetchPage, parsePage } from './site-page.js';
import { serverOrigin, SERVER_KEY } from './sync-server.js';

const parse = (body) => {
  if (body === undefined || body === null || body === '') return {};
  try { return typeof body === 'string' ? JSON.parse(body) : body; }
  catch { throw new StateError('请求内容不是有效的 JSON'); }
};

const PROVIDERS = ['chrome', 'server'];

export const JUST_UPDATED_KEY = 'litenav.justUpdated';

export function createLocalBackend({ store, knownSites, sync, monitor, linkCheck, area, update, hostAccess = async () => false, fetchPageImpl = fetchPage }) {
  // Like server.py: the built-in table first; otherwise read the page, when
  // the extension may (host access), keeping /favicon.ico if it says nothing.
  async function metadata(url, categories, remote) {
    const result = siteMetadata(url, categories, knownSites);
    if (!remote || result.icon) return result;
    result.icon = new URL('/favicon.ico', result.url).href;
    if (!await hostAccess()) return result;
    const page = await fetchPageImpl(result.url);
    if (!page) return result;
    const found = parsePage(page.html, page.url);
    if (found.name) result.name = found.name;
    if (found.icon) result.icon = found.icon;
    return result;
  }

  const provider = (value) => {
    const chosen = value || 'chrome';
    if (!PROVIDERS.includes(chosen)) throw new StateError('同步方式不正确');
    return chosen;
  };

  const routes = {
    'GET /api/state': () => store.state(),
    'PUT /api/state': (body) => store.save(body),
    'GET /api/health': () => monitor.health(),
    // Like server.py, the checks run on after the answer.
    'POST /api/check': async (body) => {
      const id = body.id ?? null;
      if (id !== null && typeof id !== 'string') throw new StateError('服务 ID 格式不正确');
      const { links } = await store.state();
      const services = links.filter((link) => link.kind === 'service');
      if (id !== null && !services.some((link) => link.id === id)) throw new StateError('服务不存在', 404);
      const queued = services.filter((link) => link.monitorEnabled && (id === null || link.id === id)).length;
      monitor.check(id).catch(() => {});
      return { queued };
    },
    'GET /api/link-check': () => linkCheck.status(),
    'POST /api/link-check': async (body) => {
      if (!await hostAccess()) throw new StateError('网址体检需要先允许轻航访问网站', 403);
      const { job, results } = await linkCheck.start(body.ids ?? null);
      return { job, results };
    },
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
    // 检查更新; justUpdated is set by the worker after the extension's files were replaced.
    'GET /api/update': async () => ({ ...await update.status(), justUpdated: (await area.get(JUST_UPDATED_KEY))[JUST_UPDATED_KEY] || null }),
    'POST /api/update': async (body) => {
      if (body.action === 'check') return { ...await update.check({ force: true }), justUpdated: null };
      if (body.action === 'seen') { await area.remove(JUST_UPDATED_KEY); return { ok: true }; }
      throw new StateError('更新操作不正确');
    },
    'GET /api/sync': async () => ({ status: await sync.status() }),
    'POST /api/sync': async (body) => {
      if (body.action === 'inspect') return { status: await sync.status(), ...await sync.inspect(provider(body.provider)) };
      // Checks the address and password, keeps them on this computer only,
      // and answers what is on the server.
      if (body.action === 'connect-server') {
        const url = serverOrigin(body.url);
        const password = typeof body.password === 'string' ? body.password : '';
        const previous = (await area.get(SERVER_KEY))[SERVER_KEY];
        await area.set({ [SERVER_KEY]: { url, password } });
        try { return { server: url, ...await sync.inspect('server') }; }
        catch (error) {
          await (previous ? area.set({ [SERVER_KEY]: previous }) : area.remove(SERVER_KEY));
          throw error;
        }
      }
      if (body.action === 'enable') {
        if (!['merge', 'remote', 'local'].includes(body.mode || 'merge')) throw new StateError('同步方式不正确');
        const chosen = provider(body.provider);
        const server = chosen === 'server' ? (await area.get(SERVER_KEY))[SERVER_KEY]?.url : null;
        if (chosen === 'server' && !server) throw new StateError('还没有设置同步服务器');
        return { status: await sync.enable(body.mode || 'merge', { provider: chosen, server }) };
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
