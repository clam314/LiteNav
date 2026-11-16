import { icon, brandIcon } from './icons.js';
import { initCompanion } from './companion.js';

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
let currentDialog = null;
let mutationQueue = Promise.resolve();
let dragged = null;
let checkTimer = null;

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
    '<aside class="sidebar"><a href="#home" class="brand" aria-label="归航首页"><span class="brand-mark">' + icon('sparkles', 32) + '</span><span class="brand-name">归航</span></a>',
    '<nav class="sidebar-nav" aria-label="页面目录"><a href="#home" class="nav-item ' + (view === 'home' && !activeCategory ? 'active' : '') + '">' + icon('home') + '<span>常用</span></a>',
    '<div class="nav-section-label">网址目录</div>',
    categories.map((category) => '<a href="#category-' + encodeURIComponent(category.id) + '" class="nav-item ' + (view === 'home' && activeCategory === category.id ? 'active' : '') + '">' + icon(category.icon || 'folder') + '<span>' + esc(category.name) + '</span></a>').join(''),
    '<div class="nav-divider"></div><a href="#services" class="nav-item ' + (view === 'services' ? 'active' : '') + '">' + icon('server') + '<span>我的服务</span></a></nav>',
    '<div class="sidebar-bottom"><a href="#settings" class="nav-item ' + (view === 'settings' ? 'active' : '') + '">' + icon('settings') + '<span>设置</span></a></div></aside>',
  ].join('');
}

function itemActions(link, scope) {
  return '<div class="item-actions"><button class="icon-button" data-action="edit-link" data-id="' + esc(link.id) + '" aria-label="编辑 ' + esc(link.name) + '" title="编辑">' + icon('edit', 14) + '</button>' +
    (scope === 'favorites'
      ? '<button class="icon-button" data-action="unpin" data-id="' + esc(link.id) + '" aria-label="取消常用 ' + esc(link.name) + '" title="取消常用">' + icon('x', 14) + '</button>'
      : '<button class="icon-button danger" data-action="delete-link" data-id="' + esc(link.id) + '" aria-label="删除 ' + esc(link.name) + '" title="删除">' + icon('trash', 14) + '</button>') + '</div>';
}

function shortcutMarkup(link) {
  const content = brandIcon(link.icon, link.name) + '<span class="shortcut-name">' + esc(link.name).replace(/([a-z])([A-Z])/g, '$1<wbr>$2') + '</span>';
  if (editMode) return '<div class="shortcut editable-item" draggable="true" data-resource="' + esc(link.id) + '" data-scope="favorites" tabindex="0" aria-label="' + esc(link.name) + '，可拖动排序；按回车编辑">' + content + itemActions(link, 'favorites') + '</div>';
  return '<a class="shortcut" href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer" aria-label="打开 ' + esc(link.name) + '" title="' + esc(link.name) + '\n' + esc(link.url) + '">' + content + '</a>';
}

function siteMarkup(link, categoryId) {
  const content = brandIcon(link.icon, link.name) + '<span class="site-copy"><span class="site-name">' + esc(link.name) + '</span><span class="site-domain">' + esc(domain(link.url)) + '</span></span>';
  if (editMode) return '<div class="site-link editable-item" draggable="true" data-resource="' + esc(link.id) + '" data-scope="category-' + esc(categoryId) + '" tabindex="0" aria-label="' + esc(link.name) + '，可拖动排序；按回车编辑">' + content + itemActions(link, 'category') + '</div>';
  return '<a class="site-link" href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(link.name) + '\n' + esc(link.url) + '">' + content + '<span class="link-arrow">' + icon('arrow-up-right', 13) + '</span></a>';
}

function categoryMarkup(category) {
  const links = ordered(config.links.filter((link) => link.kind === 'website' && link.categoryId === category.id));
  return '<section class="category-card" id="category-' + esc(category.id) + '" aria-labelledby="title-' + esc(category.id) + '">' +
    '<header class="category-header"><div class="category-title">' + icon(category.icon || 'folder', 21) + '<h3 id="title-' + esc(category.id) + '">' + esc(category.name) + '</h3></div>' +
    (editMode ? '<button class="icon-button" data-action="add-link" data-category="' + esc(category.id) + '" aria-label="添加到 ' + esc(category.name) + '">' + icon('plus', 17) + '</button>' : '<span class="category-count" aria-label="' + links.length + ' 个网址">' + links.length + '</span>') + '</header>' +
    '<div class="link-grid" data-sort-scope="category-' + esc(category.id) + '">' + (links.map((link) => siteMarkup(link, category.id)).join('') || '<div class="empty-category">还没有网址<button class="btn btn-ghost" data-action="add-link" data-category="' + esc(category.id) + '">添加一个</button></div>') + '</div></section>';
}

function homeMarkup() {
  const pinned = favorites();
  const categories = ordered(config.categories);
  return '<section class="favorites-section" id="favorites"><div class="section-heading">' + icon('sparkles', 24) + '<h2>常用</h2>' +
    (editMode ? '<span class="section-note">拖动调整顺序，回车可编辑</span>' : '') + '</div>' +
    '<div class="favorites-grid" data-sort-scope="favorites">' + (pinned.map(shortcutMarkup).join('') || '<div class="empty-state">' + icon('star', 25) + '<p>把常用的网址或服务放在这里</p><button class="btn btn-secondary" data-action="add-link" data-pinned="true">添加常用</button></div>') + '</div></section>' +
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
  return '<article class="service-card ' + (status === 'offline' ? 'has-error' : '') + '" data-service="' + esc(link.id) + '"><header class="service-card-header">' +
    '<a class="service-identity" href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer">' + brandIcon(link.icon, link.name) + '<span class="service-copy"><h3>' + esc(link.name) + '</h3><span class="site-domain">' + esc(domain(link.url)) + '</span></span></a>' +
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
    '<div class="service-toolbar"><span class="section-hint">' + services.length + ' 个服务 · ' + monitored + ' 个已开启监控</span><button class="btn btn-secondary" data-action="check-all" ' + (!monitored ? 'disabled' : '') + '>' + icon('refresh', 16) + '立即检测</button></div>' +
    '<div class="service-grid">' + (services.map(serviceMarkup).join('') || '<div class="empty-state">' + icon('server', 30) + '<h2>添加你的第一个服务</h2><p>NAS、影音库或智能家居，都可以放在这里。</p><button class="btn btn-primary" data-action="add-service">添加服务</button></div>') + '</div>';
}

function settingsMarkup() {
  const categories = ordered(config.categories);
  return '<section class="settings-section"><div class="section-heading">' + icon('settings', 22) + '<h2>检测设置</h2></div><form class="settings-card settings-form" id="settings-form"><div class="field-row">' +
    '<label class="field"><span class="field-label">检测间隔（秒）</span><input class="form-input" type="number" name="checkInterval" min="10" max="86400" value="' + esc(config.settings.checkInterval) + '" required></label>' +
    '<label class="field"><span class="field-label">连续异常次数</span><input class="form-input" type="number" name="failureThreshold" min="1" max="10" value="' + esc(config.settings.failureThreshold) + '" required></label>' +
    '<label class="field"><span class="field-label">请求超时（秒）</span><input class="form-input" type="number" name="timeout" min="1" max="30" value="' + esc(config.settings.timeout) + '" required></label></div>' +
    '<p class="field-hint">后台会持续检测已开启监控的服务，关闭页面后也会继续。</p><div class="settings-actions"><button class="btn btn-primary" type="submit">保存设置</button></div></form></section>' +
    '<section class="settings-section"><div class="section-heading">' + icon('folder', 22) + '<h2>网址分类</h2><button class="btn btn-secondary" data-action="add-category">' + icon('plus', 16) + '新建分类</button></div><div class="settings-card">' +
    categories.map((category) => '<div class="category-settings-row"><span class="category-settings-name">' + icon(category.icon, 19) + '<span>' + esc(category.name) + '</span></span><span class="category-settings-count">' + config.links.filter((link) => link.kind === 'website' && link.categoryId === category.id).length + ' 个网址</span>' +
      '<label class="column-picker"><span class="sr-only">' + esc(category.name) + '所在列</span><select class="form-select" data-category-column="' + esc(category.id) + '">' + [0, 1, 2].map((n) => '<option value="' + n + '" ' + (Number(category.column) === n ? 'selected' : '') + '>第 ' + (n + 1) + ' 列</option>').join('') + '</select></label>' +
      '<button class="icon-button" data-action="edit-category" data-id="' + esc(category.id) + '" aria-label="编辑分类 ' + esc(category.name) + '">' + icon('edit', 16) + '</button><button class="icon-button danger" data-action="delete-category" data-id="' + esc(category.id) + '" aria-label="删除分类 ' + esc(category.name) + '">' + icon('trash', 16) + '</button></div>').join('') + '</div></section>' +
    '<section class="settings-section"><div class="section-heading">' + icon('download', 22) + '<h2>数据备份</h2></div><div class="settings-card"><p class="settings-description">导出网址、分类与服务配置，方便备份或迁移。</p><div class="settings-actions"><button class="btn btn-secondary" data-action="export">' + icon('upload', 16) + '导出备份</button><button class="btn btn-secondary" data-action="import">' + icon('download', 16) + '导入备份</button></div></div></section>';
}

function render() {
  if (!config) return;
  const titles = { home: '我的导航', services: '我的服务', settings: '设置' };
  const previousScroll = window.scrollY;
  app.innerHTML = '<div class="app-shell ' + (editMode ? 'edit-mode' : '') + '">' + sidebarMarkup() +
    '<main class="workspace"><header class="topbar"><h1 class="page-title">' + titles[view] + '</h1><div class="topbar-actions"><span id="service-alert">' + alertMarkup() + '</span>' +
    (view === 'home' ? '<button class="btn ' + (editMode ? 'btn-secondary is-editing' : 'btn-secondary') + '" data-action="toggle-edit">' + (editMode ? icon('check', 16) + '完成整理' : '整理') + '</button>' : '') +
    '<button class="btn btn-primary" data-action="' + (view === 'services' ? 'add-service' : 'add-link') + '">' + icon('plus', 18) + '添加' + (view === 'services' ? '服务' : '') + '</button></div></header>' +
    '<div class="page-content">' + (view === 'services' ? servicesMarkup() : view === 'settings' ? settingsMarkup() : homeMarkup()) + '</div></main></div>';
  document.title = titles[view] + ' · 归航';
  window.scrollTo({ top: previousScroll, behavior: 'instant' });
}

function route() {
  const hash = location.hash.slice(1);
  const oldView = view;
  view = hash === 'services' ? 'services' : hash === 'settings' ? 'settings' : 'home';
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
    '<div class="monitor-options" id="link-monitor-options"><label class="checkbox-row"><input type="checkbox" id="link-monitor" name="monitorEnabled" ' + (draft.monitorEnabled ? 'checked' : '') + '>启用掉线检测</label><label class="field" id="link-check-url-field"><span class="field-label">检测地址 <span class="optional">可选</span></span><input class="form-input" id="link-check-url" name="checkUrl" inputmode="url" placeholder="默认检测上方服务地址" value="' + esc(draft.checkUrl || '') + '"><span class="field-hint">检测从运行归航的服务器发出，需要能访问该服务。</span></label></div>',
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
  anchor.download = 'guihang-backup-' + new Date().toLocaleDateString('sv-SE') + '.json';
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
    case 'import': document.querySelector('#import-file').click(); break;
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

document.addEventListener('keydown', (event) => {
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

document.querySelector('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('备份文件不能超过 8 MB');
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported.links) || !Array.isArray(imported.categories) || !imported.settings) throw new Error('这不是有效的归航备份文件');
    const confirmed = await confirmDialog('导入备份', '将用备份中的 ' + imported.links.length + ' 个入口和 ' + imported.categories.length + ' 个分类替换当前数据。建议先导出当前备份。', '导入并替换');
    if (!confirmed) return;
    await mutate((state) => { state.links = imported.links; state.categories = imported.categories; state.settings = imported.settings; });
    await refreshHealth();
    toast('备份已导入');
  } catch (error) { toast(error instanceof SyntaxError ? '备份文件不是有效的 JSON' : error.message); }
});

document.addEventListener('dragstart', (event) => {
  const item = event.target.closest('.editable-item');
  if (!item || !editMode) return;
  dragged = { id: item.dataset.resource, scope: item.dataset.scope };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', dragged.id);
  item.classList.add('dragging');
});
document.addEventListener('dragover', (event) => {
  const item = event.target.closest('.editable-item');
  if (!item || !dragged || item.dataset.scope !== dragged.scope || item.dataset.resource === dragged.id) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drag-over').forEach((element) => element.classList.remove('drag-over'));
  item.classList.add('drag-over');
});
document.addEventListener('drop', async (event) => {
  const target = event.target.closest('.editable-item');
  if (!target || !dragged || target.dataset.scope !== dragged.scope) return;
  event.preventDefault();
  const source = dragged;
  dragged = null;
  try {
    await mutate((state) => {
      const list = source.scope === 'favorites'
        ? state.links.filter((link) => link.pinned).sort((a, b) => (a.pinnedOrder ?? a.order) - (b.pinnedOrder ?? b.order))
        : ordered(state.links.filter((link) => link.kind === 'website' && 'category-' + link.categoryId === source.scope));
      const from = list.findIndex((link) => link.id === source.id);
      const to = list.findIndex((link) => link.id === target.dataset.resource);
      if (from < 0 || to < 0 || from === to) return;
      const item = list.splice(from, 1)[0];
      list.splice(to, 0, item);
      list.forEach((link, index) => { link[source.scope === 'favorites' ? 'pinnedOrder' : 'order'] = index; });
    });
  } catch (error) { toast(error.message); }
});
document.addEventListener('dragend', () => {
  dragged = null;
  document.querySelectorAll('.dragging,.drag-over').forEach((element) => element.classList.remove('dragging', 'drag-over'));
});

window.addEventListener('hashchange', route);
window.addEventListener('focus', () => {
  if (!config || currentDialog || editMode) return;
  api('/api/state').then((latest) => { if (latest.revision !== config.revision) { config = latest; render(); } }).catch(() => {});
  refreshHealth().catch(() => {});
});

async function boot() {
  try {
    config = await api('/api/state');
    health = await api('/api/health').catch(() => ({ services: {} }));
    route();
    setInterval(() => { if (!document.hidden) refreshHealth().catch(() => {}); }, 10000);
  } catch (error) {
    app.innerHTML = '<main class="boot-error">' + icon('alert', 32) + '<h1>暂时无法连接归航</h1><p>' + esc(error.message) + '</p><button class="btn btn-primary" data-action="reload">重新连接</button></main>';
  }
}

boot();
