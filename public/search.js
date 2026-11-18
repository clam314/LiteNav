// Quick-open search over saved links and services. Pure functions, no DOM access.

const PINYIN_BOUNDARIES = '阿八嚓哒妸发旮哈讥咔垃痳拏噢妑七呥扨它穵夕丫帀';
const PINYIN_LETTERS = 'abcdefghjklmnopqrstwxyz';
const HAN = /[㐀-鿿]/;

let collator = null;
try {
  const candidate = new Intl.Collator('zh-CN-u-co-pinyin');
  // Without Chinese collation data the comparison falls back to code points and the boundaries mean nothing.
  if (candidate.compare('中', '安') > 0 && candidate.compare('八', '阿') > 0 && candidate.compare('中', '夕') > 0) collator = candidate;
} catch { collator = null; }

const initialsCache = new Map();

function letterFor(char) {
  if (!collator || !HAN.test(char)) return '';
  let letter = '';
  for (let index = 0; index < PINYIN_BOUNDARIES.length; index += 1) {
    if (collator.compare(char, PINYIN_BOUNDARIES[index]) >= 0) letter = PINYIN_LETTERS[index];
    else break;
  }
  return letter;
}

/** First letters of each word: Chinese characters by pinyin, Latin words by their first letter. "哔哩哔哩" → "blbl", "Google 翻译" → "gfy". */
export function initials(text) {
  const source = String(text ?? '');
  if (initialsCache.has(source)) return initialsCache.get(source);
  let result = '';
  let inWord = false;
  let previous = '';
  for (const char of source) {
    if (HAN.test(char)) {
      result += letterFor(char);
      inWord = false;
    } else if (/[a-z0-9]/i.test(char)) {
      // "GitHub" → "gh": an upper-case letter after a lower-case one starts a new word.
      if (!inWord || (/[A-Z]/.test(char) && /[a-z]/.test(previous))) result += char.toLowerCase();
      inWord = true;
    } else {
      inWord = false;
    }
    previous = char;
  }
  if (initialsCache.size > 2000) initialsCache.clear();
  initialsCache.set(source, result);
  return result;
}

const hostOf = (url) => {
  try { return new URL(url).host.replace(/^www\./, '').toLowerCase(); } catch { return String(url).toLowerCase(); }
};

function score(link, terms) {
  const name = String(link.name || '').toLowerCase();
  const compactName = name.replace(/\s+/g, '');
  const host = hostOf(link.url);
  const short = initials(link.name);
  const extra = [link.description, link.server, link.container].filter(Boolean).join(' ').toLowerCase();
  let total = 0;
  for (const term of terms) {
    let best = 0;
    if (name === term || compactName === term) best = 100;
    else if (name.startsWith(term) || compactName.startsWith(term)) best = 80;
    else if (term.length > 1 && (name.includes(term) || compactName.includes(term))) best = 60;
    else if (short && short.startsWith(term)) best = 55;
    else if (host.startsWith(term)) best = 50;
    else if (short && term.length > 1 && short.includes(term)) best = 40;
    else if (host.includes(term)) best = 35;
    else if (name.includes(term)) best = 25;
    else if (String(link.url).toLowerCase().includes(term)) best = 20;
    else if (extra.includes(term)) best = 15;
    if (!best) return 0;
    total += best;
  }
  return total;
}

/** Returns the best matches for `query`, highest score first; favorites win ties, then the saved order. */
export function searchLinks(query, links, limit = 8) {
  const terms = String(query ?? '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return links
    .map((link) => ({ link, score: score(link, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score
      || Number(Boolean(b.link.pinned)) - Number(Boolean(a.link.pinned))
      || (a.link.kind === b.link.kind ? 0 : a.link.kind === 'website' ? -1 : 1)
      || (a.link.order ?? 0) - (b.link.order ?? 0))
    .slice(0, limit)
    .map((entry) => entry.link);
}

export const googleSearchUrl = (query) => 'https://www.google.com/search?q=' + encodeURIComponent(String(query ?? '').trim());
