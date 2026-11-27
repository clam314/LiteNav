import { icon, brandIcon } from './icons.js';
import { initCompanion } from './companion.js';
import { toolsMarkup, mountTools, resolveTool } from './tools.js';
import { searchLinks, googleSearchUrl } from './search.js';
import { parseBookmarks, bookmarksFromTree } from './bookmarks.js';
import { api, capabilities, backendMode, onBackendChange, hasPermission, requestPermission, dropPermission, browserSearch, browserBookmarks, reloadExtension } from './backend.js';
import { serverOrigin } from './sync-server.js';

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
// The server's automatic backups, newest first; null until the settings page reads them.
let backups = null;
let dragged = null;
let checkTimer = null;
let searchQuery = '';
let searchIndex = 0;
let searchResults = [];
let linkCheck = { job: null, results: {} };
let linkCheckTimer = null;
let syncStatus = null;
let networkAllowed = null;
let updateStatus = null;
// Where checks are made from, for the texts that explain them.
const checkSource = backendMode === 'extension' ? '这台电脑的浏览器' : '运行轻航的服务器';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => globalThis.crypto?.randomUUID?.() || 'item-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
const ordered = (items) => [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
// A category lives either in the home directory or in 杂物库, the shelf for rarely used sites.
const ARCHIVE = 'archive';
const ARCHIVE_UNSORTED = '@archive';
const areaOf = (category) => category?.area === ARCHIVE ? ARCHIVE : 'directory';
const areaCategories = (area, categories = config.categories) => [0, 1, 2].flatMap((column) => ordered(categories).filter((category) => areaOf(category) === area && Number(category.column) === column));
const directoryCategories = () => areaCategories('directory');
const archiveCategories = () => areaCategories(ARCHIVE);
const categoryOf = (link, categories = config.categories) => categories.find((category) => category.id === link.categoryId);
const isArchived = (link) => link.kind === 'website' && areaOf(categoryOf(link)) === ARCHIVE;
const placeName = (link) => {
  if (link.kind === 'service') return '服务';
  const category = categoryOf(link);
  if (!category) return '';
  return areaOf(category) === ARCHIVE ? '杂物库 · ' + category.name : category.name;
};
const quietestColumn = (categories, area) => {
  const counts = [0, 1, 2].map((column) => categories.filter((item) => areaOf(item) === area && Number(item.column) === column).length);
  return counts.indexOf(Math.min(...counts));
};
const favorites = () => config.links.filter((link) => link.pinned).sort((a, b) => (a.pinnedOrder ?? a.order) - (b.pinnedOrder ?? b.order));
const domain = (url) => { try { const parsed = new URL(url); return parsed.host.replace(/^www\./, ''); } catch { return url; } };
const safeUrl = (input) => {
  const raw = String(input).trim();
  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : (inferService('http://' + raw) ? 'http://' : 'https://') + raw);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) throw new Error('请填写有效的 HTTP 或 HTTPS 网址');
  return parsed.href;
};

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

// Display switches from 设置 → 显示; configurations from before them keep both on.
const opensNewTab = () => config?.settings?.openInNewTab !== false;
const linkTarget = () => opensNewTab() ? ' target="_blank" rel="noopener noreferrer"' : ' rel="noreferrer"';
function applyDisplaySettings() {
  document.body.toggleAttribute('data-hide-companion-button', config?.settings?.showCompanionButton === false);
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
    applyDisplaySettings();
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

// A newer build of the extension, announced once it is known.
function updateAlertMarkup() {
  return updateStatus?.available ? '<button class="update-pill" data-action="show-update" aria-label="有新版本 ' + esc(updateStatus.latest.version) + '，查看">' + icon('download', 15) + '<span>新版本 ' + esc(updateStatus.latest.version) + '</span></button>' : '';
}

function sidebarMarkup() {
  const categories = directoryCategories();
  return [
    '<aside class="sidebar"><a href="#home" class="brand" aria-label="轻航首页"><span class="brand-mark">' + icon('sparkles', 32) + '</span><span class="brand-name">轻航</span></a>',
    '<nav class="sidebar-nav" aria-label="页面目录"><a href="#home" class="nav-item ' + (view === 'home' && !activeCategory ? 'active' : '') + '">' + icon('home') + '<span>常用</span></a>',
    '<div class="nav-section-label">网址目录</div>',
    categories.map((category) => '<a href="#category-' + encodeURIComponent(category.id) + '" draggable="true" data-drag-kind="category" data-resource="' + esc(category.id) + '" title="拖动调整分类顺序" class="nav-item ' + (view === 'home' && activeCategory === category.id ? 'active' : '') + '">' + icon(category.icon || 'folder') + '<span>' + esc(category.name) + '</span></a>').join(''),
    '<div class="nav-divider"></div><a href="#services" class="nav-item ' + (view === 'services' ? 'active' : '') + '">' + icon('server') + '<span>服务集</span></a>',
    '<a href="#tools" class="nav-item ' + (view === 'tools' ? 'active' : '') + '">' + icon('toolbox') + '<span>工具箱</span></a>',
    '<a href="#archive" class="nav-item ' + (view === 'archive' ? 'active' : '') + '">' + icon('archive') + '<span>杂物库</span></a></nav>',
    '<div class="sidebar-bottom"><a href="#settings" class="nav-item ' + (view === 'settings' ? 'active' : '') + '">' + icon('settings') + '<span>设置</span></a></div></aside>',
  ].join('');
}

function itemActions(link, scope) {
  return '<div class="item-actions"><button class="icon-button" data-action="edit-link" data-id="' + esc(link.id) + '" aria-label="编辑 ' + esc(link.name) + '" title="编辑">' + icon('edit', 14) + '</button>' +
    (scope === 'category' ? (isArchived(link)
      ? '<button class="icon-button" data-action="unarchive-link" data-id="' + esc(link.id) + '" aria-label="把 ' + esc(link.name) + ' 移回网址导航" title="移回网址导航">' + icon('archive-restore', 14) + '</button>'
      : '<button class="icon-button" data-action="archive-link" data-id="' + esc(link.id) + '" aria-label="把 ' + esc(link.name) + ' 收进杂物库" title="收进杂物库">' + icon('archive', 14) + '</button>') : '') +
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

function linkIcon(link) {
  return brandIcon(link.icon, link.name, '', link.iconManual ? '' : link.url);
}

function shortcutMarkup(link) {
  const content = brokenFlag(link) + linkIcon(link) + '<span class="shortcut-name">' + esc(link.name).replace(/([a-z])([A-Z])/g, '$1<wbr>$2') + '</span>';
  if (editMode) return '<div class="shortcut editable-item" draggable="true" data-drag-kind="link" data-resource="' + esc(link.id) + '" data-scope="favorites" tabindex="0" aria-label="' + esc(link.name) + '，可拖动排序；按回车编辑">' + content + itemActions(link, 'favorites') + '</div>';
  return '<a class="shortcut" href="' + esc(link.url) + '"' + linkTarget() + ' aria-label="打开 ' + esc(link.name) + '" title="' + esc(link.name) + '\n' + esc(link.url) + '">' + content + '</a>';
}

function siteMarkup(link, categoryId) {
  const content = brokenFlag(link) + linkIcon(link) + '<span class="site-copy"><span class="site-name">' + esc(link.name) + '</span><span class="site-domain">' + esc(domain(link.url)) + '</span></span>';
  if (editMode) return '<div class="site-link editable-item" draggable="true" data-drag-kind="link" data-resource="' + esc(link.id) + '" data-scope="category-' + esc(categoryId) + '" tabindex="0" aria-label="' + esc(link.name) + '，可拖动排序或拖到其他分类；按回车编辑">' + content + itemActions(link, 'category') + '</div>';
  return '<a class="site-link" href="' + esc(link.url) + '"' + linkTarget() + ' title="' + esc(link.name) + '\n' + esc(link.url) + '">' + content + '<span class="link-arrow">' + icon('arrow-up-right', 13) + '</span></a>';
}

function categoryMarkup(category) {
  const links = ordered(config.links.filter((link) => link.kind === 'website' && link.categoryId === category.id));
  const sortable = editMode ? ' draggable="true" data-drag-kind="category" data-resource="' + esc(category.id) + '" data-link-drop="category-' + esc(category.id) + '"' : '';
  return '<section class="category-card" id="category-' + esc(category.id) + '" aria-labelledby="title-' + esc(category.id) + '"' + sortable + '>' +
    '<header class="category-header"' + (editMode ? ' title="拖动标题栏调整分类顺序，可拖到其他列"' : '') + '><div class="category-title">' + (editMode ? '<span class="drag-handle" aria-hidden="true">' + icon('grip', 16) + '</span>' : '') + icon(category.icon || 'folder', 21) + '<h3 id="title-' + esc(category.id) + '">' + esc(category.name) + '</h3></div>' +
    (editMode ? '<button class="icon-button" data-action="add-link" data-category="' + esc(category.id) + '" aria-label="添加到 ' + esc(category.name) + '">' + icon('plus', 17) + '</button>' : '<span class="category-count" aria-label="' + links.length + ' 个网址">' + links.length + '</span>') + '</header>' +
    '<div class="link-grid" data-sort-scope="category-' + esc(category.id) + '">' + (links.map((link) => siteMarkup(link, category.id)).join('') || '<div class="empty-category">还没有网址<span class="empty-category-actions">' +
      // Shelving makes 杂物库 categories on its own and moving pages back leaves them empty, so they can be cleared right here.
      (areaOf(category) === ARCHIVE ? '<button class="btn btn-ghost" data-action="delete-category" data-id="' + esc(category.id) + '">删除分类</button>' : '') +
      '<button class="btn btn-ghost" data-action="add-link" data-category="' + esc(category.id) + '">添加一个</button></span></div>') + '</div></section>';
}

const columnsMarkup = (categories) => '<div class="directory-columns">' +
  [0, 1, 2].map((column) => '<div class="directory-column" data-column="' + column + '">' + categories.filter((category) => Number(category.column) === column).map(categoryMarkup).join('') + '</div>').join('') + '</div>';

function homeMarkup() {
  const pinned = favorites();
  return '<section class="favorites-section" id="favorites"><div class="section-heading">' + icon('sparkles', 24) + '<h2>常用</h2>' +
    (editMode ? '<span class="section-note">拖动调整顺序，网址可拖到其他分类，分类可拖动标题栏换位置</span>' : '') + '</div>' +
    '<div class="favorites-grid" data-sort-scope="favorites" data-link-drop="favorites">' + (pinned.map(shortcutMarkup).join('') || '<div class="empty-state">' + icon('star', 25) + '<p>把常用的网址或服务放在这里</p><button class="btn btn-secondary" data-action="add-link" data-pinned="true">添加常用</button></div>') + '</div></section>' +
    '<section class="directory-section"><div class="section-heading">' + icon('link', 23) + '<h2>网址导航</h2></div>' + columnsMarkup(directoryCategories()) + '</section>';
}

function archiveMarkup() {
  const categories = archiveCategories();
  const count = config.links.filter(isArchived).length;
  const intro = '<div class="page-intro"><p>不常用的网址收在这里，不占首页位置；顶部搜索框照样能找到它们。在首页点“整理”，网址右侧的收纳按钮可以把它收进来，原来的分类会跟着一起建好。</p></div>';
  if (!categories.length) {
    return intro + '<div class="empty-state">' + icon('archive', 30) + '<h2>杂物库还是空的</h2><p>偶尔才用一次的网站、存着备查的文档和工具，都可以放在这里。</p>' +
      '<div class="empty-actions"><button class="btn btn-primary" data-action="add-link" data-area="archive">添加网址</button><button class="btn btn-secondary" data-action="add-category" data-area="archive">新建分类</button></div></div>';
  }
  return intro + '<div class="service-toolbar"><span class="section-hint">' + (editMode ? '拖动调整顺序，网址可拖到其他分类，分类可拖动标题栏换位置' : categories.length + ' 个分类 · ' + count + ' 个网址') + '</span>' +
    '<button class="btn btn-secondary" data-action="add-category" data-area="archive">' + icon('plus', 16) + '新建分类</button></div>' + columnsMarkup(categories);
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
    '<a class="service-identity"' + (editMode ? ' draggable="false"' : '') + ' href="' + esc(link.url) + '"' + linkTarget() + '>' + linkIcon(link) + '<span class="service-copy"><h3>' + esc(link.name) + '</h3><span class="site-domain">' + esc(domain(link.url)) + '</span></span></a>' +
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

function displaySettingsMarkup() {
  const row = (name, title, hint) => '<label class="setting-switch"><span class="setting-switch-copy"><span class="setting-switch-title">' + title + '</span><span class="field-hint">' + hint + '</span></span>' +
    '<input class="switch-input" type="checkbox" role="switch" data-setting="' + name + '"' + (config.settings[name] !== false ? ' checked' : '') + '></label>';
  return '<section class="settings-section"><div class="section-heading">' + icon('grid', 22) + '<h2>显示</h2></div><div class="settings-card setting-switches">' +
    row('openInNewTab', '在新标签页打开网站', '关闭后，网址和服务在当前页面打开。') +
    row('showCompanionButton', '显示角色按钮', '关闭后右下角的角色设置按钮不再显示，角色本身按原有设置继续显示；需要调整角色时重新打开这里。') +
    '</div></section>';
}

function categorySettingsRow(category) {
  return '<div class="category-settings-row" draggable="true" data-drag-kind="category" data-resource="' + esc(category.id) + '"><span class="drag-handle" title="拖动调整顺序" aria-hidden="true">' + icon('grip', 16) + '</span><span class="category-settings-name">' + icon(category.icon, 19) + '<span>' + esc(category.name) + '</span></span><span class="category-settings-count">' + config.links.filter((link) => link.kind === 'website' && link.categoryId === category.id).length + ' 个网址</span>' +
    '<label class="column-picker"><span class="sr-only">' + esc(category.name) + '所在列</span><select class="form-select" data-category-column="' + esc(category.id) + '">' + [0, 1, 2].map((n) => '<option value="' + n + '" ' + (Number(category.column) === n ? 'selected' : '') + '>第 ' + (n + 1) + ' 列</option>').join('') + '</select></label>' +
    '<button class="icon-button" data-action="edit-category" data-id="' + esc(category.id) + '" aria-label="编辑分类 ' + esc(category.name) + '">' + icon('edit', 16) + '</button><button class="icon-button danger" data-action="delete-category" data-id="' + esc(category.id) + '" aria-label="删除分类 ' + esc(category.name) + '">' + icon('trash', 16) + '</button></div>';
}

function settingsMarkup() {
  const categories = directoryCategories();
  const shelved = archiveCategories();
  return displaySettingsMarkup() + (capabilities.sync ? syncSectionMarkup() : '') + (capabilities.permissions ? networkSectionMarkup() : '') + (capabilities.update ? updateSectionMarkup() : '') + (!capabilities.monitor ? '' : '<section class="settings-section"><div class="section-heading">' + icon('settings', 22) + '<h2>检测设置</h2></div><form class="settings-card settings-form" id="settings-form"><div class="field-row">' +
    '<label class="field"><span class="field-label">检测间隔（秒）</span><input class="form-input" type="number" name="checkInterval" min="10" max="86400" value="' + esc(config.settings.checkInterval) + '" required></label>' +
    '<label class="field"><span class="field-label">连续异常次数</span><input class="form-input" type="number" name="failureThreshold" min="1" max="10" value="' + esc(config.settings.failureThreshold) + '" required></label>' +
    '<label class="field"><span class="field-label">请求超时（秒）</span><input class="form-input" type="number" name="timeout" min="1" max="30" value="' + esc(config.settings.timeout) + '" required></label></div>' +
    '<p class="field-hint">' + (backendMode === 'extension' ? 'Chrome 运行时会在后台持续检测已开启监控的服务，关闭页面后也会继续；最短每 30 秒一次，有服务离线时工具栏图标上会显示数量。' : '后台会持续检测已开启监控的服务，关闭页面后也会继续。') + '</p><div class="settings-actions"><button class="btn btn-primary" type="submit">保存设置</button></div></form></section>') +
    '<section class="settings-section"><div class="section-heading">' + icon('folder', 22) + '<h2>网址分类</h2><button class="btn btn-secondary" data-action="add-category">' + icon('plus', 16) + '新建分类</button></div><div class="settings-card category-settings-list"><p class="settings-description">拖动左侧把手调整分类顺序，首页和侧边栏会同步更新。</p>' +
    categories.map(categorySettingsRow).join('') + '</div></section>' +
    '<section class="settings-section"><div class="section-heading">' + icon('archive', 22) + '<h2>杂物库分类</h2><button class="btn btn-secondary" data-action="add-category" data-area="archive">' + icon('plus', 16) + '新建分类</button></div><div class="settings-card category-settings-list"><p class="settings-description">' +
    (shelved.length ? '杂物库里的分类，在杂物库页按列排布。编辑分类时可以把整个分类连同网址移回网址导航。' : '还没有杂物库分类。编辑网址分类时把位置改为“杂物库”，就能把整个分类收进去。') + '</p>' +
    shelved.map(categorySettingsRow).join('') + '</div></section>' +
    (capabilities.linkCheck ? '<section class="settings-section" id="link-check"><div class="section-heading">' + icon('check-circle', 22) + '<h2>网址体检</h2></div><div class="settings-card" id="link-check-card">' + linkCheckMarkup() + '</div></section>' : '') +
    '<section class="settings-section"><div class="section-heading">' + icon('download', 22) + '<h2>数据备份</h2></div><div class="settings-card"><p class="settings-description">导出网址、分类与服务配置，方便备份或迁移。</p><div class="settings-actions"><button class="btn btn-secondary" data-action="export">' + icon('upload', 16) + '导出备份</button><button class="btn btn-secondary" data-action="import">' + icon('download', 16) + '导入备份</button></div>' +
    '<div class="backup-auto"><div class="backup-auto-head"><div><h3>自动备份</h3><p class="settings-description">每天第一次修改前，以及一次删除 5 个以上入口或删除分类前，' + (backendMode === 'extension' ? '轻航会在本机' : '服务器会') + '自动保存修改前的配置' + (capabilities.sync ? '（云同步大量改动本机数据前也会）' : '') + '，保留最近 30 份。</p></div>' +
    '<button class="btn btn-secondary" data-action="backup-now">' + icon('download', 16) + '立即备份</button></div><div id="backup-list">' + backupsMarkup() + '</div></div></div></section>' +
    '<section class="settings-section"><div class="section-heading">' + icon('bookmark', 22) + '<h2>导入浏览器书签</h2></div><div class="settings-card"><p class="settings-description">在 Chrome、Edge、Firefox 或 Safari 中把书签导出为 HTML 文件，再在这里导入。每个顶层文件夹会成为一个分类，已添加过的网址会自动跳过，导入前可以先预览。</p><div class="settings-actions">' + (capabilities.browserBookmarks ? '<button class="btn btn-secondary" data-action="import-chrome-bookmarks">' + icon('bookmark', 16) + '读取 Chrome 书签</button>' : '') + '<button class="btn btn-secondary" data-action="import-bookmarks">' + icon('bookmark', 16) + '选择书签文件</button></div></div></section>';
}

function searchMarkup() {
  return '<div class="quick-search" id="quick-search">' + icon('search', 17) +
    '<input id="quick-search-input" class="quick-search-input" type="search" role="combobox" aria-label="搜索网址和服务" aria-autocomplete="list" aria-expanded="false" aria-controls="quick-search-results" autocomplete="off" spellcheck="false" enterkeyhint="go" placeholder="搜索网址和服务，回车打开" value="' + esc(searchQuery) + '">' +
    '<kbd class="quick-search-key" aria-hidden="true" title="按 / 或 Ctrl + K 开始搜索">/</kbd>' +
    '<div class="quick-search-results" id="quick-search-results" role="listbox" aria-label="搜索结果" hidden></div></div>';
}

function searchOptionMarkup(entry, index) {
  const selected = index === searchIndex;
  const attributes = ' id="quick-search-option-' + index + '" role="option" aria-selected="' + selected + '" class="quick-search-option' + (selected ? ' is-selected' : '') + '" data-search-index="' + index + '" href="' + esc(entry.url) + '"' + linkTarget() + ' tabindex="-1"';
  if (entry.google) return '<a' + attributes + '><span class="quick-search-google">' + icon('search', 16) + '</span><span class="quick-search-copy"><span class="quick-search-name">' + (capabilities.browserSearch ? '搜索' : '用 Google 搜索') + '“' + esc(searchQuery.trim()) + '”</span><span class="quick-search-meta">' + (capabilities.browserSearch ? '浏览器默认搜索引擎' : 'google.com') + '</span></span></a>';
  const link = entry.link;
  const place = placeName(link);
  return '<a' + attributes + '>' + linkIcon(link) + '<span class="quick-search-copy"><span class="quick-search-name">' + esc(link.name) + '</span><span class="quick-search-meta">' + esc(domain(link.url)) + '</span></span>' +
    (link.pinned ? '<span class="quick-search-tag">常用</span>' : '') + (place ? '<span class="quick-search-tag">' + esc(place) + '</span>' : '') + '</a>';
}

function updateSearchResults() {
  const input = document.querySelector('#quick-search-input');
  const panel = document.querySelector('#quick-search-results');
  if (!input || !panel) return;
  const query = searchQuery.trim();
  // Shelved sites are found too, after everyday ones that match as well.
  const links = config.links.map((link) => isArchived(link) ? { ...link, archived: true } : link);
  searchResults = query ? [...searchLinks(query, links).map((link) => ({ link, url: link.url })), { google: true, url: googleSearchUrl(query) }] : [];
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

// open is false when a result was already followed as a link and only the search resets.
function openSearchResult(index, open = true) {
  const entry = searchResults[index];
  if (entry && open) {
    if (entry.google && capabilities.browserSearch) { browserSearch(searchQuery.trim(), opensNewTab()); resetSearch(); return; }
    if (!opensNewTab()) { location.assign(entry.url); return; }
    window.open(entry.url, '_blank', 'noopener,noreferrer');
  } else if (open) return;
  resetSearch();
}

const LINK_CHECK_GROUPS = [
  { status: 'broken', title: '疑似失效', note: '域名已无法解析，或页面已不存在。', bulk: 'delete-broken', bulkLabel: '全部删除' },
  { status: 'redirected', title: '已跳转到其他网站', note: '网站可能已经换了地址，可以把入口更新为新地址。', bulk: 'apply-all-redirects', bulkLabel: '全部更新为新地址' },
  { status: 'unreachable', title: '暂时无法访问', note: '可能是网站临时故障，也可能是' + checkSource + '无法访问它（例如需要代理）。请先在浏览器中打开确认。' },
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
  const category = placeName(link);
  return '<div class="link-check-row">' + linkIcon(link) +
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
  const intro = '<p class="settings-description">检查目录里的网址是否还能打开。检测从' + checkSource + '发出，一般需要几十秒；离开本页也会继续。</p>';
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
  applyDisplaySettings();
  const searchInput = document.querySelector('#quick-search-input');
  const searchFocus = searchInput && document.activeElement === searchInput ? [searchInput.selectionStart, searchInput.selectionEnd] : null;
  const titles = { home: '我的导航', services: '服务集', settings: '设置', tools: '工具箱', archive: '杂物库' };
  const previousScroll = window.scrollY;
  app.innerHTML = '<div class="app-shell ' + (editMode ? 'edit-mode' : '') + '">' + sidebarMarkup() +
    '<main class="workspace"><header class="topbar"><h1 class="page-title">' + titles[view] + '</h1>' + searchMarkup() + '<div class="topbar-actions"><span id="update-alert">' + updateAlertMarkup() + '</span><span id="service-alert">' + alertMarkup() + '</span>' +
    (view === 'home' || view === 'services' || (view === 'archive' && archiveCategories().length) ? '<button class="btn ' + (editMode ? 'btn-secondary is-editing' : 'btn-secondary') + '" data-action="toggle-edit">' + (editMode ? icon('check', 16) + '完成整理' : '整理') + '</button>' : '') +
    (view === 'tools' ? '' : '<button class="btn btn-primary" data-action="' + (view === 'services' ? 'add-service' : 'add-link') + '"' + (view === 'archive' ? ' data-area="archive"' : '') + '>' + icon('plus', 18) + '添加' + (view === 'services' ? '服务' : '') + '</button>') + '</div></header>' +
    '<div class="page-content">' + (view === 'services' ? servicesMarkup() : view === 'settings' ? settingsMarkup() : view === 'tools' ? toolsMarkup(activeTool) : view === 'archive' ? archiveMarkup() : homeMarkup()) + '</div></main></div>';
  if (view === 'tools') mountTools(app, { toast });
  // A save may just have made an automatic backup.
  if (view === 'settings') refreshBackups();
  if (view === 'settings' && capabilities.sync) refreshSync();
  if (view === 'settings' && capabilities.permissions) refreshNetwork();
  if (view === 'settings' && capabilities.update) refreshUpdate();
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
  view = hash === 'services' ? 'services' : hash === 'settings' ? 'settings' : hash === 'archive' ? 'archive' : hash === 'tools' || hash.startsWith('tools/') ? 'tools' : 'home';
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

// Each place has its own 未分类 choice, so a site can go straight into 杂物库 before it has any categories.
function categoryOptions(selected, area) {
  // A closed select hides the group labels, so 杂物库 choices name their place.
  const group = (label, categories, unsorted, prefix) => '<optgroup label="' + label + '"><option value="' + unsorted + '" ' + (!selected && (unsorted === ARCHIVE_UNSORTED) === (area === ARCHIVE) ? 'selected' : '') + '>' + prefix + '未分类</option>' +
    categories.map((category) => '<option value="' + esc(category.id) + '" ' + (category.id === selected ? 'selected' : '') + '>' + prefix + esc(category.name) + '</option>').join('') + '</optgroup>';
  return group('网址导航', directoryCategories(), '', '') + group('杂物库', archiveCategories(), ARCHIVE_UNSORTED, '杂物库 · ');
}
const isUnsorted = (value) => !value || value === ARCHIVE_UNSORTED;

function inferService(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host.endsWith('.home') || host.endsWith('.lan') || host.endsWith('.local') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '[::1]';
  } catch { return false; }
}

function customIconUrl(input) {
  const value = input.trim();
  if (!value || /^\/icons\/(?:[\w-]+\/)*[\w-]+\.(?:svg|png|ico|webp)$/i.test(value)) return value;
  if (/^https?:\/\//i.test(value) && !/[\s\\]/.test(value)) return safeUrl(value);
  throw new Error('请填写 HTTP 或 HTTPS 图片地址，或 /icons/ 下的图标路径');
}

function openLinkDialog({ id, kind = 'website', categoryId = '', pinned = false, area = 'directory' } = {}) {
  const existing = config.links.find((link) => link.id === id);
  const place = existing ? areaOf(categoryOf(existing)) : categoryId ? areaOf(config.categories.find((category) => category.id === categoryId)) : area;
  const draft = existing ? structuredClone(existing) : {
    id: uid(), name: '', url: '', icon: 'link', kind,
    categoryId: categoryId || '', pinned,
    monitorEnabled: kind === 'service', checkUrl: '', pinnedOrder: favorites().length,
    order: Math.max(-1, ...config.links.map((link) => link.order || 0)) + 1,
  };
  const locked = { name: Boolean(existing), category: Boolean(existing || categoryId), kind: Boolean(existing || kind === 'service'), monitor: Boolean(existing) };
  const categoryNames = categoryOptions(draft.categoryId, place);
  const dialog = makeDialog([
    '<form class="dialog-form" id="link-form"><header class="dialog-header"><h2>' + (existing ? '编辑入口' : '添加入口') + '</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="关闭">' + icon('x', 21) + '</button></header>',
    '<div class="dialog-body"><div class="type-switch" aria-label="入口类型"><button type="button" data-kind="website" class="' + (draft.kind === 'website' ? 'is-active' : '') + '">' + icon('link', 15) + '网址</button><button type="button" data-kind="service" class="' + (draft.kind === 'service' ? 'is-active' : '') + '">' + icon('server', 15) + '服务</button></div>',
    '<label class="field"><span class="field-label">网址</span><input id="link-url" name="url" class="form-input" inputmode="url" autocomplete="url" spellcheck="false" placeholder="粘贴网址，例如 https://github.com" value="' + esc(draft.url) + '" required autofocus></label>',
    '<div class="recognition-row"><div class="dialog-preview-icon" id="link-preview">' + linkIcon(draft) + '</div><label class="recognition-copy"><span class="sr-only">名称</span><input class="form-input recognition-name" id="link-name" name="name" placeholder="自动识别名称，也可以修改" maxlength="120" value="' + esc(draft.name) + '" required><span class="recognition-status" id="metadata-status">' + (existing ? '名称和图标均可修改' : '粘贴网址后自动识别名称、图标和分类') + '</span></label></div>',
    '<div class="field"><label class="field-label" for="link-icon">图标地址</label><div class="link-icon-controls"><input class="form-input" id="link-icon" name="icon" inputmode="url" autocomplete="off" spellcheck="false" maxlength="4096" aria-describedby="link-icon-error" placeholder="自动识别，也可粘贴图片地址" value="' + esc(draft.iconManual ? draft.icon : '') + '"><button type="button" class="btn btn-secondary" id="reset-link-icon">恢复自动</button></div><span class="field-hint" id="link-icon-error" role="status" hidden>图片预览失败，请检查图标地址。</span></div>',
    '<label class="field" id="link-category-field"><span class="field-label">分类</span><select class="form-select" id="link-category" name="categoryId">' + categoryNames + '</select></label>',
    '<label class="checkbox-row"><input type="checkbox" id="link-pinned" name="pinned" ' + (draft.pinned ? 'checked' : '') + '>加入常用</label>',
    existing && existing.pinned ? '<label class="field"><span class="field-label">常用排序</span><input class="form-input" id="link-position" type="number" min="1" max="' + favorites().length + '" value="' + (favorites().findIndex((link) => link.id === draft.id) + 1) + '"><span class="field-hint">也可以在首页整理模式下拖动排序</span></label>' : '',
    '<div class="monitor-options" id="link-monitor-options"><label class="checkbox-row"><input type="checkbox" id="link-monitor" name="monitorEnabled" ' + (draft.monitorEnabled ? 'checked' : '') + '>启用掉线检测</label><label class="field" id="link-check-url-field"><span class="field-label">检测地址 <span class="optional">可选</span></span><input class="form-input" id="link-check-url" name="checkUrl" inputmode="url" placeholder="默认检测上方服务地址" value="' + esc(draft.checkUrl || '') + '"><span class="field-hint">检测从' + checkSource + '发出，需要能访问该服务。</span></label></div>',
    '<div class="service-config-fields" id="link-service-fields"><label class="field"><span class="field-label">描述 <span class="optional">可选</span></span><input class="form-input" id="link-description" maxlength="500" placeholder="例如 NAS 管理、影音库" value="' + esc(draft.description || '') + '"></label><details class="service-advanced"><summary>容器备注</summary><div class="field-row"><label class="field"><span class="field-label">服务器</span><input class="form-input" id="link-server" maxlength="100" placeholder="例如 local" value="' + esc(draft.server || '') + '"></label><label class="field"><span class="field-label">容器名称</span><input class="form-input" id="link-container" maxlength="100" placeholder="例如 jellyfin" value="' + esc(draft.container || '') + '"></label></div></details></div>',
    '<p class="form-error" id="link-error" role="alert" hidden></p></div>',
    '<footer class="dialog-footer"><span class="keyboard-hint">Enter ' + (existing ? '保存' : '添加') + '</span><div><button class="btn btn-ghost" type="button" data-action="close-dialog">取消</button><button class="btn btn-primary" type="submit">' + (existing ? '保存' : '添加') + '</button></div></footer></form>',
  ].join(''));
  const form = dialog.querySelector('form');
  const urlInput = form.querySelector('#link-url');
  const nameInput = form.querySelector('#link-name');
  const iconInput = form.querySelector('#link-icon');
  const iconError = form.querySelector('#link-icon-error');
  const preview = form.querySelector('#link-preview');
  const categorySelect = form.querySelector('#link-category');
  const status = form.querySelector('#metadata-status');
  const monitor = form.querySelector('#link-monitor');
  let metadataTimer;
  let metadataRequest;
  let metadataUrl = existing ? safeUrl(draft.url) : '';
  let automaticIcon = draft.iconManual ? '' : draft.icon;
  let submitted = false;
  const updatePreview = () => {
    const manual = iconInput.value.trim();
    iconError.hidden = true;
    preview.innerHTML = brandIcon(manual || automaticIcon, nameInput.value, '', !manual && automaticIcon ? metadataUrl : '');
  };
  preview.addEventListener('error', () => { iconError.hidden = !iconInput.value.trim(); }, true);
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
  nameInput.addEventListener('input', () => { locked.name = true; updatePreview(); });
  categorySelect.addEventListener('change', () => { locked.category = true; });
  monitor.addEventListener('change', () => { locked.monitor = true; updateKind(); });
  dialog.querySelectorAll('[data-kind]').forEach((button) => button.addEventListener('click', () => {
    draft.kind = button.dataset.kind;
    locked.kind = true;
    if (!locked.monitor) monitor.checked = draft.kind === 'service';
    updateKind();
  }));
  // Recognition names a directory category; adding to 杂物库 files the site under the shelf's category of the same name.
  const suggestedCategory = (id) => {
    const category = config.categories.find((item) => item.id === id);
    if (place !== ARCHIVE) return category ? category.id : '';
    return (category && archiveCategories().find((item) => item.name === category.name)?.id) || ARCHIVE_UNSORTED;
  };
  const recognize = (url) => {
    if (metadataUrl === url) return metadataRequest;
    metadataUrl = url;
    const controller = new AbortController();
    dialog._abort = controller;
    const timeout = setTimeout(() => controller.abort(), 6000);
    status.textContent = '正在识别名称、图标和分类…';
    metadataRequest = api('/api/metadata', { method: 'POST', body: JSON.stringify({ url }), signal: controller.signal }).then((metadata) => {
      if (!dialog.open || controller.signal.aborted) return;
      if (!locked.name && metadata.name) nameInput.value = metadata.name;
      if (!locked.category) categorySelect.value = suggestedCategory(metadata.categoryId);
      if (!locked.kind && metadata.kind) {
        draft.kind = metadata.kind;
        if (!locked.monitor) monitor.checked = draft.kind === 'service';
        updateKind();
      }
      automaticIcon = metadata.icon || new URL('/favicon.ico', url).href;
      updatePreview();
      status.textContent = draft.kind === 'website' && isUnsorted(categorySelect.value) ? '名称已识别，可存入未分类或选择分类' : '已识别，可直接' + (existing ? '保存' : '添加');
    }).catch(() => {
      if (!dialog.open || dialog._abort !== controller) return;
      automaticIcon = new URL('/favicon.ico', url).href;
      updatePreview();
      status.textContent = '可以直接保存，也可以修改名称、图标和分类';
    }).finally(() => clearTimeout(timeout));
    return metadataRequest;
  };
  const invalidateMetadata = () => {
    clearTimeout(metadataTimer);
    dialog._abort?.abort();
    dialog._abort = null;
    metadataUrl = '';
    automaticIcon = '';
  };
  const restoreAutomaticIcon = () => {
    iconInput.value = '';
    invalidateMetadata();
    updatePreview();
    let url;
    try { url = safeUrl(urlInput.value); } catch { return; }
    recognize(url);
  };
  iconInput.addEventListener('input', () => {
    if (iconInput.value.trim()) updatePreview();
    else restoreAutomaticIcon();
  });
  form.querySelector('#reset-link-icon').addEventListener('click', restoreAutomaticIcon);
  urlInput.addEventListener('input', () => {
    invalidateMetadata();
    status.textContent = '粘贴网址后自动识别名称、图标和分类';
    if (!locked.name) nameInput.value = '';
    updatePreview();
    let url;
    try { url = safeUrl(urlInput.value); } catch { return; }
    if (!locked.name) nameInput.value = domain(url);
    if (!locked.kind) {
      draft.kind = inferService(url) ? 'service' : 'website';
      if (!locked.monitor) monitor.checked = draft.kind === 'service';
      updateKind();
    }
    metadataTimer = setTimeout(() => recognize(url), 350);
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
      const manualIcon = customIconUrl(iconInput.value);
      submitted = true;
      form.querySelector('.dialog-body').inert = true;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.textContent = '保存中…';
      clearTimeout(metadataTimer);
      await recognize(url);
      if (!dialog.open) return;
      draft.url = url;
      draft.name = nameInput.value.trim() || domain(url);
      draft.icon = manualIcon || automaticIcon || new URL('/favicon.ico', url).href;
      draft.iconManual = Boolean(manualIcon);
      const chosen = categorySelect.value;
      const defaultArea = chosen === ARCHIVE_UNSORTED ? ARCHIVE : 'directory';
      draft.categoryId = draft.kind === 'website' && !isUnsorted(chosen) ? chosen : '';
      const needsDefaultCategory = draft.kind === 'website' && !draft.categoryId;
      draft.pinned = form.querySelector('#link-pinned').checked;
      draft.monitorEnabled = draft.kind === 'service' && monitor.checked;
      draft.checkUrl = draft.kind === 'service' && form.querySelector('#link-check-url').value.trim() ? safeUrl(form.querySelector('#link-check-url').value) : '';
      if (draft.kind === 'service') {
        draft.description = form.querySelector('#link-description').value.trim();
        draft.server = form.querySelector('#link-server').value.trim();
        draft.container = form.querySelector('#link-container').value.trim();
      }
      const positionInput = form.querySelector('#link-position');
      const requestedPosition = positionInput ? Math.max(0, Number(positionInput.value) - 1) : null;
      await mutate((state) => {
        if (needsDefaultCategory) {
          let category = state.categories.find((item) => item.name === '未分类' && areaOf(item) === defaultArea);
          if (!category) {
            category = { id: uid(), name: '未分类', icon: 'folder', column: 2, order: Math.max(-1, ...state.categories.map((item) => item.order)) + 1, ...(defaultArea === ARCHIVE ? { area: ARCHIVE } : {}) };
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
      form.querySelector('.dialog-body').inert = false;
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = false;
      submit.textContent = existing ? '保存' : '添加';
      errorElement.textContent = error.message;
      errorElement.hidden = false;
    }
  });
}

function openCategoryDialog(id, area = 'directory') {
  const existing = config.categories.find((category) => category.id === id);
  const place = existing ? areaOf(existing) : area;
  let submitted = false;
  const dialog = makeDialog('<form id="category-form" class="dialog-form"><header class="dialog-header"><h2>' + (existing ? '编辑分类' : '新建分类') + '</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="关闭">' + icon('x') + '</button></header><div class="dialog-body"><label class="field"><span class="field-label">分类名称</span><input class="form-input" name="name" value="' + esc(existing?.name || '') + '" maxlength="30" required autofocus></label><label class="field"><span class="field-label">位置</span><select class="form-select" name="area"><option value="directory" ' + (place !== ARCHIVE ? 'selected' : '') + '>网址导航（首页）</option><option value="archive" ' + (place === ARCHIVE ? 'selected' : '') + '>杂物库</option></select>' + (existing ? '<span class="field-hint">改变位置时，分类里的网址会一起移过去。</span>' : '') + '</label><div class="field-row"><label class="field"><span class="field-label">所在列</span><select class="form-select" name="column">' + [0, 1, 2].map((n) => '<option value="' + n + '" ' + (Number(existing?.column || 0) === n ? 'selected' : '') + '>第 ' + (n + 1) + ' 列</option>').join('') + '</select></label><label class="field"><span class="field-label">图标</span><select class="form-select" name="icon">' + ['folder', 'sparkles', 'code', 'layers', 'book', 'play', 'grid', 'link', 'network', 'cart', 'mail', 'forum'].map((name) => '<option value="' + name + '" ' + (existing?.icon === name ? 'selected' : '') + '>' + ({ folder: '文件夹', sparkles: '星芒', code: '代码', layers: '办公', book: '阅读', play: '影音', grid: '网格', link: '链接', network: '网络', cart: '购物', mail: '邮箱', forum: '社区' })[name] + '</option>').join('') + '</select></label></div><p class="form-error" hidden role="alert"></p></div><footer class="dialog-footer"><span></span><div><button class="btn btn-ghost" type="button" data-action="close-dialog">取消</button><button class="btn btn-primary" type="submit">保存</button></div></footer></form>');
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitted) return;
    const data = new FormData(event.target);
    const name = String(data.get('name')).trim();
    const nextArea = data.get('area') === ARCHIVE ? ARCHIVE : 'directory';
    if (!name) return;
    try {
      submitted = true;
      const submit = dialog.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.textContent = '保存中…';
      await mutate((state) => {
        if (state.categories.some((category) => category.id !== id && category.name === name && areaOf(category) === nextArea)) throw new Error((nextArea === ARCHIVE ? '杂物库里' : '网址导航里') + '已有同名分类');
        const category = { id: existing?.id || uid(), name, column: Number(data.get('column')), icon: String(data.get('icon')), order: existing?.order ?? Math.max(-1, ...state.categories.map((category) => category.order || 0)) + 1, ...(nextArea === ARCHIVE ? { area: ARCHIVE } : {}) };
        const index = state.categories.findIndex((item) => item.id === category.id);
        if (index < 0) state.categories.push(category);
        else state.categories[index] = category;
      });
      dialog.close();
      const count = config.links.filter((link) => link.kind === 'website' && link.categoryId === id).length;
      if (existing && place !== nextArea) toast('已把「' + name + '」' + (count ? '连同 ' + count + ' 个网址' : '') + (nextArea === ARCHIVE ? '收进杂物库' : '移回网址导航'));
      else toast('分类已保存');
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

const BACKUP_REASONS = { daily: '每日自动', bulk: '大量删除前', 'before-restore': '恢复前', manual: '手动', sync: '同步前' };
const backupTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

function backupsMarkup() {
  if (!backups) return '<p class="settings-description">正在读取备份…</p>';
  if (!backups.length) return '<p class="settings-description">还没有自动备份，第一次修改配置前会自动生成。</p>';
  return '<div class="backup-list">' + backups.map((item) => '<div class="backup-row"><span class="backup-time">' + esc(backupTime(item.createdAt)) + '</span>' +
    '<span class="backup-reason">' + esc(BACKUP_REASONS[item.reason] || item.reason) + '</span><span class="backup-count">' + item.links + ' 个入口 · ' + item.categories + ' 个分类</span>' +
    '<span class="backup-actions"><button class="btn btn-ghost btn-small" data-action="download-backup" data-id="' + esc(item.id) + '">下载</button>' +
    '<button class="btn btn-ghost btn-small" data-action="restore-backup" data-id="' + esc(item.id) + '">恢复</button></span></div>').join('') + '</div>';
}

async function refreshBackups() {
  try { backups = (await api('/api/backups')).backups; }
  catch { backups = backups || []; }
  const list = document.querySelector('#backup-list');
  if (list) list.innerHTML = backupsMarkup();
}

async function restoreBackup(id) {
  const item = backups?.find((entry) => entry.id === id);
  if (!item) return;
  const time = backupTime(item.createdAt);
  if (!await confirmDialog('恢复备份', '把配置恢复为 ' + time + ' 的备份（' + item.links + ' 个入口、' + item.categories + ' 个分类）？当前配置会先自动备份，需要时可以再恢复回来。', '恢复')) return;
  // Let a save that is still on its way finish first.
  await mutationQueue.catch(() => {});
  config = await api('/api/backups/restore', { method: 'POST', body: JSON.stringify({ id }) });
  render();
  toast('已恢复为 ' + time + ' 的备份');
}

function saveJson(content, filename) {
  const blob = new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportBackup() {
  const latest = await api('/api/state');
  saveJson({ version: 1, exportedAt: new Date().toISOString(), ...latest }, 'litenav-backup-' + new Date().toLocaleDateString('sv-SE') + '.json');
  toast('备份已导出');
}

async function downloadBackup(id) {
  saveJson(await api('/api/backups/' + encodeURIComponent(id)), 'litenav-backup-' + id + '.json');
}

// Moves a site between the home directory and 杂物库, into the category of the same name there (made if missing).
async function shelveLink(id, area) {
  const before = structuredClone(config.links.find((link) => link.id === id));
  if (!before) return;
  let created = null;
  let target = null;
  await mutate((state) => {
    created = null;
    const link = state.links.find((item) => item.id === id);
    if (!link) return;
    const from = categoryOf(link, state.categories);
    const name = from?.name || '未分类';
    target = state.categories.find((item) => areaOf(item) === area && item.name === name);
    if (!target) {
      target = { id: uid(), name, icon: from?.icon || 'folder', column: quietestColumn(state.categories, area), order: Math.max(-1, ...state.categories.map((item) => item.order || 0)) + 1, ...(area === ARCHIVE ? { area: ARCHIVE } : {}) };
      state.categories.push(target);
      created = target.id;
    }
    link.categoryId = target.id;
    link.order = Math.max(-1, ...state.links.filter((item) => item.kind === 'website' && item.categoryId === target.id && item.id !== id).map((item) => item.order || 0)) + 1;
    // A shelved site is by definition not an everyday one.
    if (area === ARCHIVE) link.pinned = false;
  });
  if (!target) return;
  const unpinned = area === ARCHIVE && before.pinned;
  toast((area === ARCHIVE ? '已把「' + before.name + '」收进杂物库「' : '已把「' + before.name + '」移回「') + target.name + '」' + (unpinned ? '，并移出常用' : ''), {
    label: '撤销',
    run: () => mutate((state) => {
      const link = state.links.find((item) => item.id === id);
      if (link && state.categories.some((item) => item.id === before.categoryId)) Object.assign(link, { categoryId: before.categoryId, order: before.order, pinned: before.pinned });
      if (created && !state.links.some((item) => item.categoryId === created)) state.categories = state.categories.filter((item) => item.id !== created);
    }),
  });
}

async function handleAction(button) {
  const action = button.dataset.action;
  const id = button.dataset.id;
  switch (action) {
    case 'add-link': openLinkDialog({ categoryId: button.dataset.category, pinned: button.dataset.pinned === 'true', area: button.dataset.area }); break;
    case 'archive-link': await shelveLink(id, ARCHIVE); break;
    case 'unarchive-link': await shelveLink(id, 'directory'); break;
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
      // Status codes need access to the service's site; without it the check still tells up from down.
      requestPermission('network').then(() => refreshNetwork());
      await mutate((state) => { const link = state.links.find((link) => link.id === id); if (link) link.monitorEnabled = true; });
      await checkServices(id);
      break;
    case 'add-category': openCategoryDialog(undefined, button.dataset.area); break;
    case 'edit-category': openCategoryDialog(id); break;
    case 'delete-category': {
      const category = config.categories.find((item) => item.id === id);
      if (config.links.some((link) => link.kind === 'website' && link.categoryId === id)) { toast('请先将这个分类中的网址移动到其他分类'); break; }
      if (await confirmDialog('删除分类', '确定删除「' + category.name + '」？', '删除')) await mutate((state) => { state.categories = state.categories.filter((item) => item.id !== id); });
      break;
    }
    case 'export': await exportBackup(); break;
    case 'backup-now': {
      button.disabled = true;
      try {
        backups = (await api('/api/backups', { method: 'POST', body: '{}' })).backups;
        const list = document.querySelector('#backup-list');
        if (list) list.innerHTML = backupsMarkup();
        toast('已备份当前配置');
      } finally { button.disabled = false; }
      break;
    }
    case 'restore-backup': await restoreBackup(id); break;
    case 'download-backup': await downloadBackup(id); break;
    case 'sync-enable': await enableSync(button, 'chrome'); break;
    case 'sync-server': openServerDialog(); break;
    case 'show-update':
      if (view !== 'settings') location.hash = '#settings';
      requestAnimationFrame(() => document.querySelector('#update')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      break;
    case 'update-check': {
      button.disabled = true;
      try {
        updateStatus = await api('/api/update', { method: 'POST', body: JSON.stringify({ action: 'check' }) });
        showUpdate();
        toast(updateStatus.error ? '检查失败：' + updateStatus.error : updateStatus.available ? '有新版本 ' + updateStatus.latest.version : '已是最新版本');
      } finally { if (button.isConnected) button.disabled = false; }
      break;
    }
    case 'update-reload': reloadExtension(); break;
    case 'sync-now': {
      button.disabled = true;
      try {
        syncStatus = (await api('/api/sync', { method: 'POST', body: JSON.stringify({ action: 'now' }) })).status;
        updateSyncCard();
        toast(syncStatus.state === 'error' ? '同步失败：' + syncStatus.lastError : '已同步');
      } finally { button.disabled = false; }
      break;
    }
    case 'sync-disable': {
      if (!await confirmDialog('关闭云同步', '关闭后，本机的修改不再同步到其他设备，其他设备的修改也不会再同步过来。本机和云端的数据都会保留。', '关闭同步')) break;
      syncStatus = (await api('/api/sync', { method: 'POST', body: JSON.stringify({ action: 'disable' }) })).status;
      updateSyncCard();
      toast('已关闭云同步');
      break;
    }
    case 'start-link-check': {
      const allowed = requestPermission('network');
      button.disabled = true;
      if (!await allowed) { button.disabled = false; toast('需要允许轻航访问网站，才能检测网址'); break; }
      refreshNetwork();
      await startLinkCheck();
      break;
    }
    case 'grant-network': {
      const allowed = await requestPermission('network');
      await refreshNetwork();
      toast(allowed ? '已允许访问网站' : '没有获得访问网站的权限');
      break;
    }
    case 'revoke-network':
      await dropPermission('network');
      await refreshNetwork();
      toast('已撤销访问网站的权限');
      break;
    case 'import-chrome-bookmarks': {
      const allowed = requestPermission('bookmarks');
      if (!await allowed) { toast('需要允许读取书签，才能直接导入'); break; }
      const { groups, skipped } = bookmarksFromTree(await browserBookmarks());
      if (!groups.length) throw new Error(skipped ? 'Chrome 书签里没有可导入的网页地址' : 'Chrome 里还没有书签');
      previewBookmarks(groups, skipped, '书签里的网址都已经添加过了');
      break;
    }
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
      if (enabled) requestPermission('network').then(() => refreshNetwork());
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
      state.settings = { ...state.settings, checkInterval: Number(data.get('checkInterval')), failureThreshold: Number(data.get('failureThreshold')), timeout: Number(data.get('timeout')) };
    });
    toast('检测设置已保存');
  } catch (error) { toast(error.message); }
});

// The display switches save at once and leave the page as it is, so focus stays on them.
document.addEventListener('change', async (event) => {
  const input = event.target.closest?.('[data-setting]');
  if (!input) return;
  const name = input.dataset.setting;
  const value = input.checked;
  const notes = {
    openInNewTab: value ? '网站将在新标签页打开' : '网站将在当前页面打开',
    showCompanionButton: value ? '已显示角色按钮' : '已隐藏角色按钮',
  };
  try {
    await mutate((state) => { state.settings = { ...state.settings, [name]: value }; }, { renderPage: false });
    toast(notes[name]);
  } catch (error) {
    input.checked = !value;
    toast(error.message);
  }
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
    if (links.length) plan.push({ name: group.name, links, existing: directoryCategories().some((category) => category.name === group.name) });
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
        let category = state.categories.find((item) => item.name === bookmark.group && areaOf(item) === 'directory');
        if (!category) {
          category = { id: uid(), name: bookmark.group, icon: 'folder', column: quietestColumn(state.categories, 'directory'), order: nextCategoryOrder++ };
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
  toast('已导入 ' + linkIds.size + ' 个网址' + (categoryIds.size ? '，新建 ' + categoryIds.size + ' 个分类' : '') + (services ? '，其中 ' + services + ' 个放进了「服务集」' : ''), {
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
    plan.map((group, index) => '<label class="bookmark-group"><input type="checkbox" name="group" value="' + index + '" checked><span class="bookmark-group-name">' + icon('folder', 16) + '<span>' + esc(group.name) + '</span></span><span class="bookmark-group-target">' + (group.links.every((link) => link.kind === 'service') ? '服务集' : group.existing ? '并入现有分类' : '新建分类') + '</span><span class="bookmark-group-count">' + group.links.length + ' 个</span></label>').join('') +
    '</fieldset><p class="field-hint">子文件夹里的网址会并入所在的顶层文件夹' + (services ? '；' + services + ' 个局域网地址会放进「服务集」，不会自动开启检测' : '') + '。导入后可以撤销。</p><p class="form-error" role="alert" hidden></p></div>' +
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

function previewBookmarks(groups, skipped, emptyMessage) {
  const result = planBookmarkImport(groups);
  result.invalid += skipped;
  if (!result.plan.length) throw new Error(emptyMessage);
  openBookmarkDialog(result);
}

document.querySelector('#bookmark-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 30 * 1024 * 1024) throw new Error('书签文件不能超过 30 MB');
    const { groups, skipped } = parseBookmarks(await file.text());
    if (!groups.length) throw new Error(skipped ? '书签文件里没有可导入的网页地址' : '没有在文件中找到书签，请选择浏览器导出的书签 HTML 文件');
    previewBookmarks(groups, skipped, '书签里的网址都已经添加过了');
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
      if (!category || areaOf(category) !== areaOf(config.categories.find((entry) => entry.id === dragged.id))) return null;
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
    const item = state.categories.find((category) => category.id === source.id);
    if (!item) return null;
    const all = areaCategories(areaOf(item), state.categories);
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
  const option = event.target.closest('.quick-search-option');
  // The extension searches with the browser's default engine instead.
  if (option && capabilities.browserSearch && searchResults[Number(option.dataset.searchIndex)]?.google) {
    event.preventDefault();
    openSearchResult(Number(option.dataset.searchIndex));
    return;
  }
  // The link opens itself; only clear the box afterwards.
  if (option) setTimeout(() => openSearchResult(-1, false), 0);
});

window.addEventListener('hashchange', route);
window.addEventListener('focus', () => {
  pullSync();
  if (!config || currentDialog || editMode) return;
  api('/api/state').then((latest) => { if (latest.revision !== config.revision) { config = latest; applyDisplaySettings(); if (view !== 'tools') render(); } }).catch(() => {});
  refreshHealth().catch(() => {});
});

// 插件版本 (Chrome extension): the version, 检查更新, and reloading after a
// newer build was unpacked over the extension's folder.
function updateCardMarkup() {
  const status = updateStatus;
  if (!status) return '<p class="field-hint">正在读取版本…</p>';
  const checked = status.checkedAt ? '上次检查于 ' + esc(shortTime(status.checkedAt)) : '尚未检查';
  const check = '<button class="btn btn-secondary" data-action="update-check">' + icon('refresh', 16) + '检查更新</button>';
  if (!status.releaseBuild) {
    return '<div class="sync-head"><div><p class="sync-state">当前版本 ' + esc(status.current) + '（自行构建）</p><p class="settings-description">从源码构建的版本不检查更新。GitHub 上自动构建的最新版本' +
      (status.latest ? '是 ' + esc(status.latest.version) : '可在 Releases 页面下载') + '。</p></div><div class="settings-actions"><a class="btn btn-ghost" href="' + esc(status.latest?.pageUrl || 'https://github.com/clam314/LiteNav/releases/tag/extension-latest') + '" target="_blank" rel="noopener noreferrer">打开 Releases</a>' + check + '</div></div>';
  }
  if (status.available) {
    return '<div class="sync-head"><div><p class="sync-state"><span class="sync-dot is-update"></span>有新版本 ' + esc(status.latest.version) + '</p><p class="settings-description">当前版本 ' + esc(status.current) +
      (status.latest.publishedAt ? '，新版本发布于 ' + esc(shortTime(status.latest.publishedAt)) : '') + '。</p></div>' +
      '<div class="settings-actions"><a class="btn btn-ghost" href="' + esc(status.latest.pageUrl) + '" target="_blank" rel="noopener noreferrer">更新说明</a><a class="btn btn-primary" href="' + esc(status.latest.zipUrl) + '">' + icon('download', 16) + '下载更新</a></div></div>' +
      '<ol class="update-steps"><li>下载压缩包并解压。</li><li>用解压出的文件覆盖原来加载的插件文件夹（' + esc('chrome://extensions') + ' 里可以看到它的位置）。</li><li>点“重新加载插件”。轻航的页面会关闭一次，Chrome 随后打开新版本；网址、设置和同步数据都不受影响。</li></ol>' +
      '<div class="settings-actions"><button class="btn btn-secondary" data-action="update-reload">重新加载插件</button></div>' + (status.error ? '<p class="field-hint">' + esc(status.error) + '</p>' : '');
  }
  return '<div class="sync-head"><div><p class="sync-state"><span class="sync-dot"></span>已是最新版本 ' + esc(status.current) + '</p><p class="settings-description">' + checked + '，每天自动检查一次。有新版本时，工具栏图标和页面顶部会提示。</p></div><div class="settings-actions">' + check + '</div></div>' +
    (status.error ? '<p class="sync-error">' + esc(status.error) + '</p>' : '');
}

function updateSectionMarkup() {
  return '<section class="settings-section" id="update"><div class="section-heading">' + icon('download', 22) + '<h2>插件版本</h2></div><div class="settings-card" id="update-card">' + updateCardMarkup() + '</div></section>';
}

function showUpdate() {
  const card = document.querySelector('#update-card');
  if (card) card.innerHTML = updateCardMarkup();
  const chip = document.querySelector('#update-alert');
  if (chip) chip.innerHTML = updateAlertMarkup();
}

let updateAnnounced = false;
async function refreshUpdate() {
  try { updateStatus = await api('/api/update'); } catch { return; }
  showUpdate();
  // The worker opened this tab after the files were replaced with a newer build.
  // Booting and rendering 设置 both ask: say it once.
  if (updateStatus.justUpdated && !updateAnnounced) {
    updateAnnounced = true;
    toast('轻航已更新到 ' + updateStatus.justUpdated.to);
    api('/api/update', { method: 'POST', body: JSON.stringify({ action: 'seen' }) }).catch(() => {});
    updateStatus.justUpdated = null;
  }
}

// 网站访问 (Chrome extension): the optional permission behind service
// status codes, 网址体检 and reading a pasted site's name and icon.
function networkCardMarkup() {
  return networkAllowed === null ? '<p class="field-hint">正在读取权限…</p>' : networkAllowed
    ? '<div class="sync-head"><div><p class="sync-state"><span class="sync-dot"></span>已允许访问网站</p><p class="settings-description">服务掉线检测、网址体检和粘贴网址后自动识别名称与图标都可以使用。请求从这台电脑发出，只用于这些检测。</p></div>' +
      '<div class="settings-actions"><button class="btn btn-ghost" data-action="revoke-network">撤销权限</button></div></div>'
    : '<div class="sync-head"><p class="settings-description">允许轻航访问网站后，才能检测服务的在线状态与响应、为网址做体检，并在粘贴网址时自动识别网站名称和图标（常见网站不需要）。请求从这台电脑发出，只用于这些检测。</p>' +
      '<button class="btn btn-primary" data-action="grant-network">允许访问网站</button></div>';
}

function networkSectionMarkup() {
  return '<section class="settings-section" id="network"><div class="section-heading">' + icon('network', 22) + '<h2>网站访问</h2></div><div class="settings-card" id="network-card">' + networkCardMarkup() + '</div></section>';
}

async function refreshNetwork() {
  networkAllowed = await hasPermission('network');
  const card = document.querySelector('#network-card');
  if (card) card.innerHTML = networkCardMarkup();
}

// 云同步 (Chrome extension): the configuration and companion preferences,
// through Chrome account sync or a self-hosted 轻航 server, merged with what
// other devices changed.
function syncSectionMarkup() {
  return '<section class="settings-section" id="sync"><div class="section-heading">' + icon('cloud', 22) + '<h2>云同步</h2></div><div class="settings-card" id="sync-card">' + syncCardMarkup() + '</div></section>';
}

const serverLabel = (url) => { try { return new URL(url).host; } catch { return url || ''; } };

function syncCardMarkup() {
  const intro = '<p class="settings-description">在多台电脑之间同步网址、分类、服务、设置和角色偏好。每台设备都可以离线修改，联网后自动合并。</p>';
  if (!syncStatus) return '<div class="sync-head">' + intro + '</div><p class="field-hint">正在读取同步状态…</p>';
  if (!syncStatus.enabled) {
    return '<div class="sync-head">' + intro + '<div class="settings-actions"><button class="btn btn-secondary" data-action="sync-server">' + icon('server', 16) + '连接自建服务器</button><button class="btn btn-primary" data-action="sync-enable">' + icon('cloud', 16) + '用 Chrome 账号同步</button></div></div>' +
      '<p class="field-hint">Chrome 账号同步需要在 Chrome 中登录 Google 账号并开启同步（包括“扩展程序”）。自建服务器即 Docker 运行的轻航，插件和网页版共用同一份数据。服务的在线状态和工具箱里的内容不会同步。</p>';
  }
  const viaServer = syncStatus.provider === 'server';
  const facts = [];
  if (syncStatus.state === 'waiting') facts.push('正在等待其他设备的数据传完');
  else if (syncStatus.lastSyncedAt) facts.push('上次同步于 ' + esc(shortTime(syncStatus.lastSyncedAt)));
  if (!viaServer && syncStatus.bytes) facts.push('云端占用 ' + Math.max(1, Math.round(syncStatus.bytes / 1024)) + ' KB / 96 KB');
  return '<div class="sync-head"><div><p class="sync-state"><span class="sync-dot' + (syncStatus.state === 'error' ? ' is-error' : '') + '"></span>' + (syncStatus.state === 'error' ? '同步出错' : viaServer ? '通过自建服务器 ' + esc(serverLabel(syncStatus.server)) + ' 同步' : '通过 Chrome 账号同步') + '</p>' +
    '<p class="settings-description">' + (facts.join(' · ') || '尚未同步') + '</p></div>' +
    '<div class="settings-actions"><button class="btn btn-ghost" data-action="sync-disable">关闭同步</button><button class="btn btn-secondary" data-action="sync-now">' + icon('refresh', 16) + '立即同步</button></div></div>' +
    (syncStatus.state === 'error' ? '<p class="sync-error">' + esc(syncStatus.lastError) + '</p>' : '') +
    (syncStatus.conflicts ? '<p class="field-hint">上次同步时有 ' + syncStatus.conflicts + ' 处内容在两台设备上都改过，已采用较新的修改；需要时可以在下方自动备份里恢复。</p>' : '') +
    '<p class="field-hint">' + (viaServer ? '本机的修改几秒后同步到服务器；服务器上的修改在打开轻航时和每 5 分钟同步过来。' : '本机的修改几秒后自动同步，其他设备的修改会自动同步过来。') + '</p>';
}

function updateSyncCard() {
  const card = document.querySelector('#sync-card');
  if (card) card.innerHTML = syncCardMarkup();
}

async function refreshSync() {
  try { syncStatus = (await api('/api/sync')).status; } catch { /* Keep what is shown. */ }
  updateSyncCard();
}

// Pull what changed elsewhere when 轻航 is opened or comes back into view;
// a server has no way to tell the extension itself.
let lastPull = 0;
function pullSync() {
  if (!capabilities.sync || Date.now() - lastPull < 30000) return;
  lastPull = Date.now();
  api('/api/sync', { method: 'POST', body: JSON.stringify({ action: 'now' }) }).then((result) => {
    syncStatus = result.status;
    if (view === 'settings') updateSyncCard();
  }).catch(() => {});
}

// Both sides hold different data: let the person choose how to start.
function chooseSyncMode(info, where) {
  return new Promise((resolve) => {
    let chosen = null;
    const count = (side) => side.links + ' 个入口、' + side.categories + ' 个分类';
    const option = (value, title, hint, checked) => '<label class="checkbox-row sync-choice"><input type="radio" name="sync-mode" value="' + value + '"' + (checked ? ' checked' : '') + '><span><strong>' + title + '</strong><span class="field-hint">' + hint + '</span></span></label>';
    const dialog = makeDialog('<form class="dialog-form" id="sync-mode-form"><header class="dialog-header"><h2>开启云同步</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="关闭">' + icon('x') + '</button></header><div class="dialog-body">' +
      '<p class="confirm-message">' + where + '已有数据（' + count(info.remote) + (info.remote.editedAt ? '，最后修改于 ' + esc(shortTime(info.remote.editedAt)) : '') + '），和本机（' + count(info.local) + '）不同。要怎样开始？</p>' +
      option('merge', '合并两边（推荐）', '两边的网址和分类都保留；同一项两边都改过时，采用较新的修改。', true) +
      option('remote', '使用' + where + '数据', '用' + where + '数据替换本机，替换前会自动备份本机数据。', false) +
      option('local', '使用本机数据', '用本机数据覆盖' + where + '，其他设备下次同步后也会变成这份。', false) +
      '</div><footer class="dialog-footer"><span></span><div><button class="btn btn-ghost" type="button" data-action="close-dialog">取消</button><button class="btn btn-primary" type="submit">开启同步</button></div></footer></form>');
    dialog.querySelector('#sync-mode-form').addEventListener('submit', (event) => {
      event.preventDefault();
      chosen = new FormData(event.target).get('sync-mode');
      // Answer at once rather than on the close event, which Chrome holds back in a hidden tab.
      resolve(chosen);
      dialog.close();
    });
    dialog.addEventListener('close', () => resolve(chosen), { once: true });
  });
}

// info: what inspect found on the channel (asked for here when missing).
async function enableSync(button, provider, info = null) {
  if (button) button.disabled = true;
  try {
    await mutationQueue.catch(() => {});
    info ||= await api('/api/sync', { method: 'POST', body: JSON.stringify({ action: 'inspect', provider }) });
    if (info.remote?.incomplete) { toast('其他设备的数据还在传输中，请稍后再试'); return false; }
    let mode = 'merge';
    // A browser that only has the starter sites simply takes the synced copy.
    if (info.remote && !info.remote.same && info.local.editedAt) {
      mode = await chooseSyncMode(info, provider === 'server' ? '服务器上' : '云端');
      if (!mode) return false;
    }
    syncStatus = (await api('/api/sync', { method: 'POST', body: JSON.stringify({ action: 'enable', mode, provider }) })).status;
    config = await api('/api/state');
    render();
    const where = provider === 'server' ? '服务器' : '云端';
    toast(syncStatus.state === 'error' ? '同步失败：' + syncStatus.lastError : !info.remote ? '已开启同步，本机数据已上传' : mode === 'local' ? '已开启同步，' + where + '已更新为本机数据' : mode === 'remote' || info.remote.same || !info.local.editedAt ? '已开启同步，已载入' + where + '数据' : '已开启同步，已和' + where + '数据合并');
    return true;
  } finally { if (button?.isConnected) button.disabled = false; }
}

// A self-hosted 轻航 (server.py, usually in Docker) as the sync hub.
function openServerDialog() {
  const dialog = makeDialog('<form class="dialog-form" id="sync-server-form"><header class="dialog-header"><h2>连接自建服务器</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="关闭">' + icon('x') + '</button></header><div class="dialog-body">' +
    '<label class="field"><span class="field-label">服务器地址</span><input class="form-input" name="url" inputmode="url" autocomplete="url" spellcheck="false" placeholder="https://nav.example.com 或 192.168.1.10:8765" required></label>' +
    '<label class="field"><span class="field-label">访问口令 <span class="optional">没有设置可不填</span></span><input class="form-input" name="password" type="password" autocomplete="current-password"></label>' +
    '<p class="field-hint">即服务器上的 LITENAV_PASSWORD，只保存在这台电脑。经公网访问时请使用 https 地址，口令才不会明文传输。</p><p class="field-hint" id="sync-server-status" role="status"></p>' +
    '</div><footer class="dialog-footer"><span></span><div><button class="btn btn-ghost" type="button" data-action="close-dialog">取消</button><button class="btn btn-primary" type="submit">连接</button></div></footer></form>');
  const form = dialog.querySelector('#sync-server-form');
  const status = dialog.querySelector('#sync-server-status');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    let origin;
    try { origin = serverOrigin(data.get('url')); }
    catch (error) { status.textContent = error.message; return; }
    // Asked while the click still counts: access to this one server.
    const allowed = requestPermission('server', { origins: [new URL(origin).origin + '/*'] });
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      if (!await allowed) { status.textContent = '需要允许轻航访问这个服务器'; return; }
      status.textContent = '正在连接…';
      const info = await api('/api/sync', { method: 'POST', body: JSON.stringify({ action: 'connect-server', url: origin, password: data.get('password') || '' }) });
      dialog.close();
      await enableSync(null, 'server', info);
    } catch (error) {
      status.textContent = error.message;
    } finally { if (submit.isConnected) submit.disabled = false; }
  });
  form.querySelector('input[name="url"]').focus();
}

// Another tab saved, the background worker applied a sync or checked services.
onBackendChange((what) => {
  if (what === 'sync') { if (view === 'settings') refreshSync(); return; }
  if (what === 'health') { refreshHealth().catch(() => {}); return; }
  if (what === 'update') { refreshUpdate(); return; }
  if (!config || currentDialog || editMode) return;
  api('/api/state').then((latest) => { if (latest.revision !== config.revision) { config = latest; applyDisplaySettings(); if (view !== 'tools') render(); } }).catch(() => {});
});

async function boot() {
  try {
    config = await api('/api/state');
    health = await api('/api/health').catch(() => ({ services: {} }));
    linkCheck = await api('/api/link-check').catch(() => linkCheck);
    route();
    if (linkCheck.job?.running) refreshLinkCheck().catch(() => {});
    pullSync();
    if (capabilities.update) refreshUpdate();
    if (capabilities.monitor) setInterval(() => { if (!document.hidden) refreshHealth().catch(() => {}); }, 10000);
  } catch (error) {
    app.innerHTML = '<main class="boot-error">' + icon('alert', 32) + '<h1>' + (backendMode === 'extension' ? '轻航数据读取失败' : '暂时无法连接轻航') + '</h1><p>' + esc(error.message) + '</p><button class="btn btn-primary" data-action="reload">重新连接</button></main>';
  }
}

boot();
