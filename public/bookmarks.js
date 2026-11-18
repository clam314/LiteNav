// Reads the "Netscape bookmark file" that Chrome, Edge, Firefox and Safari all export.
// A tag scanner instead of DOMParser, so the module also runs under Node for tests.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return String.fromCodePoint(value); } catch { return match; }
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

const stripTags = (html) => decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

function attribute(attributes, name) {
  const match = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(attributes);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : '';
}

// Toolbar and "other bookmarks" roots are containers, not topics: their sub-folders become groups of their own.
const isContainer = (attributes) => /\b(PERSONAL_TOOLBAR_FOLDER|UNFILED_BOOKMARKS_FOLDER)\s*=\s*["']?true/i.test(attributes);

export const UNSORTED_GROUP = '未分类';

/**
 * Parses an exported bookmark file into groups named after top-level folders.
 * Sub-folders merge into their top-level folder; bookmarks outside any folder go to "未分类".
 * Only http(s) links are kept. Returns { groups: [{ name, links: [{ name, url }] }], skipped }.
 */
export function parseBookmarks(html) {
  const source = String(html ?? '');
  if (!/<a\b[^>]*\bhref\s*=/i.test(source)) return { groups: [], skipped: 0 };
  const tokens = /<(\/?)(dl|h3|a)\b([^>]*)>/gi;
  const closeAnchor = /<\/a\s*>/gi;
  const stack = [];
  let pending = null;
  let skipped = 0;
  const groups = new Map();
  const add = (groupName, link) => {
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(link);
  };
  let match;
  while ((match = tokens.exec(source))) {
    const [, closing, tag, attributes] = match;
    const name = tag.toLowerCase();
    if (closing) {
      if (name === 'dl') stack.pop();
      continue;
    }
    if (name === 'h3') {
      const end = source.indexOf('</', tokens.lastIndex);
      const title = stripTags(source.slice(tokens.lastIndex, end < 0 ? undefined : end)).slice(0, 80);
      pending = { title: title || '未命名文件夹', container: isContainer(attributes) };
    } else if (name === 'dl') {
      stack.push(pending);
      pending = null;
    } else if (name === 'a') {
      closeAnchor.lastIndex = tokens.lastIndex;
      const close = closeAnchor.exec(source);
      const text = close ? stripTags(source.slice(tokens.lastIndex, close.index)) : '';
      const href = attribute(attributes, 'href').trim();
      if (!/^https?:\/\//i.test(href)) { skipped += 1; continue; }
      const folders = stack.filter(Boolean);
      const topic = folders.find((folder) => !folder.container);
      const holder = folders[folders.length - 1];
      // Loose links on the bookmarks bar keep the bar's own name; links at the very root are unsorted.
      add(topic ? topic.title : holder ? holder.title : UNSORTED_GROUP, { name: text.slice(0, 120), url: href });
    }
  }
  return { groups: [...groups].map(([groupName, links]) => ({ name: groupName, links })), skipped };
}
