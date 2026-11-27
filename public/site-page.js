// Name and icon of a web page, as server.py's MetadataParser reads them: the
// og:site_name or <title>, and the first <link rel=icon> (then apple-touch-icon,
// then /favicon.ico), resolved against <base href>. A tag scanner rather than
// DOMParser, so it also runs in the background worker and under Node.
import { decodeEntities } from './bookmarks.js';
import { normalizeUrl } from './state-model.js';

const attributesOf = (source) => {
  const attributes = {};
  for (const match of source.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const name = match[1].toLowerCase();
    if (!(name in attributes)) attributes[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
};

function resolve(base, href) {
  try {
    const target = new URL(href, base);
    if (target.protocol === 'http:' || target.protocol === 'https:') return normalizeUrl(target.href);
  } catch { /* Not an address. */ }
  return '';
}

export function parsePage(html, pageUrl) {
  // Scripts and comments may hold tag-like text.
  const source = String(html ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');
  let baseHref = '';
  let siteName = '';
  const icons = [];
  const touchIcons = [];
  for (const match of source.matchAll(/<(base|link|meta)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    const attributes = attributesOf(match[2]);
    const href = (attributes.href || '').trim();
    if (tag === 'base' && href && !baseHref) baseHref = href;
    if (tag === 'link' && href && !href.startsWith('#')) {
      const rel = (attributes.rel || '').toLowerCase().split(/\s+/);
      if (rel.includes('icon')) icons.push(href);
      else if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) touchIcons.push(href);
    }
    if (tag === 'meta' && (attributes.property || '').toLowerCase() === 'og:site_name') siteName = attributes.content || '';
  }
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source);
  const title = titleMatch ? decodeEntities(titleMatch[1].slice(0, 512)).replace(/\s+/g, ' ').trim() : '';
  const base = resolve(pageUrl, baseHref) || pageUrl;
  let icon = '';
  for (const href of [...icons, ...touchIcons]) {
    icon = resolve(base, href);
    if (icon) break;
  }
  return { name: (siteName.trim() || title).slice(0, 120), icon: icon || resolve(pageUrl, '/favicon.ico') };
}

// The charset a page declares: the Content-Type header, else a <meta> in its first bytes.
export function pageCharset(contentType, head) {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1];
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head || '');
  return fromMeta ? fromMeta[1] : 'utf-8';
}

// Reads at most 256 KB of an HTML page within timeout ms. null when it is
// not HTML or cannot be read (no host access, offline, refused).
export async function fetchPage(url, { timeout = 4000, fetchImpl = globalThis.fetch.bind(globalThis), limit = 256 * 1024 } = {}) {
  let response;
  try { response = await fetchImpl(url, { credentials: 'omit', redirect: 'follow', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(timeout) }); }
  catch { return null; }
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!response.ok || !['text/html', 'application/xhtml+xml'].includes(type)) { response.body?.cancel?.().catch?.(() => {}); return null; }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch { /* Keep what arrived. */ }
  reader.cancel().catch(() => {});
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  let decoder;
  try { decoder = new TextDecoder(pageCharset(response.headers.get('content-type'), head)); }
  catch { decoder = new TextDecoder('utf-8'); }
  return { html: decoder.decode(bytes.subarray(0, Math.min(size, limit))), url: response.url || url };
}
