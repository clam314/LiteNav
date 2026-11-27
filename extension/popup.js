// The toolbar popup (also opened by the right-click menu and the shortcut):
// adds the page on show, or a link right-clicked on it, to 轻航.
import { api } from './backend.js';
import { brandIcon } from './icons.js';

export const PENDING_KEY = 'litenav.pendingSave';
const LAST_CATEGORY_KEY = 'litenav.popupCategory';
const ARCHIVE = 'archive';

const form = document.querySelector('.popup-form');
const message = document.querySelector('.popup-message');
const text = document.querySelector('.popup-text');
const domainLabel = document.querySelector('.popup-domain');
const iconHolder = document.querySelector('.popup-icon');
const placeField = document.querySelector('.popup-place');
const serviceHint = document.querySelector('.popup-service');

const canonical = (url) => String(url || '').replace(/\/+$/, '');
const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };
const uid = () => globalThis.crypto?.randomUUID?.() || 'item-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
const byPlace = (a, b) => (Number(a.column) || 0) - (Number(b.column) || 0) || (a.order ?? 0) - (b.order ?? 0);
const placeOf = (state, link) => {
  if (link.kind === 'service') return '服务集';
  const category = state.categories.find((item) => item.id === link.categoryId);
  return category ? (category.area === ARCHIVE ? '杂物库 · ' : '') + category.name : '';
};

function say(words) {
  form.hidden = true;
  message.hidden = false;
  text.textContent = words;
}

document.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
  window.close();
}));

// A right-clicked page or link waits in session storage; otherwise the active tab.
async function target() {
  const pending = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY];
  if (pending && Date.now() - pending.at < 15000) {
    await chrome.storage.session.remove(PENDING_KEY);
    return pending;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? { url: tab.url || '', title: tab.title || '', favIconUrl: tab.favIconUrl || '' } : null;
}

async function start() {
  const page = await target();
  if (!page || !/^https?:\/\//i.test(page.url)) {
    say('这个页面不能添加到轻航，只支持 http 和 https 网址。');
    return;
  }
  domainLabel.textContent = hostOf(page.url);
  const state = await api('/api/state');
  // The built-in site table only: instant, and the tab already gave the title.
  const [meta] = (await api('/api/metadata', { method: 'POST', body: JSON.stringify({ urls: [page.url] }) })).items;
  if (!meta) { say('这个网址无法添加。'); return; }
  const existing = state.links.find((link) => canonical(link.url) === canonical(meta.url));
  if (existing) {
    say('已经在轻航里了：「' + existing.name + '」' + (placeOf(state, existing) ? '，位于' + placeOf(state, existing) : '') + '。');
    return;
  }
  const known = Boolean(meta.icon);
  const icon = known ? meta.icon : /^https?:\/\//i.test(page.favIconUrl) ? page.favIconUrl : '';
  iconHolder.innerHTML = brandIcon(icon, meta.name, '', meta.url);
  form.elements.name.value = (known ? meta.name : page.title.trim() || meta.name).slice(0, 120);

  const select = form.elements.category;
  const groups = [['网址导航', state.categories.filter((item) => item.area !== ARCHIVE)], ['杂物库', state.categories.filter((item) => item.area === ARCHIVE)]];
  for (const [label, categories] of groups) {
    if (!categories.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const category of [...categories].sort(byPlace)) group.append(new Option(category.name, category.id));
    select.append(group);
  }
  const remembered = (await chrome.storage.local.get(LAST_CATEGORY_KEY))[LAST_CATEGORY_KEY];
  const exists = (id) => state.categories.some((item) => item.id === id);
  select.value = [meta.categoryId, remembered, state.categories.find((item) => item.area !== ARCHIVE)?.id].find((id) => id && exists(id)) || '';
  const service = meta.kind === 'service';
  placeField.hidden = service;
  serviceHint.hidden = !service;
  if (!service && !select.value) { say('轻航里还没有分类，请先在轻航里新建一个。'); return; }
  form.hidden = false;
  form.elements.name.select();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const latest = await api('/api/state');
      if (latest.links.some((link) => canonical(link.url) === canonical(meta.url))) { say('这个网址刚刚已经添加过了。'); return; }
      const categoryId = service ? null : select.value;
      const pinned = form.elements.pinned.checked;
      const next = (items, key) => Math.max(-1, ...items.map((item) => item[key] ?? 0)) + 1;
      const link = {
        id: uid(), name: form.elements.name.value.trim() || meta.name, url: meta.url, icon, kind: meta.kind, categoryId, pinned,
        order: next(latest.links.filter((item) => item.categoryId === categoryId && item.kind === meta.kind), 'order'),
        pinnedOrder: next(latest.links.filter((item) => item.pinned), 'pinnedOrder'),
        monitorEnabled: false,
      };
      latest.links.push(link);
      const saved = await api('/api/state', { method: 'PUT', body: JSON.stringify(latest) });
      if (!service) await chrome.storage.local.set({ [LAST_CATEGORY_KEY]: categoryId });
      say('已添加到' + (placeOf(saved, link) ? '「' + placeOf(saved, link) + '」' : '轻航') + (pinned ? '，并加入常用' : '') + '。');
      setTimeout(() => window.close(), 1200);
    } catch (error) {
      submit.disabled = false;
      say(error.message || '添加失败，请重试');
    }
  });
}

start().catch((error) => say(error.message || '读取失败，请重试'));
