// The configuration rules of server.py (validate_state and its helpers),
// for the Chrome extension, which keeps the configuration in the browser.
// tests/fixtures/state-cases.json holds cases both implementations must pass.

export class StateError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const DEFAULT_SETTINGS = Object.freeze({ checkInterval: 60, failureThreshold: 3, timeout: 5, openInNewTab: true, showCompanionButton: true,
  showRecent: true, sortFavoritesByUse: false });
// 回收站: deleted sites and services, kept this long and no more than this many.
export const TRASH_DAYS = 30;
export const TRASH_LIMIT = 200;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function privateIPv4(host) {
  const match = IPV4.exec(host);
  if (!match) return null;
  const [a, b] = match.slice(1).map(Number);
  if (match.slice(1).some((part) => Number(part) > 255)) return null;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function privateIPv6(host) {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!bare.includes(':')) return null;
  if (bare === '::1') return true;
  return /^f[cd][0-9a-f]{0,2}:/.test(bare) || /^fe[89ab][0-9a-f]?:/.test(bare);
}

// LAN addresses become services: localhost, .home/.lan/.local and private,
// loopback or link-local IPs.
export function localHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.home') || host.endsWith('.lan') || host.endsWith('.local')) return true;
  return privateIPv4(host) ?? privateIPv6(host) ?? false;
}

// The address as server.py normalizes it: scheme added when missing (http for
// LAN hosts), scheme and host lower-cased, host in punycode, the rest kept.
export function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new StateError('请填写网址');
  value = value.trim();
  if (value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) throw new StateError('网址格式不正确');
  if (!value.includes('://')) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^[^/]+:\d+(?:\/|$)/.test(value)) throw new StateError('仅支持 http 和 https 网址');
    const candidateHost = value.split('/', 1)[0].split(':', 1)[0];
    value = (localHostname(candidateHost) ? 'http://' : 'https://') + value.replace(/^\/+/, '');
  }
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s.exec(value);
  if (!match) throw new StateError('网址格式不正确');
  const [, rawScheme, authority, path, query = '', fragment = ''] = match;
  const scheme = rawScheme.toLowerCase();
  // server.py reports credentials with the generic message too (its APIError is a ValueError).
  if (authority.includes('@')) throw new StateError('网址格式不正确');
  if (scheme !== 'http' && scheme !== 'https') throw new StateError('网址格式不正确');
  let hostPart = authority;
  let port = '';
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) throw new StateError('网址格式不正确');
    hostPart = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    if (rest && !rest.startsWith(':')) throw new StateError('网址格式不正确');
    port = rest.slice(1);
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon >= 0) {
      hostPart = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    }
    if (hostPart.includes(':')) throw new StateError('网址格式不正确');
  }
  if (port && (!/^\d+$/.test(port) || Number(port) > 65535)) throw new StateError('网址格式不正确');
  if (!hostPart) throw new StateError('网址格式不正确');
  let host;
  try { host = new URL(scheme + '://' + hostPart + '/').hostname; }
  catch { throw new StateError('网址格式不正确'); }
  if (!host) throw new StateError('网址格式不正确');
  // urlsplit keeps an explicit port, the default one included; port 0 is dropped.
  const portText = port && Number(port) ? ':' + Number(port) : '';
  return scheme + '://' + host + portText + path + (query ? '?' + query : '') + (fragment ? '#' + fragment : '');
}

function textField(value, label, maximum, fallback = '') {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > maximum) throw new StateError(label + '格式不正确');
  return value.trim();
}

function switchField(value, label) {
  if (typeof value !== 'boolean') throw new StateError(label + '必须是开或关');
  return value;
}

function integer(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw new StateError(label + '超出范围');
  return value;
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const has = (item, key) => Object.prototype.hasOwnProperty.call(item, key);
const pick = (item, key, fallback) => has(item, key) ? item[key] : fallback;

export function validateState(value) {
  if (!isObject(value)) throw new StateError('配置必须是 JSON 对象');
  const categories = pick(value, 'categories', []);
  const links = pick(value, 'links', []);
  if (!Array.isArray(categories) || !Array.isArray(links)) throw new StateError('分类和网址必须是列表');
  if (categories.length > 200 || links.length > 5000) throw new StateError('分类或网址数量过多');
  const cleanedCategories = [];
  const categoryIds = new Set();
  categories.forEach((item, index) => {
    if (!isObject(item)) throw new StateError('分类格式不正确');
    const id = textField(item.id, '分类 ID', 100);
    const name = textField(item.name, '分类名称', 80);
    if (!id || !name || categoryIds.has(id)) throw new StateError('分类名称和 ID 不能为空，ID 不能重复');
    categoryIds.add(id);
    const cleaned = {
      id, name,
      icon: textField(item.icon, '分类图标', 100, 'folder'),
      column: integer(pick(item, 'column', index % 3), '分类所在列', 0, 2),
      order: integer(pick(item, 'order', index), '分类顺序', 0, 100000),
    };
    const area = pick(item, 'area', 'directory');
    if (area !== 'directory' && area !== 'archive') throw new StateError('分类位置不正确');
    if (area === 'archive') cleaned.area = 'archive';
    cleanedCategories.push(cleaned);
  });
  const cleanedLinks = [];
  const linkIds = new Set();
  const urls = new Set();
  links.forEach((item, index) => {
    if (!isObject(item)) throw new StateError('网址格式不正确');
    const id = textField(item.id, '网址 ID', 100);
    const name = textField(item.name, '网址名称', 120);
    const url = normalizeUrl(item.url);
    if (!id || !name || linkIds.has(id)) throw new StateError('网址名称和 ID 不能为空，ID 不能重复');
    const canonical = url.replace(/\/+$/, '');
    if (urls.has(canonical)) throw new StateError('该网址已存在，请编辑已有入口');
    linkIds.add(id);
    urls.add(canonical);
    const kind = pick(item, 'kind', 'website');
    if (kind !== 'website' && kind !== 'service') throw new StateError('入口类型不正确');
    const categoryId = item.categoryId || null;
    if (categoryId !== null && !categoryIds.has(categoryId)) throw new StateError('网址所属分类不存在');
    if (kind === 'website' && categoryId === null) throw new StateError('请为网址选择分类');
    let icon = textField(item.icon, '图标', 4096);
    if (icon.startsWith('http:') || icon.startsWith('https:')) icon = normalizeUrl(icon);
    else if (icon && !/^[a-zA-Z0-9_/-]+(?:\.svg|\.png|\.ico|\.webp)?$/.test(icon)) throw new StateError('图标格式不正确');
    const order = integer(pick(item, 'order', index), '网址顺序', 0, 100000);
    const cleaned = {
      id, name, url, icon, kind, categoryId,
      pinned: Boolean(pick(item, 'pinned', false)),
      order,
      pinnedOrder: integer(pick(item, 'pinnedOrder', pick(item, 'order', index)), '常用顺序', 0, 100000),
      monitorEnabled: kind === 'service' && Boolean(pick(item, 'monitorEnabled', false)),
    };
    if (item.iconManual === true) cleaned.iconManual = true;
    if (item.checkUrl) cleaned.checkUrl = normalizeUrl(item.checkUrl);
    for (const [field, label, maximum] of [['description', '入口说明', 500], ['server', '服务器名称', 100], ['container', '容器名称', 100], ['serviceGroup', '服务分组', 80]]) {
      if (has(item, field)) cleaned[field] = textField(item[field], label, maximum);
    }
    cleanedLinks.push(cleaned);
  });
  const supplied = pick(value, 'settings', {});
  if (!isObject(supplied)) throw new StateError('检测设置格式不正确');
  const settings = {
    checkInterval: integer(pick(supplied, 'checkInterval', 60), '检测间隔', 10, 86400),
    failureThreshold: integer(pick(supplied, 'failureThreshold', 3), '连续失败次数', 1, 10),
    timeout: integer(pick(supplied, 'timeout', 5), '检测超时', 1, 30),
    openInNewTab: switchField(pick(supplied, 'openInNewTab', true), '在新标签页打开网站'),
    showCompanionButton: switchField(pick(supplied, 'showCompanionButton', true), '显示角色按钮'),
    // 最近使用 on the home page, and 常用 ordered by how often each is opened.
    showRecent: switchField(pick(supplied, 'showRecent', true), '显示最近使用'),
    sortFavoritesByUse: switchField(pick(supplied, 'sortFavoritesByUse', false), '常用按使用频率排序'),
  };
  const cleaned = { categories: cleanedCategories, links: cleanedLinks, settings };
  // Companion preferences, which server.py keeps for the extension's 云同步.
  const prefs = value.prefs;
  if (prefs !== null && prefs !== undefined) {
    if (!isObject(prefs) || JSON.stringify(prefs).length > 65536) throw new StateError('角色偏好格式不正确');
    cleaned.prefs = prefs;
  }
  if (value.trash !== null && value.trash !== undefined) {
    const entries = cleanTrash(value.trash, new Set(cleanedLinks.map((link) => link.id)));
    if (entries.length) cleaned.trash = entries;
  }
  return cleaned;
}

const newestFirst = (a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0);

// 回收站 entries, newest first. Each keeps a deleted site as it was, and its
// category for restoring; it is checked again when restored.
export function cleanTrash(trash, linkIds) {
  if (!Array.isArray(trash)) throw new StateError('回收站格式不正确');
  const entries = [];
  const seen = new Set();
  for (const entry of trash) {
    if (!isObject(entry)) throw new StateError('回收站格式不正确');
    const id = textField(entry.id, '回收站条目', 100);
    const deletedAt = textField(entry.deletedAt, '删除时间', 40);
    const { link, category } = entry;
    if (!id || !deletedAt || !isObject(link) || link.id !== id || typeof link.name !== 'string' || typeof link.url !== 'string' ||
      (category !== null && category !== undefined && !isObject(category)) || JSON.stringify(entry).length > 8192) {
      throw new StateError('回收站格式不正确');
    }
    // A site back in the list (restored, or kept by a sync merge) is no longer deleted.
    if (linkIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, deletedAt, link, ...(category !== null && category !== undefined ? { category } : {}) });
  }
  return entries.sort(newestFirst).slice(0, TRASH_LIMIT);
}

// Puts the sites a save removes into 回收站 (whatever removed them: a page, a
// sync, a restore) and lets entries older than TRASH_DAYS go. A save that
// leaves trash out keeps the one there is; undoing an import records nothing.
export function withTrash(previous, cleaned, { keepPrevious, recordRemoved, now = new Date() }) {
  const trash = [...(cleaned.trash || (keepPrevious ? previous.trash || [] : []))];
  const known = new Set(trash.map((entry) => entry.id));
  const linkIds = new Set(cleaned.links.map((link) => link.id));
  if (recordRemoved) {
    const categories = new Map(previous.categories.map((item) => [item.id, item]));
    const stamp = now.toISOString();
    for (const link of previous.links) {
      if (linkIds.has(link.id) || known.has(link.id)) continue;
      const entry = { id: link.id, deletedAt: stamp, link };
      const category = categories.get(link.categoryId);
      if (category) entry.category = Object.fromEntries(['id', 'name', 'icon', 'column', 'area'].filter((key) => key in category).map((key) => [key, category[key]]));
      trash.push(entry);
    }
  }
  const cutoff = new Date(now.getTime() - TRASH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const kept = trash.filter((entry) => !linkIds.has(entry.id) && entry.deletedAt >= cutoff).sort(newestFirst).slice(0, TRASH_LIMIT);
  const result = { ...cleaned };
  if (kept.length) result.trash = kept;
  else delete result.trash;
  return result;
}

// What server.py's metadata(remote=False) answers: the built-in site table
// and whether the host is on the LAN. knownSites is public/known-sites.json.
export function siteMetadata(url, categories, knownSites) {
  url = normalizeUrl(url);
  const hostname = new URL(url).hostname;
  const matchHost = hostname.replace(/^www\./, '');
  const known = knownSites.sites[matchHost];
  const kind = localHostname(hostname) ? 'service' : 'website';
  const categoryName = known ? known[2] : '';
  const names = known ? (knownSites.categoryAliases[categoryName] || [categoryName]) : [];
  const directory = categories.filter((item) => (item.area || 'directory') !== 'archive');
  let categoryId = null;
  for (const name of names) {
    const found = directory.find((item) => item.name === name);
    if (found) { categoryId = found.id; break; }
  }
  return { url, name: known ? known[0] : matchHost, icon: known ? known[1] : '', categoryId, kind };
}
