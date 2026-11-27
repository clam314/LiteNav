// A self-hosted 轻航 server (server.py) as a channel for 云同步: the extension
// reads and writes the same /api/state the server's own pages use, so the
// server version and every browser with the extension share one copy.
export const SERVER_KEY = 'litenav.syncServer';

export class SyncConflictError extends Error {
  constructor() {
    super('服务器上的配置刚被修改，正在重新合并');
    this.conflict = true;
  }
}

// The server's address as typed: scheme added, path and query dropped.
export function serverOrigin(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('请填写服务器地址');
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw); }
  catch { throw new Error('服务器地址格式不正确'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('请填写 http 或 https 开头的服务器地址');
  // A server behind a reverse proxy may live under a path: keep it.
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function createServerSyncChannel({ url, password = '', fetchImpl = globalThis.fetch.bind(globalThis), timeout = 10000 }) {
  const base = serverOrigin(url);
  let revision = null;
  const headers = { Accept: 'application/json' };
  // Any user name will do: server.py only checks the password.
  if (password) headers.Authorization = 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode('litenav:' + password)));

  async function call(method, body) {
    let response;
    try {
      // credentials: 'omit' keeps Chrome from showing its own sign-in prompt on a 401.
      response = await fetchImpl(base + '/api/state', { method, headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      throw new Error(error?.name === 'TimeoutError' ? '连接服务器超时' : '无法连接服务器，请检查地址和网络');
    }
    if (response.status === 401) throw new Error('访问口令不正确');
    if (response.status === 409) throw new SyncConflictError();
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(value?.error || '服务器返回错误（HTTP ' + response.status + '）');
    if (!value || !Array.isArray(value.links) || !Array.isArray(value.categories)) throw new Error('这个地址不是轻航服务器');
    return value;
  }

  const shape = (state) => ({
    document: { categories: state.categories, links: state.links, settings: state.settings, prefs: state.prefs ?? null },
    // A server's copy counts as edited once anything saved it.
    editedAt: state.updatedAt || null, configEditedAt: state.updatedAt || null, writtenAt: state.updatedAt || null, deviceId: null, bytes: 0,
  });

  return {
    id: 'server',
    origin: base,

    async read() {
      const state = await call('GET');
      revision = state.revision;
      return shape(state);
    },

    // Written against the revision last read: an edit made on the server in
    // between is refused (409) and the run merges again.
    async write(document) {
      if (revision === null) await this.read();
      const state = await call('PUT', { revision, ...document });
      revision = state.revision;
      return { bytes: 0 };
    },
  };
}
