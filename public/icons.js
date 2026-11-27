import { faviconByName } from './icon-cache.js';

const paths = {
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5Z"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>',
  sparkles: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/><path d="M20 2v4m-2-2h4M4 18v4m-2-2h4"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  book: '<path d="M12 5v16M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z"/>',
  play: '<path d="m9 5 11 7-11 7Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.3"/><rect x="14" y="3" width="7" height="7" rx="1.3"/><rect x="3" y="14" width="7" height="7" rx="1.3"/><rect x="14" y="14" width="7" height="7" rx="1.3"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>',
  settings: '<path d="m9 3-.6 2.5-2 .9L4 5.7 2.5 8.3l1.8 1.8v2.3l-1.8 1.8L4 16.8l2.4-.7 2 .9L9 20h3l.6-3 2-.9 2.4.7 1.5-2.6-1.8-1.8v-2.3l1.8-1.8L17 5.7l-2.4.7-2-.9L12 3Z" transform="translate(1 0)"/><circle cx="11.5" cy="11.5" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'arrow-up-right': '<path d="M7 17 17 7M7 7h10v10"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'external-link': '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  edit: '<path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 14h12l1-14M10 10v6m4-6v6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  alert: '<path d="m10.3 4-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0ZM12 9v4m0 4h.01"/>',
  wand: '<path d="m4 20 11-11"/><path d="m14.5 3.5.9 1.9 1.9.9-1.9.9-.9 1.9-.9-1.9-1.9-.9 1.9-.9Z"/><path d="M19.5 12.5v3M18 14h3"/>',
  hash: '<path d="M5 9h14M5 15h14M10.5 4 8.5 20M15.5 4l-2 16"/>',
  columns: '<rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5"/><path d="M6 9h2M16 9h2M6 13h2M16 13h2"/>',
    cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1-.5 9.5Z"/>',
  refresh: '<path d="M20 7a8.5 8.5 0 0 0-14-2L3 8m0-5v5h5m-4 9a8.5 8.5 0 0 0 14 2l3-3m0 5v-5h-5"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 15v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M3 15v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5"/>',
  grip: '<circle cx="9" cy="5" r=".7"/><circle cx="15" cy="5" r=".7"/><circle cx="9" cy="12" r=".7"/><circle cx="15" cy="12" r=".7"/><circle cx="9" cy="19" r=".7"/><circle cx="15" cy="19" r=".7"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  'arrow-left': '<path d="m12 5-7 7 7 7M5 12h14"/>',
  link: '<path d="m10 13 4-4m-5 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2-1 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 1)"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  network: '<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v5M5 16v-3h14v3"/>',
  cart: '<path d="M2 3h3l3 12h11l3-9H6M9 20h.01M18 20h.01"/><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  forum: '<path d="M21 11a8 8 0 0 1-8 8H6l-4 3V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z"/><path d="M7 8h9M7 12h6"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  'archive-restore': '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h2m12-13v11a2 2 0 0 1-2 2h-2M9 15l3-3 3 3m-3-3v9"/>',
  toolbox: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M8 8V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3M3 13h18M10 12v3h4v-3"/>',
  braces: '<path d="M8 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1M16 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1"/>',
  file: '<path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>',
  database: '<ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/>',
  swap: '<path d="M4 8h15l-4-4M20 16H5l4 4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  bookmark: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1Z"/>',
  gongwen: '<path d="M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M9 7.5h6M8 11.5h8M10 15h6M12 18.5h3"/>',
};

/** A compact local set of consistent, stroke-based interface icons. */
export function icon(name, size = 20) {
  const requestedSize = Number(size);
  const safeSize = Number.isFinite(requestedSize) ? Math.min(96, Math.max(8, requestedSize)) : 20;
  const shape = Object.prototype.hasOwnProperty.call(paths, name) ? paths[name] : paths.link;
  return `<svg class="icon" width="${safeSize}" height="${safeSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg>`;
}

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

const brands = new Set([
  'github', 'chatgpt', 'nas', 'notion', 'figma', 'gmail', 'jellyfin', 'cloudflare',
  'claude', 'mdn', 'home-assistant', 'vercel', 'sspai', 'bilibili', 'spotify',
  'portainer', 'immich', 'adguard-home', 'deepseek', 'google-gemini', 'perplexity',
  'doubao', 'kimi', 'tongyi', 'cursor', 'copilot', 'poe', 'midjourney', 'hacker-news',
  'ruanyifeng', 'docker', 'stackoverflow', 'gitlab', 'npm', 'feishu', 'linear',
  'obsidian', 'amap', 'douban', 'taobao', 'google', 'zhihu', 'youtube', 'link',
  'router', 'zashboard', 'mdi-book-open-page-variant', 'mdi-cart', 'mdi-shopping',
  'mdi-email', 'mdi-newspaper', 'mdi-forum', 'linux-do', 'openmediavault',
  'openlist', 'mdi-magnify', 'mdi-database-search', 'kdocs',
]);

const aliases = {
  gemini: 'google-gemini',
  'docker-hub': 'docker',
  homeassistant: 'home-assistant',
  adguardhome: 'adguard-home',
  'stack-overflow': 'stackoverflow',
};

function httpUrl(value) {
  try {
    const parsed = new URL(value);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed;
  } catch {
    // Only complete HTTP(S) addresses can supply a remote image.
  }
  return null;
}

/** Pass the site URL for automatic icons so a broken page icon can fall back to /favicon.ico. */
export function brandIcon(slug, name = '', className = '', siteUrl = '') {
  const source = String(slug ?? '').trim();
  const key = source.toLowerCase();
  const candidate = Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : key;
  let url = brands.has(candidate) ? `/icons/${candidate}.svg` : '/icons/link.svg';
  const cacheKey = String(name ?? '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(faviconByName, cacheKey)) url = faviconByName[cacheKey];
  if (/^\/icons\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(?:svg|png|ico|webp)$/i.test(source)) {
    url = source;
  }
  if (/^https?:\/\//i.test(source)) {
    url = httpUrl(source)?.href || url;
  }
  let fallback = '';
  if (siteUrl && (url === '/icons/link.svg' || /^https?:\/\//i.test(url))) {
    const site = httpUrl(siteUrl);
    if (site) {
      const rootIcon = new URL('/favicon.ico', site).href;
      if (url === '/icons/link.svg') url = rootIcon;
      else if (url !== rootIcon) fallback = ` data-site-icon="${escapeAttribute(rootIcon)}"`;
      // In the Chrome extension, the browser's own copy of the site's icon
      // comes last: it is there offline for sites visited before.
      if (browserFavicons) fallback += ` data-browser-icon="${escapeAttribute('/_favicon/?pageUrl=' + encodeURIComponent(site.href) + '&size=64')}"`;
    }
  }
  const lightBackplate = ['github', 'midjourney', 'docker hub'].includes(String(name).trim().toLowerCase()) ? 'on-light' : '';
  const classes = escapeAttribute(`brand-icon ${className} ${lightBackplate}`.trim());
  return `<img src="${escapeAttribute(url)}"${fallback} alt="" class="${classes}" loading="lazy">`;
}

const browserFavicons = globalThis.location?.protocol === 'chrome-extension:';

// Consume the site's fallbacks once each, then use the bundled generic icon.
if (typeof document !== 'undefined') {
  document.addEventListener('error', (event) => {
    const target = event.target;
    if (target?.tagName !== 'IMG' || !target.classList.contains('brand-icon')) return;
    if (target.getAttribute('src') === '/icons/link.svg') return;
    const next = target.dataset.siteIcon || target.dataset.browserIcon || '/icons/link.svg';
    if (next === target.dataset.siteIcon) delete target.dataset.siteIcon;
    else delete target.dataset.browserIcon;
    target.src = next;
  }, true);
}
