import { icon, brandIcon } from './icons.js';
import { initCompanion } from './companion.js';
import { toolsMarkup, mountTools, resolveTool } from './tools.js';
import { searchLinks, googleSearchUrl } from './search.js';
import { parseBookmarks } from './bookmarks.js';

initCompanion();

const app = document.querySelector('#app');
const modalRoot = document.querySelector('#modal-root');
const toastRoot = document.querySelector('#toast-root');
toastRoot.classList.add('toast-root');
let config;
let health = { services: {} };
let view = 'home';
let editMode = false;
let activeCategory = '';
let activeTool = '';
let currentDialog = null;
let mutationQueue = Promise.resolve();
let dragged = null;
let checkTimer = null;
let searchQuery = '';
let searchIndex = 0;
let searchResults = [];
let linkCheck = { job: null, results: {} };
let linkCheckTimer = null;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => globalThis.crypto?.randomUUID?.() || 'item-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
const ordered = (items) => [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const directoryCategories = () => [0, 1, 2].flatMap((column) => ordered(config.categories).filter((category) => Number(category.column) === column));
const favorites = () => config.links.filter((link) => link.pinned).sort((a, b) => (a.pinnedOrder ?? a.order) - (b.pinnedOrder ?? b.order));
const domain = (url) => { try { const parsed = new URL(url); return parsed.host.replace(/^www\./, ''); } catch { return url; } };
const safeUrl = (input) => {
  const raw = String(input).trim();
  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : (inferService('http://' + raw) ? 'http://' : 'https://') + raw);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) throw new Error('请填写有效的 HTTP 或 HTTPS 网址');
  return parsed.href;
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || body.message || '请求失败，请稍后重试');
    error.status = response.status;
    throw error;
  }
  return body;
}

function toast(message, action) {
  const element = document.createElement('div');
  element.className = 'toast';
  element.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = message;
  element.append(text);
  if (action) {
    const button = document.createElement('button');
    button.className = 'btn btn-ghost';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      element.remove();
      Promise.resolve(action.run()).catch((error) => toast(error.message));
    });
    element.append(button);
  }
  toastRoot.append(element);
  setTimeout(() => element.remove(), action ? 10000 : 4200);
}

function mutate(change, { renderPage = true } = {}) {
  const perform = async () => {
    let draft = structuredClone(config);
    change(draft);
    try {
      config = await api('/api/state', { method: 'PUT', body: JSON.stringify(draft) });
    } catch (error) {
      if (error.status !== 409) throw error;
      config = await api('/api/state');
      draft = structuredClone(config);
      change(draft);
      config = await api('/api/state', { method: 'PUT', body: JSON.stringify(draft) });
    }
    if (renderPage) render();
    return config;
  };
  mutationQueue = mutationQueue.catch(() => {}).then(perform);
  return mutationQueue;
}

function offlineServices() {
  return config.links.filter((link) => link.kind === 'service' && link.monitorEnabled && health.services?.[link.id]?.status === 'offline');
}

function alertMarkup() {
  const count = offlineServices().length;
  return count ? '<a href="#services" class="alert-pill" aria-label="' + count + ' 项服务异常，查看详情">' + icon('alert', 17) + '<span>' + count + ' 项服务异常</span>' + icon('chevron-right', 14) + '</a>' : '';
}

function sidebarMarkup() {
  const categories = directoryCategories();
  return [
    '<aside class="sidebar"><a href="#home" class="brand" aria-label="轻航首页"><span class="brand-mark">' + icon('sparkles', 32) + '</span><span class="brand-name">轻航</span></a>',
    '<nav class="sidebar-nav" aria-label="页面目录"><a href="#home" class="nav-item ' + (view === 'home' && !activeCategory ? 'active' : '') + '">' + icon('home') + '<span>常用</span></a>',
    '<div class="nav-section-label">网址目录</div>',
    categories.map((category) => '<a href="#category-' + encodeURIComponent(category.id) + '" draggable="true" data-drag-kind="category" data-resource="' + esc(category.id) + '" title="拖动调整分类顺序" class="nav-item ' + (view === 'home' && activeCategory === category.id ? 'active' : '') + '">' + icon(category.icon || 'folder') + '<span>' + esc(category.name) + '</span></a>').join(''),
    '<div class="nav-divider"></div><a href="#services" class="nav-item ' + (view === 'services' ? 'active' : '') + '">' + icon('server') + '<span>我的服务</span></a>',
    '<a href="#tools" class="nav-item ' + (view === 'tools' ? 'active' : '') + '">' + icon('toolbox') + '<span>工具箱</span></a></nav>',
    '<div class="sidebar-bottom"><a href="#settings" class="nav-item ' + (view === 'settings' ? 'active' : '') + '">' + icon('settings') + '<span>设置</span></a></div></aside>',
  ].join('');
}

function itemActions(link, scope) {
  return '<div class="item-actions"><button class="icon-button" data-action="edit-link" data-id="' + esc(link.id) + '" aria-label="编辑 ' + esc(link.name) + '" title="编辑">' + icon('edit', 14) + '</button>' +
    (scope === 'favorites'
      ? '<button class="icon-button" data-action="unpin" data-id="' + esc(link.id) + '" aria-label="取消常用 ' + esc(link.name) + '" title="取消常用">' + icon('x', 14) + '</button>'
      : '<button class="icon-button danger" data-action="delete-link" data-id="' + esc(link.id) + '" aria-label="删除 ' + esc(link.name) + '" title="删除">' + icon('trash', 14) + '</button>') + '</div>';
}

const brokenCheck = (link) => {
  const result = linkCheck.results?.[link.id];
  return link.kind === 'website' && result?.status === 'broken' && result.url === link.url ? result : null;
};
const brokenFlag = (link) => {
  const result = brokenCheck(link);
  return result ? '<span class="link-flag" title="' + esc('上次体检：' + result.message) + '" aria-label="' + esc('上次体检疑似失效：' + result.message) + '"></span>' : '';
};

function shortcutMarkup(link) {
  const content = brokenFlag(link) + brandIcon(link.icon, link.name) + '<span class="shortcut-name">' + esc(link.name).replace(/([a-z])([A-Z])/g, '$1<wbr>$2') + '</span>';
  if (editMode) return '<div class="shortcut editable-item" draggable="true" data-drag-kind="link" data-resource="' + esc(link.id) + '" data-scope="favorites" tabindex="0" aria-label="' + esc(link.name) + '，可拖动排序；按回车编辑">' + content + itemActions(link, 'favorites') + '</div>';
  return '<a class="shortcut" href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer" aria-label="打开 ' + esc(link.name) + '" title="' + esc(link.name) + '\n' + esc(link.url) + '">' + content + '</a>';
}

function siteMarkup(link, categoryId) {
  const content = brokenFlag(link) + brandIcon(link.icon, link.name) + '<span class="site-copy"><span class="site-name">' + esc(link.name) + '</span><span class="site-domain">' + esc(domain(link.url)) + '</span></span>';
  if (editMode) return '<div class="site-link editable-item" draggable="true" data-drag-kind="link" data-resource="' + esc(link.id) + '" data-scope="category-' + esc(categoryId) + '" tabindex="0" aria-label="' + esc(link.name) + '，可拖动排序或拖到其他分类；按回车编辑">' + content + itemActions(link, 'category') + '</div>';
  return '<a class="site-link" href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(link.name) + '\n' + esc(link.url) + '">' + content + '<span class="link-arrow">' + icon('arrow-up-right', 13) + '</span></a>';
}

function categoryMarkup(category) {
  const links = ordered(config.links.filter((link) => link.kind === 'website' && link.categoryId === category.id));
  const sortable = editMode ? ' draggable="true" data-drag-kind="category" data-resource="' + esc(category.id) + '" data-link-drop="category-' + esc(category.id) + '"' : '';
  return '<section class="category-card" id="category-' + esc(category.id) + '" aria-labelledby="title-' + esc(category.id) + '"' + sortable + '>' +
    '<header class="category-header"' + (editMode ? ' title="拖动标题栏调整分类顺序，可拖到其他列"' : '') + '><div class="category-title">' + (editMode ? '<span class="drag-handle" aria-hidden="true">' + icon('grip', 16) + '</span>' : '') + icon(category.icon || 'folder', 21) + '<h3 id="title-' + esc(category.id) + '">' + esc(category.name) + '</h3></div>' +
    (editMode ? '<button class="icon-button" data-action="add-link" data-category="' + esc(category.id) + '" aria-label="添加到 ' + esc(category.name) + '">' + icon('plus', 17) + '</button>' : '<span class="category-count" aria-label="' + links.length + ' 个网址">' + links.length + '</span>') + '</header>' +
    '<div class="link-grid" data-sort-scope="category-' + esc(category.id) + '">' + (links.map((link) => siteMarkup(link, category.id)).join('') || '<div class="empty-category">还没有网址<button class="btn btn-ghost" data-action="add-link" data-category="' + esc(category.id) + '">添加一个</button></div>') + '</div></section>';
}

function homeMarkup() {
  const pinned = favorites();
  const categories = ordered(config.categories);
  return '<section class="favorites-section" id="favorites"><div class="section-heading">' + icon('sparkles', 24) + '<h2>常用</h2>' +
    (editMode ? '<span class="section-note">拖动调整顺序，网址可拖到其他分类，分类可拖动标题栏换位置</span>' : '') + '</div>' +
    '<div class="favorites-grid" data-sort-scope="favorites" data-link-drop="favorites">' + (pinned.map(shortcutMarkup).join('') || '<div class="empty-state">' + icon('star', 25) + '<p>把常用的网址或服务放在这里</p><button class="btn btn-secondary" data-action="add-link" data-pinned="true">添加常用</button></div>') + '</div></section>' +
    '<section class="directory-section"><div class="section-heading">' + icon('link', 23) + '<h2>网址导航</h2></div><div class="directory-columns">' +
    [0, 1, 2].map((column) => '<div class="directory-column" data-column="' + column + '">' + categories.filter((category) => Number(category.column) === column).map(categoryMarkup).join('') + '</div>').join('') + '</div></section>';
}

const statusLabels = { disabled: '未启用', unknown: '待检测', checking: '检测中', online: '在线', degraded: '待确认', offline: '离线' };
function serviceState(link) {
  if (!link.monitorEnabled) return { status: 'disabled', message: '尚未启用掉线检测' };
  return health.services?.[link.id] || { status: 'unknown', message: '等待首次检测' };
}

function serviceMarkup(link) {
  const state = serviceState(link);
  const status = statusLabels[state.status] ? state.status : 'unknown';
  const latency = state.latencyMs == null ? '—' : Math.round(state.latencyMs) + ' ms';
  let detail = state.message || '等待首次检测';
  if (status === 'online') detail = '响应 ' + latency;
  if (status === 'offline' || status === 'degraded') detail = '连续 ' + (state.consecutiveFailures || 1) + ' 次未响应' + (status === 'degraded' ? '，正在确认' : '');
  const lastChecked = state.lastChecked ? new Date(typeof state.lastChecked === 'number' && state.lastChecked < 1e12 ? state.lastChecked * 1000 : state.lastChecked).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '尚未检测';
  return '<article class="service-card ' + (status === 'offline' ? 'has-error' : '') + (editMode ? ' is-sortable' : '') + '" data-service="' + esc(link.id) + '"' + (editMode ? ' draggable="true" data-drag-kind="service" data-resource="' + esc(link.id) + '"' : '') + '><header class="service-card-header">' +
    '<a class="service-identity"' + (editMode ? ' draggable="false"' : '') + ' href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer">' + brandIcon(link.icon, link.name) + '<span class="service-copy"><h3>' + esc(link.name) + '</h3><span class="site-domain">' + esc(domain(link.url)) + '</span></span></a>' +
    '<span class="status-badge ' + status + '">' + statusLabels[status] + '</span></header>' +
    (link.description ? '<p class="service-description">' + esc(link.description) + '</p>' : '') +
    '<div class="service-details"><p>' + esc(detail) + '</p><div class="service-meta">最近检测：' + esc(lastChecked) + '</div>' +
    (link.container ? '<div class="service-meta container-meta" title="' + esc((link.server ? link.server + ' / ' : '') + link.container) + '"><span>容器</span><span>' + esc((link.server ? link.server + ' / ' : '') + link.container) + '</span></div>' : '') +
    '</div>' +
    '<div class="service-actions"><button class="btn btn-ghost" data-action="edit-link" data-id="' + esc(link.id) + '">' + icon('settings', 15) + '配置</button>' +
    (link.monitorEnabled ? '<button class="btn btn-secondary" data-action="check-service" data-id="' + esc(link.id) + '">' + icon('refresh', 15) + '检测</button>' : '<button class="btn btn-secondary" data-action="enable-monitor" data-id="' + esc(link.id) + '">' + icon('play', 14) + '启用监控</button>') +
    '<button class="icon-button danger" data-action="delete-link" data-id="' + esc(link.id) + '" aria-label="删除服务 ' + esc(link.name) + '" title="删除服务">' + icon('trash', 15) + '</button></div></article>';
}

function servicesMarkup() {
  const services = ordered(config.links.filter((link) => link.kind === 'service'));
  const monitored = services.filter((link) => link.monitorEnabled).length;
  return '<div class="page-intro"><p>' + (monitored ? '后台每 ' + config.settings.checkInterval + ' 秒检测一次；连续 ' + config.settings.failureThreshold + ' 次异常后提醒。' : '先将示例地址改为你的服务地址，再开启掉线检测。') + '</p></div>' +
    '<div class="service-toolbar"><span class="section-hint">' + (editMode ? '拖动卡片调整服务顺序' : services.length + ' 个服务 · ' + monitored + ' 个已开启监控') + '</span><button class="btn btn-secondary" data-action="check-all" ' + (!monitored ? 'disabled' : '') + '>' + icon('refresh', 16) + '立即检测</button></div>' +
    '<div class="service-grid">' + (services.map(serviceMarkup).join('') || '<div class="empty-state">' + icon('server', 30) + '<h2>添加你的第一个服务</h2><p>NAS、影音库或智能家居，都可以放在这里。</p><button class="btn btn-primary" data-action="add-service">添加服务</button></div>') + '</div>';
}

function settingsMarkup() {
  const categories = directoryCategories();
  return '<section class="settings-section"><div class="section-heading">' + icon('settings', 22) + '<h2>检测设置</h2></div><form class="settings-card settings-form" id="settings-form"><div class="field-row">' +
    '<label class="field"><span class="field-label">检测间隔（秒）</span><input class="form-input" type="number" name="checkInterval" min="10" max="86400" value="' + esc(config.settings.checkInterval) + '" required></label>' +
    '<label class="field"><span class="field-label">连续异常次数</span><input class="form-input" type="number" name="failureThreshold" min="1" max="10" value="' + esc(config.settings.failureThreshold) + '" required></label>' +
    '<label class="field"><span class="field-label">请求超时（秒）</span><input class="form-input" type="number" name="timeout" min="1" max="30" value="' + esc(config.settings.timeout) + '" required></label></div>' +
    '<p class="field-hint">后台会持续检测已开启监控的服务，关闭页面后也会继续。</p><div class="settings-actions"><button class="btn btn-primary" type="submit">保存设置</button></div></form></section>' +
    '<section class="settings-section"><div class="section-heading">' + icon('folder', 22) + '<h2>网址分类</h2><button class="btn btn-secondary" data-action="add-category">' + icon('plus', 16) + '新建分类</button></div><div class="settings-card category-settings-list"><p class="settings-description">拖动左侧把手调整分类顺序，首页和侧边栏会同步更新。</p>' +
    categories.map((category) => '<div class="category-settings-row" draggable="true" data-drag-kind="category" data-resource="' + esc(category.id) + '"><span class="drag-handle" title="拖动调整顺序" aria-hidden="true">' + icon('grip', 16) + '</span><span class="category-settings-name">' + icon(category.icon, 19) + '<span>' + esc(category.name) + '</span></span><span class="category-settings-count">' + config.links.filter((link) => link.kind === 'website' && link.categoryId === category.id).length + ' 个网址</span>' +
      '<label class="column-picker"><span class="sr-only">' + esc(category.name) + '所在列</span><select class="form-select" data-category-column="' + esc(category.id) + '">' + [0, 1, 2].map((n) => '<option value="' + n + '" ' + (Number(category.column) === n ? 'selected' : '') + '>第 ' + (n + 1) + ' 列</option>').join('') + '</select></label>' +
      '<button class="icon-button" data-action="edit-category" data-id="' + esc(category.id) + '" aria-label="编辑分类 ' + esc(category.name) + '">' + icon('edit', 16) + '</button><button class="icon-button danger" data-action="delete-category" data-id="' + esc(category.id) + '" aria-label="删除分类 ' + esc(category.name) + '">' + icon('trash', 16) + '</button></div>').join('') + '</div></section>' +
    '<section class="settings-section" id="link-check"><div class="section-heading">' + icon('check-circle', 22) + '<h2>网址体检</h2></div><div class="settings-card" id="link-check-card">' + linkCheckMarkup() + '</div></section>' +
    '<section class="settings-section"><div class="section-heading">' + icon('download', 22) + '<h2>数据备份</h2></div><div class="settings-card"><p class="settings-description">导出网址、分类与服务配置，方便备份或迁移。</p><div class="settings-actions"><button class="btn btn-secondary" data-action="export">' + icon('upload', 16) + '导出备份</button><button class="btn btn-secondary" data-action="import">' + icon('download', 16) + '导入备份</button></div></div></section>' +
    '<section class="settings-section"><div class="section-heading">' + icon('bookmark', 22) + '<h2>导入浏览器书签</h2></div><div class="settings-card"><p class="settings-description">在 Chrome、Edge、Firefox 或 Safari 中把书签导出为 HTML 文件，再在这里导入。每个顶层文件夹会成为一个分类，已添加过的网址会自动跳过，导入前可以先预览。</p><div class="settings-actions"><button class="btn btn-secondary" data-action="import-bookmarks">' + icon('bookmark', 16) + '选择书签文件</button></div></div></section>';
}

function searchMarkup() {
  return '<div class="quick-search" id="quick-search">' + icon('search', 17) +
    '<input id="quick-search-input" class="quick-search-input" type="search" role="combobox" aria-label="搜索网址和服务" aria-autocomplete="list" aria-expanded="false" aria-controls="quick-search-results" autocomplete="off" spellcheck="false" enterkeyhint="go" placeholder="搜索网址和服务，回车打开" value="' + esc(searchQuery) + '">' +
    '<kbd class="quick-search-key" aria-hidden="true" title="按 / 或 Ctrl + K 开始搜索">/</kbd>' +
    '<div class="quick-search-results" id="quick-search-results" role="listbox" aria-label="搜索结果" hidden></div></div>';
}

function searchOptionMarkup(entry, index) {
  const selected = index === searchIndex;
  const attributes = ' id="quick-search-option-' + index + '" role="option" aria-selected="' + selected + '" class="quick-search-option' + (selected ? ' is-selected' : '') + '" data-search-index="' + index + '" href="' + esc(entry.url) + '" target="_blank" rel="noopener noreferrer" tabindex="-1"';
  if (entry.google) return '<a' + attributes + '><span class="quick-search-google">' + icon('search', 16) + '</span><span class="quick-search-copy"><span class="quick-search-name">用 Google 搜索“' + esc(searchQuery.trim()) + '”</span><span class="quick-search-meta">google.com</span></span></a>';
  const link = entry.link;
  const place = link.kind === 'service' ? '服务' : config.categories.find((category) => category.id === link.categoryId)?.name || '';
  return '<a' + attributes + '>' + brandIcon(link.icon, link.name) + '<span class="quick-search-copy"><span class="quick-search-name">' + esc(link.name) + '</span><span class="quick-search-meta">' + esc(domain(link.url)) + '</span></span>' +
    (link.pinned ? '<span class="quick-search-tag">常用</span>' : '') + (place ? '<span class="quick-search-tag">' + esc(place) + '</span>' : '') + '</a>';
}

function updateSearchResults() {
  const input = document.querySelector('#quick-search-input');
  const panel = document.querySelector('#quick-search-results');
  if (!input || !panel) return;
  const query = searchQuery.trim();
  searchResults = query ? [...searchLinks(query, config.links).map((link) => ({ link, url: link.url })), { google: true, url: googleSearchUrl(query) }] : [];
  searchIndex = Math.min(Math.max(0, searchIndex), Math.max(0, searchResults.length - 1));
  const open = Boolean(query) && document.activeElement === input;
  panel.hidden = !open;
  input.setAttribute('aria-expanded', String(open));
  if (!open) { input.removeAttribute('aria-activedescendant'); return; }
  panel.innerHTML = searchResults.map(searchOptionMarkup).join('');
  input.setAttribute('aria-activedescendant', 'quick-search-option-' + searchIndex);
  panel.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
}

function resetSearch() {
  searchQuery = '';
  searchIndex = 0;
  const input = document.querySelector('#quick-search-input');
  if (input) { input.value = ''; input.blur(); }
  updateSearchResults();
}

function openSearchResult(index, newTab = true) {
  const entry = searchResults[index];
  if (entry && newTab) window.open(entry.url, '_blank', 'noopener,noreferrer');
  else if (newTab) return;
  resetSearch();
}

const LINK_CHECK_GROUPS = [
  { status: 'broken', title: '疑似失效', note: '域名已无法解析，或页面已不存在。', bulk: 'delete-broken', bulkLabel: '全部删除' },
  { status: 'redirected', title: '已跳转到其他网站', note: '网站可能已经换了地址，可以把入口更新为新地址。', bulk: 'apply-all-redirects', bulkLabel: '全部更新为新地址' },
  { status: 'unreachable', title: '暂时无法访问', note: '可能是网站临时故障，也可能是运行轻航的服务器无法访问它（例如需要代理）。请先在浏览器中打开确认。' },
];

const shortTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

function currentLinkChecks() {
  const checks = [];
  for (const link of config.links) {
    const result = linkCheck.results?.[link.id];
    if (link.kind === 'website' && result && result.url === link.url) checks.push({ link, result });
  }
  return checks;
}

function linkCheckRowMarkup({ link, result }) {
  const category = config.categories.find((item) => item.id === link.categoryId)?.name || '';
  return '<div class="link-check-row">' + brandIcon(link.icon, link.name) +
    '<span class="link-check-copy"><span class="link-check-name">' + esc(link.name) + (category ? '<span class="link-check-category">' + esc(category) + '</span>' : '') + '</span>' +
    '<span class="link-check-reason" title="' + esc(link.url) + '">' + esc(domain(link.url)) + ' · ' + esc(result.message || '') + (result.status === 'redirected' && result.finalUrl ? ' → <span class="link-check-target">' + esc(result.finalUrl) + '</span>' : '') + '</span></span>' +
    '<span class="link-check-actions"><a class="icon-button" href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer" title="在浏览器中打开" aria-label="打开 ' + esc(link.name) + '">' + icon('external-link', 15) + '</a>' +
    (result.status === 'redirected' ? '<button class="btn btn-secondary btn-small" data-action="apply-redirect" data-id="' + esc(link.id) + '">更新地址</button>' : '') +
    '<button class="icon-button" data-action="edit-link" data-id="' + esc(link.id) + '" title="编辑" aria-label="编辑 ' + esc(link.name) + '">' + icon('edit', 15) + '</button>' +
    '<button class="icon-button danger" data-action="delete-link" data-id="' + esc(link.id) + '" title="删除" aria-label="删除 ' + esc(link.name) + '">' + icon('trash', 15) + '</button></span></div>';
}

function linkCheckMarkup() {
  const job = linkCheck.job;
  const total = config.links.filter((link) => link.kind === 'website').length;
  const running = Boolean(job?.running);
  const button = '<button class="btn btn-primary" data-action="start-link-check" ' + (running || !total ? 'disabled' : '') + '>' + icon('refresh', 16) + (running ? '检测中…' : '检测全部网址') + '</button>';
  const intro = '<p class="settings-description">检查目录里的网址是否还能打开。检测从运行轻航的服务器发出，一般需要几十秒；离开本页也会继续。</p>';
  if (running) {
    const percent = job.total ? Math.round((job.done / job.total) * 100) : 0;
    return '<div class="link-check-head">' + intro + button + '</div><div class="link-check-progress" role="progressbar" aria-valuemin="0" aria-valuemax="' + job.total + '" aria-valuenow="' + job.done + '" aria-label="检测进度"><span style="width:' + percent + '%"></span></div><p class="field-hint">正在检测 ' + job.done + ' / ' + job.total + '</p>';
  }
  const checks = currentLinkChecks();
  if (!checks.length) return '<div class="link-check-head">' + intro + button + '</div>';
  const count = (status) => checks.filter((entry) => entry.result.status === status).length;
  const checkedAt = checks.map((entry) => entry.result.checkedAt).filter(Boolean).sort().pop();
  const problems = LINK_CHECK_GROUPS.reduce((sum, group) => sum + count(group.status), 0);
  const summary = '<p class="link-check-summary">' + (checkedAt ? '上次检测于 ' + esc(shortTime(checkedAt)) + '，' : '') + '已检测 ' + checks.length + ' 个网址：' +
    '<span class="ok">' + count('ok') + ' 个正常</span>' + (count('restricted') ? '，' + count('restricted') + ' 个拒绝自动访问（不算问题）' : '') +
    (problems ? '，<strong>' + problems + ' 个需要处理</strong>' : '，没有发现问题') + '。</p>';
  const groups = LINK_CHECK_GROUPS.map((group) => {
    const entries = checks.filter((entry) => entry.result.status === group.status);
    if (!entries.length) return '';
    return '<div class="link-check-group is-' + group.status + '"><header class="link-check-group-head"><div><h3>' + group.title + '<span>' + entries.length + '</span></h3><p>' + group.note + '</p></div>' +
      (group.bulk ? '<button class="btn btn-secondary btn-small' + (group.status === 'broken' ? ' btn-danger' : '') + '" data-action="' + group.bulk + '">' + group.bulkLabel + '</button>' : '') + '</header>' +
      entries.map(linkCheckRowMarkup).join('') + '</div>';
  }).join('');
  return '<div class="link-check-head">' + intro + button + '</div>' + summary + groups;
}

function updateLinkCheckCard() {
  const card = document.querySelector('#link-check-card');
  if (card) card.innerHTML = linkCheckMarkup();
}

async function refreshLinkCheck() {
  const wasRunning = Boolean(linkCheck.job?.running);
  linkCheck = await api('/api/link-check');
  clearTimeout(linkCheckTimer);
  if (linkCheck.job?.running) {
    updateLinkCheckCard();
    linkCheckTimer = setTimeout(() => refreshLinkCheck().catch(() => {}), 1000);
  } else if (wasRunning) {
    const problems = currentLinkChecks().filter((entry) => ['broken', 'redirected', 'unreachable'].includes(entry.result.status)).length;
    toast(problems ? '网址体检完成，发现 ' + problems + ' 个需要处理' : '网址体检完成，没有发现问题', view === 'settings' ? null : { label: '查看', run: () => { location.hash = '#settings'; requestAnimationFrame(() => document.querySelector('#link-check')?.scrollIntoView({ behavior: 'smooth', block: 'start' })); } });
    if (!currentDialog) render();
  }
}

async function startLinkCheck() {
  linkCheck = await api('/api/link-check', { method: 'POST', body: JSON.stringify({}) });
  updateLinkCheckCard();
  clearTimeout(linkCheckTimer);
  linkCheckTimer = setTimeout(() => refreshLinkCheck().catch(() => {}), 800);
}

function sameUrlTaken(state, link, url) {
  const key = url.replace(/\/$/, '');
  return state.links.find((item) => item.id !== link.id && (() => { try { return safeUrl(item.url).replace(/\/$/, '') === key; } catch { return false; } })());
}

async function applyRedirects(ids) {
  const targets = ids.map((id) => ({ id, result: linkCheck.results[id] })).filter((entry) => entry.result?.finalUrl);
  const previous = new Map();
  const conflicts = [];
  await mutate((state) => {
    previous.clear();
    conflicts.length = 0;
    for (const { id, result } of targets) {
      const link = state.links.find((item) => item.id === id);
      if (!link || link.url !== result.url) continue;
      let url;
      try { url = safeUrl(result.finalUrl); } catch { continue; }
      const taken = sameUrlTaken(state, link, url);
      if (taken) { conflicts.push(taken.name); continue; }
      previous.set(id, link.url);
      link.url = url;
    }
  });
  if (!previous.size) throw new Error(conflicts.length ? '新地址已经作为「' + conflicts[0] + '」添加过，可以直接删除旧入口' : '没有可更新的地址');
  toast('已更新 ' + previous.size + ' 个网址' + (conflicts.length ? '，' + conflicts.length + ' 个的新地址已存在，已跳过' : ''), {
    label: '撤销',
    run: () => mutate((state) => { for (const [id, url] of previous) { const link = state.links.find((item) => item.id === id); if (link) link.url = url; } }),
  });
}

function render() {
  if (!config) return;
  const searchInput = document.querySelector('#quick-search-input');
  const searchFocus = searchInput && document.activeElement === searchInput ? [searchInput.selectionStart, searchInput.selectionEnd] : null;
  const titles = { home: '我的导航', services: '我的服务', settings: '设置', tools: '工具箱' };
  const previousScroll = window.scrollY;
  app.innerHTML = '<div class="app-shell ' + (editMode ? 'edit-mode' : '') + '">' + sidebarMarkup() +
    '<main class="workspace"><header class="topbar"><h1 class="page-title">' + titles[view] + '</h1>' + searchMarkup() + '<div class="topbar-actions"><span id="service-alert">' + alertMarkup() + '</span>' +
    (view === 'home' || view === 'services' ? '<button class="btn ' + (editMode ? 'btn-secondary is-editing' : 'btn-secondary') + '" data-action="toggle-edit">' + (editMode ? icon('check', 16) + '完成整理' : '整理') + '</button>' : '') +
    (view === 'tools' ? '' : '<button class="btn btn-primary" data-action="' + (view === 'services' ? 'add-service' : 'add-link') + '">' + icon('plus', 18) + '添加' + (view === 'services' ? '服务' : '') + '</button>') + '</div></header>' +
    '<div class="page-content">' + (view === 'services' ? servicesMarkup() : view === 'settings' ? settingsMarkup() : view === 'tools' ? toolsMarkup(activeTool) : homeMarkup()) + '</div></main></div>';
  if (view === 'tools') mountTools(app, { toast });
  if (searchFocus) {
    const input = document.querySelector('#quick-search-input');
    input.focus({ preventScroll: true });
    input.setSelectionRange(...searchFocus);
    updateSearchResults();
  }
  document.title = titles[view] + ' · 轻航 LiteNav';
  window.scrollTo({ top: previousScroll, behavior: 'instant' });
}

function route() {
  const hash = location.hash.slice(1);
  const oldView = view;
  view = hash === 'services' ? 'services' : hash === 'settings' ? 'settings' : hash === 'tools' || hash.startsWith('tools/') ? 'tools' : 'home';
  if (view === 'tools') activeTool = resolveTool(hash.slice(6));
  try { activeCategory = hash.startsWith('category-') ? decodeURIComponent(hash.slice(9)) : ''; }
  catch { activeCategory = ''; }
  if (view !== oldView) editMode = false;
  render();
  if (activeCategory) requestAnimationFrame(() => document.getElementById('category-' + activeCategory)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  else window.scrollTo({ top: 0, behavior: 'instant' });
}

function makeDialog(markup) {
  currentDialog?.close();
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'app-dialog';
  dialog.innerHTML = markup;
  modalRoot.append(dialog);
  currentDialog = dialog;
  dialog.addEventListener('close', () => {
    dialog._abort?.abort();
    if (currentDialog === dialog) currentDialog = null;
    dialog.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  }, { once: true });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.showModal();
  return dialog;
}

function categoryOptions(selected) {
  return '<option value="" ' + (!selected ? 'selected' : '') + '>未分类</option>' + directoryCategories().map((category) => '<option value="' + esc(category.id) + '" ' + (category.id === selected ? 'selected' : '') + '>' + esc(category.name) + '</option>').join('');
}

function inferService(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host.endsWith('.home') || host.endsWith('.lan') || host.endsWith('.local') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '[::1]';
  } catch { return false; }
}

function openLinkDialog({ id, kind = 'website', categoryId = '', pinned = false } = {}) {
  const existing = config.links.find((link) => link.id === id);
  const draft = existing ? structuredClone(existing) : {
    id: uid(), name: '', url: '', icon: 'link', kind,
    categoryId: categoryId || '', pinned,
    monitorEnabled: kind === 'service', checkUrl: '', pinnedOrder: favorites().length,
    order: Math.max(-1, ...config.links.map((link) => link.order || 0)) + 1,
  };
  const locked = { name: Boolean(existing), category: Boolean(existing || categoryId), kind: Boolean(existing || kind === 'service'), monitor: Boolean(existing) };
  const categoryNames = config.categories.length ? categoryOptions(draft.categoryId) : '<option value="">未分类</option>';
  const dialog = makeDialog([
    '<form class="dialog-form" id="link-form"><header class="dialog-header"><h2>' + (existing ? '编辑入口' : '添加入口') + '</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="关闭">' + icon('x', 21) + '</button></header>',
    '<div class="dialog-body"><div class="type-switch" aria-label="入口类型"><button type="button" data-kind="website" class="' + (draft.kind === 'website' ? 'is-active' : '') + '">' + icon('link', 15) + '网址</button><button type="button" data-kind="service" class="' + (draft.kind === 'service' ? 'is-active' : '') + '">' + icon('server', 15) + '服务</button></div>',
    '<label class="field"><span class="field-label">网址</span><input id="link-url" name="url" class="form-input" inputmode="url" autocomplete="url" spellcheck="false" placeholder="粘贴网址，例如 https://github.com" value="' + esc(draft.url) + '" required autofocus></label>',
    '<div class="recognition-row"><div class="dialog-preview-icon" id="link-preview">' + brandIcon(draft.icon, draft.name) + '</div><label class="recognition-copy"><span class="sr-only">名称</span><input class="form-input recognition-name" id="link-name" name="name" placeholder="自动识别名称，也可以修改" maxlength="120" value="' + esc(draft.name) + '" required><span class="recognition-status" id="metadata-status">' + (existing ? '名称和图标均可修改' : '粘贴后自动识别名称和分类') + '</span></label></div>',
    '<label class="field" id="link-category-field"><span class="field-label">分类</span><select class="form-select" id="link-category" name="categoryId">' + categoryNames + '</select></label>',
    '<label class="checkbox-row"><input type="checkbox" id="link-pinned" name="pinned" ' + (draft.pinned ? 'checked' : '') + '>加入常用</label>',
    existing && existing.pinned ? '<label class="field"><span class="field-label">常用排序</span><input class="form-input" id="link-position" type="number" min="1" max="' + favorites().length + '" value="' + (favorites().findIndex((link) => link.id === draft.id) + 1) + '"><span class="field-hint">也可以在首页整理模式下拖动排序</span></label>' : '',
    '<div class="monitor-options" id="link-monitor-options"><label class="checkbox-row"><input type="checkbox" id="link-monitor" name="monitorEnabled" ' + (draft.monitorEnabled ? 'checked' : '') + '>启用掉线检测</label><label class="field" id="link-check-url-field"><span class="field-label">检测地址 <span class="optional">可选</span></span><input class="form-input" id="link-check-url" name="checkUrl" inputmode="url" placeholder="默认检测上方服务地址" value="' + esc(draft.checkUrl || '') + '"><span class="field-hint">检测从运行轻航的服务器发出，需要能访问该服务。</span></label></div>',
    '<div class="service-config-fields" id="link-service-fields"><label class="field"><span class="field-label">描述 <span class="optional">可选</span></span><input class="form-input" id="link-description" maxlength="500" placeholder="例如 NAS 管理、影音库" value="' + esc(draft.description || '') + '"></label><details class="service-advanced"><summary>容器备注</summary><div class="field-row"><label class="field"><span class="field-label">服务器</span><input class="form-input" id="link-server" maxlength="100" placeholder="例如 local" value="' + esc(draft.server || '') + '"></label><label class="field"><span class="field-label">容器名称</span><input class="form-input" id="link-container" maxlength="100" placeholder="例如 jellyfin" value="' + esc(draft.container || '') + '"></label></div></details></div>',
    '<p class="form-error" id="link-error" role="alert" hidden></p></div>',
    '<footer class="dialog-footer"><span class="keyboard-hint">Enter ' + (existing ? '保存' : '添加') + '</span><div><button class="btn btn-ghost" type="button" data-action="close-dialog">取消</button><button class="btn btn-primary" type="submit">' + (existing ? '保存' : '添加') + '</button></div></footer></form>',
  ].join(''));
  const form = dialog.querySelector('form');
  const urlInput = form.querySelector('#link-url');
  const nameInput = form.querySelector('#link-name');
  const categorySelect = form.querySelector('#link-category');
  const status = form.querySelector('#metadata-status');
  const monitor = form.querySelector('#link-monitor');
  let metadataTimer;
  let submitted = false;
  const updateKind = () => {
    dialog.querySelectorAll('[data-kind]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.kind === draft.kind);
      button.setAttribute('aria-pressed', String(button.dataset.kind === draft.kind));
    });
    form.querySelector('#link-category-field').hidden = draft.kind === 'service';
    form.querySelector('#link-monitor-options').hidden = draft.kind !== 'service';
    form.querySelector('#link-service-fields').hidden = draft.kind !== 'service';
    form.querySelector('#link-check-url-field').hidden = !monitor.checked;
  };
  updateKind();
  nameInput.addEventListener('input', () => { locked.name = true; });
  categorySelect.addEventListener('change', () => { locked.category = true; });
  monitor.addEventListener('change', () => { locked.monitor = true; updateKind(); });
  dialog.querySelectorAll('[data-kind]').forEach((button) => button.addEventListener('click', () => {
    draft.kind = button.dataset.kind;
    locked.kind = true;
    if (!locked.monitor) monitor.checked = draft.kind === 'service';
    updateKind();
  }));
  const recognize = async () => {
    let url;
    try { url = safeUrl(urlInput.value); } catch { return; }
    dialog._abort?.abort();
    const controller = new AbortController();
    dialog._abort = controller;
    status.textContent = '正在识别名称和分类…';
    try {
      const metadata = await api('/api/metadata', { method: 'POST', body: JSON.stringify({ url }), signal: controller.signal });
      if (!dialog.open || submitted) return;
      if (!locked.name && metadata.name) nameInput.value = metadata.name;
      if (!locked.category) categorySelect.value = config.categories.some((category) => category.id === metadata.categoryId) ? metadata.categoryId : '';
      if (!locked.kind && metadata.kind) {
        draft.kind = metadata.kind;
        if (!locked.monitor) monitor.checked = draft.kind === 'service';
        updateKind();
      }
      draft.icon = metadata.icon || draft.icon || 'link';
      form.querySelector('#link-preview').innerHTML = brandIcon(draft.icon, nameInput.value);
      status.textContent = draft.kind === 'website' && !categorySelect.value ? '名称已识别，可存入未分类或选择分类' : '已识别，可直接' + (existing ? '保存' : '添加');
    } catch (error) {
      if (error.name !== 'AbortError') status.textContent = '可以直接保存，也可以修改名称和分类';
    }
  };
  urlInput.addEventListener('input', () => {
    clearTimeout(metadataTimer);
    dialog._abort?.abort();
    status.textContent = '粘贴后自动识别名称和分类';
    let url;
    try { url = safeUrl(urlInput.value); } catch { return; }
    if (!locked.name) nameInput.value = domain(url);
    if (!locked.kind) {
      draft.kind = inferService(url) ? 'service' : 'website';
      if (!locked.monitor) monitor.checked = draft.kind === 'service';
      updateKind();
    }
    metadataTimer = setTimeout(recognize, 350);
  });
  dialog.addEventListener('close', () => clearTimeout(metadataTimer), { once: true });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitted) return;
    const errorElement = form.querySelector('#link-error');
    errorElement.hidden = true;
    try {
      const url = safeUrl(urlInput.value);
      const duplicate = config.links.find((link) => link.id !== draft.id && safeUrl(link.url).replace(/\/$/, '') === url.replace(/\/$/, ''));
      if (duplicate) throw new Error('这个地址已添加为「' + duplicate.name + '」，请直接编辑已有入口');
      draft.url = url;
      draft.name = nameInput.value.trim() || domain(url);
      draft.categoryId = draft.kind === 'website' ? categorySelect.value : '';
      const needsDefaultCategory = draft.kind === 'website' && !draft.categoryId;
      draft.pinned = form.querySelector('#link-pinned').checked;
      draft.monitorEnabled = draft.kind === 'service' && monitor.checked;
      draft.checkUrl = draft.kind === 'service' && form.querySelector('#link-check-url').value.trim() ? safeUrl(form.querySelector('#link-check-url').value) : '';
      if (draft.kind === 'service') {
        draft.description = form.querySelector('#link-description').value.trim();
        draft.server = form.querySelector('#link-server').value.trim();
        draft.container = form.querySelector('#link-container').value.trim();
      }
      submitted = true;
      dialog._abort?.abort();
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.textContent = '保存中…';
      const positionInput = form.querySelector('#link-position');
      const requestedPosition = positionInput ? Math.max(0, Number(positionInput.value) - 1) : null;
      await mutate((state) => {
        if (needsDefaultCategory) {
          let category = state.categories.find((item) => item.name === '未分类');
          if (!category) {
            category = { id: uid(), name: '未分类', icon: 'folder', column: 2, order: Math.max(-1, ...state.categories.map((item) => item.order)) + 1 };
            state.categories.push(category);
          }
          draft.categoryId = category.id;
        }
        const index = state.links.findIndex((link) => link.id === draft.id);
        if (index >= 0) state.links[index] = { ...state.links[index], ...draft };
        else state.links.push(draft);
        if (draft.pinned && requestedPosition !== null) {
          const list = state.links.filter((link) => link.pinned && link.id !== draft.id).sort((a, b) => (a.pinnedOrder ?? a.order) - (b.pinnedOrder ?? b.order));
          list.splice(Math.min(requestedPosition, list.length), 0, state.links.find((link) => link.id === draft.id));
          list.forEach((link, index) => { link.pinnedOrder = index; });
        } else if (draft.pinned && !existing?.pinned) {
          draft.pinnedOrder = Math.max(-1, ...state.links.filter((link) => link.id !== draft.id && link.pinned).map((link) => link.pinnedOrder ?? link.order)) + 1;
          state.links.find((link) => link.id === draft.id).pinnedOrder = draft.pinnedOrder;
        }
      });
      dialog.close();
      toast(existing ? '已保存修改' : '已添加「' + draft.name + '」');
      if (draft.monitorEnabled) await checkServices(draft.id, false);
      else await refreshHealth();
    } catch (error) {
      submitted = false;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = false;
      submit.textContent = existing ? '保存' : '添加';
      errorElement.textContent = error.message;
      errorElement.hidden = false;
    }
  });
}

function openCategoryDialog(id) {
  const existing = config.categories.find((category) => category.id === id);
  let submitted = false;
  const dialog = makeDialog('<form id="category-form" class="dialog-form"><header class="dialog-header"><h2>' + (existing ? '编辑分类' : '新建分类') + '</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="关闭">' + icon('x') + '</button></header><div class="dialog-body"><label class="field"><span class="field-label">分类名称</span><input class="form-input" name="name" value="' + esc(existing?.name || '') + '" maxlength="30" required autofocus></label><div class="field-row"><label class="field"><span class="field-label">所在列</span><select class="form-select" name="column">' + [0, 1, 2].map((n) => '<option value="' + n + '" ' + (Number(existing?.column || 0) === n ? 'selected' : '') + '>第 ' + (n + 1) + ' 列</option>').join('') + '</select></label><label class="field"><span class="field-label">图标</span><select class="form-select" name="icon">' + ['folder', 'sparkles', 'code', 'layers', 'book', 'play', 'grid', 'link', 'network', 'cart', 'mail', 'forum'].map((name) => '<option value="' + name + '" ' + (existing?.icon === name ? 'selected' : '') + '>' + ({ folder: '文件夹', sparkles: '星芒', code: '代码', layers: '办公', book: '阅读', play: '影音', grid: '网格', link: '链接', network: '网络', cart: '购物', mail: '邮箱', forum: '社区' })[name] + '</option>').join('') + '</select></label></div><p class="form-error" hidden role="alert"></p></div><footer class="dialog-footer"><span></span><div><button class="btn btn-ghost" type="button" data-action="close-dialog">取消</button><button class="btn btn-primary" type="submit">保存</button></div></footer></form>');
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitted) return;
    const data = new FormData(event.target);
    const name = String(data.get('name')).trim();
    if (!name) return;
    try {
      submitted = true;
      const submit = dialog.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.textContent = '保存中…';
      await mutate((state) => {
        if (state.categories.some((category) => category.id !== id && category.name === name)) throw new Error('已存在同名分类');
        const category = { id: existing?.id || uid(), name, column: Number(data.get('column')), icon: String(data.get('icon')), order: existing?.order ?? Math.max(-1, ...state.categories.map((category) => category.order || 0)) + 1 };
        const index = state.categories.findIndex((item) => item.id === category.id);
        if (index < 0) state.categories.push(category);
        else state.categories[index] = category;
      });
      dialog.close();
      toast('分类已保存');
    } catch (error) {
      submitted = false;
      const submit = dialog.querySelector('[type="submit"]');
      submit.disabled = false;
      submit.textContent = '保存';
      const element = dialog.querySelector('.form-error');
      element.textContent = error.message;
      element.hidden = false;
    }
  });
}

function confirmDialog(title, message, label = '确认') {
  return new Promise((resolve) => {
    let confirmed = false;
    const dialog = makeDialog('<header class="dialog-header"><h2>' + esc(title) + '</h2><button class="icon-button" data-action="close-dialog" aria-label="关闭">' + icon('x') + '</button></header><div class="dialog-body"><p class="confirm-message">' + esc(message) + '</p></div><footer class="dialog-footer"><span></span><div><button class="btn btn-ghost" data-action="close-dialog">取消</button><button class="btn btn-primary" id="confirm-action">' + esc(label) + '</button></div></footer>');
    dialog.querySelector('#confirm-action').addEventListener('click', () => { confirmed = true; dialog.close(); });
    dialog.addEventListener('close', () => resolve(confirmed), { once: true });
  });
}

async function refreshHealth() {
  health = await api('/api/health');
  const alert = document.querySelector('#service-alert');
  if (alert) alert.innerHTML = alertMarkup();
  if (view === 'services' && !currentDialog) {
    const grid = document.querySelector('.service-grid');
    if (grid) {
      for (const link of config.links.filter((item) => item.kind === 'service')) {
        const card = [...grid.querySelectorAll('[data-service]')].find((item) => item.dataset.service === link.id);
        if (!card) continue;
        const template = document.createElement('template');
        template.innerHTML = serviceMarkup(link);
        const next = template.content.firstElementChild;
        card.classList.toggle('has-error', next.classList.contains('has-error'));
        card.querySelector('.status-badge')?.replaceWith(next.querySelector('.status-badge'));
        card.querySelector('.service-details')?.replaceWith(next.querySelector('.service-details'));
      }
    }
  }
}

async function checkServices(id, notify = true) {
  if (!config.links.some((link) => link.kind === 'service' && link.monitorEnabled && (!id || link.id === id))) {
    if (notify) toast('请先为服务开启监控');
    return;
  }
  await api('/api/check', { method: 'POST', body: JSON.stringify(id ? { id } : {}) });
  if (notify) toast('已开始检测');
  clearTimeout(checkTimer);
  await refreshHealth();
  checkTimer = setTimeout(() => refreshHealth().catch(() => {}), (Number(config.settings.timeout) + 1) * 1000);
}

async function exportBackup() {
  const latest = await api('/api/state');
  const content = { version: 1, exportedAt: new Date().toISOString(), ...latest };
  const blob = new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'litenav-backup-' + new Date().toLocaleDateString('sv-SE') + '.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('备份已导出');
}

async function handleAction(button) {
  const action = button.dataset.action;
  const id = button.dataset.id;
  switch (action) {
    case 'add-link': openLinkDialog({ categoryId: button.dataset.category, pinned: button.dataset.pinned === 'true' }); break;
    case 'add-service': openLinkDialog({ kind: 'service' }); break;
    case 'edit-link': openLinkDialog({ id }); break;
    case 'close-dialog': currentDialog?.close(); break;
    case 'toggle-edit': editMode = !editMode; render(); break;
    case 'unpin':
      await mutate((state) => { const item = state.links.find((link) => link.id === id); if (item) item.pinned = false; });
      toast('已移出常用，原入口仍然保留', { label: '撤销', run: () => mutate((state) => {
        const link = state.links.find((item) => item.id === id);
        if (link) link.pinned = true;
      }) });
      break;
    case 'delete-link': {
      const removed = structuredClone(config.links.find((link) => link.id === id));
      await mutate((state) => { state.links = state.links.filter((link) => link.id !== id); });
      toast('已删除「' + removed.name + '」', { label: '撤销', run: () => mutate((state) => { if (!state.links.some((link) => link.id === id)) state.links.push(removed); }) });
      break;
    }
    case 'check-service': await checkServices(id); break;
    case 'check-all': await checkServices(); break;
    case 'enable-monitor':
      await mutate((state) => { const link = state.links.find((link) => link.id === id); if (link) link.monitorEnabled = true; });
      await checkServices(id);
      break;
    case 'add-category': openCategoryDialog(); break;
    case 'edit-category': openCategoryDialog(id); break;
    case 'delete-category': {
      const category = config.categories.find((item) => item.id === id);
      if (config.links.some((link) => link.kind === 'website' && link.categoryId === id)) { toast('请先将这个分类中的网址移动到其他分类'); break; }
      if (await confirmDialog('删除分类', '确定删除「' + category.name + '」？', '删除')) await mutate((state) => { state.categories = state.categories.filter((item) => item.id !== id); });
      break;
    }
    case 'export': await exportBackup(); break;
    case 'start-link-check': button.disabled = true; await startLinkCheck(); break;
    case 'apply-redirect': await applyRedirects([id]); break;
    case 'apply-all-redirects': {
      const ids = currentLinkChecks().filter((entry) => entry.result.status === 'redirected').map((entry) => entry.link.id);
      if (ids.length && await confirmDialog('更新网址', '把 ' + ids.length + ' 个已跳转的网址更新为新地址？更新后可以撤销。', '全部更新')) await applyRedirects(ids);
      break;
    }
    case 'delete-broken': {
      const removed = currentLinkChecks().filter((entry) => entry.result.status === 'broken').map((entry) => structuredClone(entry.link));
      if (!removed.length || !await confirmDialog('删除疑似失效的网址', '删除 ' + removed.length + ' 个疑似失效的网址？删除后可以撤销。', '全部删除')) break;
      const ids = new Set(removed.map((link) => link.id));
      await mutate((state) => { state.links = state.links.filter((link) => !ids.has(link.id)); });
      toast('已删除 ' + removed.length + ' 个网址', { label: '撤销', run: () => mutate((state) => { for (const link of removed) if (!state.links.some((item) => item.id === link.id)) state.links.push(link); }) });
      break;
    }
    case 'import': document.querySelector('#import-file').click(); break;
    case 'import-bookmarks': document.querySelector('#bookmark-file').click(); break;
    case 'reload': location.reload(); break;
    case 'toggle-monitor': {
      const link = config.links.find((item) => item.id === button.dataset.id);
      if (!link) return;
      const enabled = !link.monitorEnabled;
      await mutate((state) => {
        const target = state.links.find((item) => item.id === link.id);
        if (target) target.monitorEnabled = enabled;
      });
      toast(enabled ? '已开启监控' : '已暂停监控');
      if (enabled) await checkServices(link.id, false);
      else await refreshHealth();
      break;
    }
  }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  event.preventDefault();
  handleAction(button).catch((error) => toast(error.message));
});

const isTyping = (element) => element?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');

document.addEventListener('keydown', (event) => {
  if (event.target.id === 'quick-search-input') {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!searchResults.length) return;
      searchIndex = (searchIndex + (event.key === 'ArrowDown' ? 1 : -1) + searchResults.length) % searchResults.length;
      updateSearchResults();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openSearchResult(searchIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (searchQuery) { searchQuery = ''; event.target.value = ''; updateSearchResults(); }
      else event.target.blur();
    }
    return;
  }
  const quickOpen = (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) || (event.key.toLowerCase?.() === 'k' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey);
  if (quickOpen && !currentDialog && !isTyping(event.target)) {
    const input = document.querySelector('#quick-search-input');
    if (input) { event.preventDefault(); input.focus(); input.select(); return; }
  }
  if (event.key === 'Escape' && !currentDialog && editMode) { editMode = false; render(); }
  if (event.key === 'Enter' && event.target.matches('.editable-item')) { event.preventDefault(); openLinkDialog({ id: event.target.dataset.resource }); }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'settings-form') return;
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  try {
    await mutate((state) => {
      state.settings = { checkInterval: Number(data.get('checkInterval')), failureThreshold: Number(data.get('failureThreshold')), timeout: Number(data.get('timeout')) };
    });
    toast('检测设置已保存');
  } catch (error) { toast(error.message); }
});

document.addEventListener('change', (event) => {
  if (!event.target.matches('[data-category-column]')) return;
  const id = event.target.dataset.categoryColumn;
  const column = Number(event.target.value);
  mutate((state) => { const category = state.categories.find((item) => item.id === id); if (category) category.column = column; }).then(() => toast('已调整分类所在列')).catch((error) => toast(error.message));
});

const canonicalUrl = (url) => { try { return safeUrl(url).replace(/\/$/, ''); } catch { return ''; } };

function planBookmarkImport(groups) {
  const seen = new Set(config.links.map((link) => canonicalUrl(link.url)));
  let duplicates = 0;
  let invalid = 0;
  const plan = [];
  for (const group of groups) {
    const links = [];
    for (const bookmark of group.links) {
      let url;
      try { url = safeUrl(bookmark.url); } catch { invalid += 1; continue; }
      if (url.length > 4096) { invalid += 1; continue; }
      const key = url.replace(/\/$/, '');
      if (seen.has(key)) { duplicates += 1; continue; }
      seen.add(key);
      links.push({ name: bookmark.name, url, kind: inferService(url) ? 'service' : 'website' });
    }
    if (links.length) plan.push({ name: group.name, links, existing: config.categories.some((category) => category.name === group.name) });
  }
  return { plan, duplicates, invalid };
}

async function importBookmarks(plan) {
  const bookmarks = plan.flatMap((group) => group.links.map((link) => ({ ...link, group: group.name })));
  const newCategories = new Set(plan.filter((group) => !group.existing && group.links.some((link) => link.kind === 'website')).map((group) => group.name));
  if (config.links.length + bookmarks.length > 5000) throw new Error('导入后入口会超过 5000 个，请取消勾选一些文件夹');
  if (config.categories.length + newCategories.size > 200) throw new Error('导入后分类会超过 200 个，请取消勾选一些文件夹');
  const items = [];
  for (let start = 0; start < bookmarks.length; start += 500) {
    const batch = await api('/api/metadata', { method: 'POST', body: JSON.stringify({ urls: bookmarks.slice(start, start + 500).map((link) => link.url) }) });
    items.push(...(batch.items || []));
  }
  const createdLinks = [];
  const createdCategories = [];
  await mutate((state) => {
    createdLinks.length = 0;
    createdCategories.length = 0;
    const seen = new Set(state.links.map((link) => canonicalUrl(link.url)));
    let nextOrder = Math.max(-1, ...state.links.map((link) => link.order || 0)) + 1;
    let nextCategoryOrder = Math.max(-1, ...state.categories.map((category) => category.order || 0)) + 1;
    bookmarks.forEach((bookmark, index) => {
      const key = bookmark.url.replace(/\/$/, '');
      if (seen.has(key)) return;
      seen.add(key);
      const meta = items?.[index] || {};
      let categoryId = '';
      if (bookmark.kind === 'website') {
        let category = state.categories.find((item) => item.name === bookmark.group);
        if (!category) {
          const counts = [0, 1, 2].map((column) => state.categories.filter((item) => Number(item.column) === column).length);
          category = { id: uid(), name: bookmark.group, icon: 'folder', column: counts.indexOf(Math.min(...counts)), order: nextCategoryOrder++ };
          state.categories.push(category);
          createdCategories.push(category.id);
        }
        categoryId = category.id;
      }
      let icon = meta.icon || '';
      if (!icon) { try { icon = new URL('/favicon.ico', bookmark.url).href; } catch { icon = ''; } }
      const link = {
        id: uid(), name: (bookmark.name || meta.name || domain(bookmark.url)).slice(0, 120), url: bookmark.url, icon,
        kind: bookmark.kind, categoryId, pinned: false, monitorEnabled: false, order: nextOrder++, pinnedOrder: 0,
      };
      state.links.push(link);
      createdLinks.push(link.id);
    });
  }).catch((error) => {
    if (error.status === 413) throw new Error('一次导入的内容太多，请少选一些文件夹，分几次导入');
    throw error;
  });
  const linkIds = new Set(createdLinks);
  const categoryIds = new Set(createdCategories);
  const services = config.links.filter((link) => linkIds.has(link.id) && link.kind === 'service').length;
  toast('已导入 ' + linkIds.size + ' 个网址' + (categoryIds.size ? '，新建 ' + categoryIds.size + ' 个分类' : '') + (services ? '，其中 ' + services + ' 个放进了「我的服务」' : ''), {
    label: '撤销',
    run: () => mutate((state) => {
      state.links = state.links.filter((link) => !linkIds.has(link.id));
      state.categories = state.categories.filter((category) => !categoryIds.has(category.id) || state.links.some((link) => link.categoryId === category.id));
    }),
  });
}

function openBookmarkDialog({ plan, duplicates, invalid }) {
  const total = plan.reduce((sum, group) => sum + group.links.length, 0);
  const services = plan.reduce((sum, group) => sum + group.links.filter((link) => link.kind === 'service').length, 0);
  const skippedText = [duplicates ? duplicates + ' 个已添加过' : '', invalid ? invalid + ' 个不是网页地址' : ''].filter(Boolean).join('、');
  const dialog = makeDialog('<form class="dialog-form" id="bookmark-form"><header class="dialog-header"><h2>导入浏览器书签</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="关闭">' + icon('x', 21) + '</button></header>' +
    '<div class="dialog-body"><p class="confirm-message">找到 ' + total + ' 个新网址，来自 ' + plan.length + ' 个文件夹' + (skippedText ? '；另有 ' + skippedText + '，将会跳过' : '') + '。</p>' +
    '<fieldset class="bookmark-groups"><legend class="field-label">选择要导入的文件夹</legend>' +
    plan.map((group, index) => '<label class="bookmark-group"><input type="checkbox" name="group" value="' + index + '" checked><span class="bookmark-group-name">' + icon('folder', 16) + '<span>' + esc(group.name) + '</span></span><span class="bookmark-group-target">' + (group.links.every((link) => link.kind === 'service') ? '我的服务' : group.existing ? '并入现有分类' : '新建分类') + '</span><span class="bookmark-group-count">' + group.links.length + ' 个</span></label>').join('') +
    '</fieldset><p class="field-hint">子文件夹里的网址会并入所在的顶层文件夹' + (services ? '；' + services + ' 个局域网地址会放进「我的服务」，不会自动开启检测' : '') + '。导入后可以撤销。</p><p class="form-error" role="alert" hidden></p></div>' +
    '<footer class="dialog-footer"><span></span><div><button class="btn btn-ghost" type="button" data-action="close-dialog">取消</button><button class="btn btn-primary" type="submit">导入 ' + total + ' 个</button></div></footer></form>');
  const form = dialog.querySelector('form');
  const submit = form.querySelector('[type="submit"]');
  const selected = () => [...form.querySelectorAll('[name="group"]:checked')].map((input) => plan[Number(input.value)]);
  const count = () => selected().reduce((sum, group) => sum + group.links.length, 0);
  form.addEventListener('change', () => {
    submit.textContent = '导入 ' + count() + ' 个';
    submit.disabled = !count();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!count() || submit.dataset.busy) return;
    submit.dataset.busy = 'true';
    submit.disabled = true;
    submit.textContent = '导入中…';
    try {
      await importBookmarks(selected());
      dialog.close();
      if (view !== 'home') location.hash = '#home';
    } catch (error) {
      delete submit.dataset.busy;
      submit.disabled = false;
      submit.textContent = '导入 ' + count() + ' 个';
      const element = form.querySelector('.form-error');
      element.textContent = error.message;
      element.hidden = false;
    }
  });
}

document.querySelector('#bookmark-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 30 * 1024 * 1024) throw new Error('书签文件不能超过 30 MB');
    const { groups, skipped } = parseBookmarks(await file.text());
    if (!groups.length) throw new Error(skipped ? '书签文件里没有可导入的网页地址' : '没有在文件中找到书签，请选择浏览器导出的书签 HTML 文件');
    const result = planBookmarkImport(groups);
    result.invalid += skipped;
    if (!result.plan.length) throw new Error('书签里的网址都已经添加过了');
    openBookmarkDialog(result);
  } catch (error) { toast(error.message); }
});

document.querySelector('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('备份文件不能超过 8 MB');
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported.links) || !Array.isArray(imported.categories) || !imported.settings) throw new Error('这不是有效的轻航备份文件');
    const confirmed = await confirmDialog('导入备份', '将用备份中的 ' + imported.links.length + ' 个入口和 ' + imported.categories.length + ' 个分类替换当前数据。建议先导出当前备份。', '导入并替换');
    if (!confirmed) return;
    await mutate((state) => { state.links = imported.links; state.categories = imported.categories; state.settings = imported.settings; });
    await refreshHealth();
    toast('备份已导入');
  } catch (error) { toast(error instanceof SyntaxError ? '备份文件不是有效的 JSON' : error.message); }
});

const DROP_CLASSES = ['drag-over', 'drop-before', 'drop-after', 'drop-zone'];
const clearDropMarks = () => document.querySelectorAll(DROP_CLASSES.map((name) => '.' + name).join(',')).forEach((element) => element.classList.remove(...DROP_CLASSES));
const precedes = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
// Within one list an item takes the target's place; from another list it lands before the target.
const itemPosition = (target, sameList) => sameList && precedes(dragged.element, target) ? 'after' : 'before';
const halfPosition = (target, event) => {
  const rect = target.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
};

function findDropTarget(event) {
  const { kind } = dragged;
  if (kind === 'category') {
    const item = event.target.closest('[data-drag-kind="category"]');
    if (item) {
      if (item.dataset.resource === dragged.id) return null;
      const category = config.categories.find((entry) => entry.id === item.dataset.resource);
      if (!category) return null;
      const position = halfPosition(item, event);
      return { mark: item, markClass: 'drop-' + position, targetId: category.id, column: Number(category.column), position };
    }
    const column = event.target.closest('.directory-column');
    return column ? { mark: column, markClass: 'drop-zone', targetId: null, column: Number(column.dataset.column), position: 'end' } : null;
  }
  if (kind === 'link') {
    const item = event.target.closest('[data-drag-kind="link"]');
    const zone = event.target.closest('[data-link-drop]');
    const scope = item?.dataset.scope || zone?.dataset.linkDrop;
    if (!scope || (dragged.scope === 'favorites') !== (scope === 'favorites')) return null;
    if (item?.dataset.resource === dragged.id) return null;
    if (item) return { mark: item, markClass: 'drag-over', scope, targetId: item.dataset.resource, position: itemPosition(item, scope === dragged.scope) };
    if (scope === dragged.scope && scope === 'favorites') return null;
    return { mark: zone, markClass: 'drop-zone', scope, targetId: null, position: 'end' };
  }
  if (kind === 'service') {
    const item = event.target.closest('[data-drag-kind="service"]');
    if (!item || item.dataset.resource === dragged.id) return null;
    return { mark: item, markClass: 'drag-over', targetId: item.dataset.resource, position: itemPosition(item, true) };
  }
  return null;
}

function placeItem(list, item, targetId, position) {
  const rest = list.filter((entry) => entry !== item);
  let index = targetId ? rest.findIndex((entry) => entry.id === targetId) : -1;
  if (index < 0) index = rest.length;
  else if (position === 'after') index += 1;
  rest.splice(index, 0, item);
  return rest;
}

function applyDrop(state, source, target) {
  if (source.kind === 'category') {
    const all = [0, 1, 2].flatMap((column) => ordered(state.categories).filter((category) => Number(category.column) === column));
    const item = all.find((category) => category.id === source.id);
    if (!item) return null;
    let list;
    if (target.targetId) list = placeItem(all, item, target.targetId, target.position);
    else {
      const rest = all.filter((category) => category !== item);
      const next = rest.findIndex((category) => Number(category.column) > target.column);
      rest.splice(next < 0 ? rest.length : next, 0, item);
      list = rest;
    }
    const moved = Number(item.column) !== target.column;
    item.column = target.column;
    list.forEach((category, index) => { category.order = index; });
    return moved ? '已将「' + item.name + '」移到第 ' + (target.column + 1) + ' 列' : '';
  }
  if (source.kind === 'service') {
    const services = ordered(state.links.filter((link) => link.kind === 'service'));
    const item = services.find((link) => link.id === source.id);
    if (item) placeItem(services, item, target.targetId, target.position).forEach((link, index) => { link.order = index; });
    return '';
  }
  const item = state.links.find((link) => link.id === source.id);
  if (!item) return null;
  if (target.scope === 'favorites') {
    const pinned = state.links.filter((link) => link.pinned).sort((a, b) => (a.pinnedOrder ?? a.order) - (b.pinnedOrder ?? b.order));
    placeItem(pinned, item, target.targetId, target.position).forEach((link, index) => { link.pinnedOrder = index; });
    return '';
  }
  const categoryId = target.scope.slice('category-'.length);
  const category = state.categories.find((entry) => entry.id === categoryId);
  if (!category) return null;
  const moved = item.categoryId !== categoryId;
  const siblings = ordered(state.links.filter((link) => link.kind === 'website' && link.categoryId === categoryId));
  item.categoryId = categoryId;
  placeItem(siblings, item, target.targetId, target.position).forEach((link, index) => { link.order = index; });
  return moved ? '已将「' + item.name + '」移到「' + category.name + '」' : '';
}

let dropTarget = null;
document.addEventListener('dragstart', (event) => {
  const item = event.target.closest?.('[data-drag-kind]');
  if (!item || item.getAttribute('draggable') !== 'true') return;
  event.stopPropagation();
  dragged = { kind: item.dataset.dragKind, id: item.dataset.resource, scope: item.dataset.scope, element: item };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', item.textContent.trim() || dragged.id);
  requestAnimationFrame(() => item.classList.add('dragging'));
});
document.addEventListener('dragover', (event) => {
  if (!dragged) return;
  const next = findDropTarget(event);
  if (!next) {
    if (dropTarget) { clearDropMarks(); dropTarget = null; }
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  if (dropTarget?.mark !== next.mark || dropTarget?.markClass !== next.markClass) {
    clearDropMarks();
    next.mark.classList.add(next.markClass);
  }
  dropTarget = next;
});
document.addEventListener('drop', async (event) => {
  if (!dragged) return;
  const target = findDropTarget(event);
  const source = dragged;
  dragged = null;
  dropTarget = null;
  clearDropMarks();
  source.element.classList.remove('dragging');
  if (!target) return;
  event.preventDefault();
  let message = '';
  try {
    await mutate((state) => { message = applyDrop(state, source, target) || ''; });
    if (message) toast(message);
  } catch (error) { toast(error.message); }
});
document.addEventListener('dragend', () => {
  dragged = null;
  dropTarget = null;
  document.querySelectorAll('.dragging').forEach((element) => element.classList.remove('dragging'));
  clearDropMarks();
});

document.addEventListener('input', (event) => {
  if (event.target.id !== 'quick-search-input') return;
  searchQuery = event.target.value;
  searchIndex = 0;
  updateSearchResults();
});
document.addEventListener('focusin', (event) => { if (event.target.id === 'quick-search-input') updateSearchResults(); });
document.addEventListener('focusout', (event) => { if (event.target.id === 'quick-search-input') requestAnimationFrame(updateSearchResults); });
// Keep focus in the box while choosing a result with the mouse, so the list does not close before the click lands.
document.addEventListener('mousedown', (event) => { if (event.target.closest('.quick-search-option')) event.preventDefault(); });
document.addEventListener('mousemove', (event) => {
  const option = event.target.closest?.('.quick-search-option');
  if (!option || Number(option.dataset.searchIndex) === searchIndex) return;
  searchIndex = Number(option.dataset.searchIndex);
  document.querySelectorAll('.quick-search-option').forEach((element) => {
    const selected = element === option;
    element.classList.toggle('is-selected', selected);
    element.setAttribute('aria-selected', String(selected));
  });
  document.querySelector('#quick-search-input')?.setAttribute('aria-activedescendant', option.id);
});
document.addEventListener('click', (event) => {
  // The link opens itself; only clear the box afterwards.
  if (event.target.closest('.quick-search-option')) setTimeout(() => openSearchResult(-1, false), 0);
});

window.addEventListener('hashchange', route);
window.addEventListener('focus', () => {
  if (!config || currentDialog || editMode) return;
  api('/api/state').then((latest) => { if (latest.revision !== config.revision) { config = latest; if (view !== 'tools') render(); } }).catch(() => {});
  refreshHealth().catch(() => {});
});

async function boot() {
  try {
    config = await api('/api/state');
    health = await api('/api/health').catch(() => ({ services: {} }));
    linkCheck = await api('/api/link-check').catch(() => linkCheck);
    route();
    if (linkCheck.job?.running) refreshLinkCheck().catch(() => {});
    setInterval(() => { if (!document.hidden) refreshHealth().catch(() => {}); }, 10000);
  } catch (error) {
    app.innerHTML = '<main class="boot-error">' + icon('alert', 32) + '<h1>暂时无法连接轻航</h1><p>' + esc(error.message) + '</p><button class="btn btn-primary" data-action="reload">重新连接</button></main>';
  }
}

boot();
