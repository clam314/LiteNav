// The extension's address-bar search ("ln", a space, then words): what to
// suggest and what Enter opens. Pure, so it is tested without a browser.
import { searchLinks } from './search.js';

const xml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };

// Sites of a configuration as the search box sees them (杂物库 ones rank last).
export function searchableLinks(state) {
  const archive = new Set(state.categories.filter((item) => item.area === 'archive').map((item) => item.id));
  return state.links.map((link) => ({ ...link, archived: link.kind === 'website' && archive.has(link.categoryId) }));
}

// Chrome's suggestion entries: the address as content, the name highlighted.
export function omniboxSuggestions(links, input, limit = 6) {
  return searchLinks(input, links, limit).map((link) => ({
    content: link.url,
    description: '<match>' + xml(link.name) + '</match> <dim>' + xml(hostOf(link.url)) + '</dim>' + (link.kind === 'service' ? ' <dim>· 服务</dim>' : ''),
  }));
}

// A chosen suggestion hands over its address; typed words open the best match.
export const omniboxTarget = (links, input) => links.find((link) => link.url === input) || searchLinks(input, links, 1)[0] || null;
