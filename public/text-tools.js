// 文本处理 tools: 文本清洗, 字数统计 and 文本对比. Pure functions, no DOM access,
// so they run in the page and under Node alike.

const HAN = /\p{Script=Han}/u;
// Chinese punctuation, as typed with a Chinese input method.
const CJK_PUNCT = '，。、；：？！“”‘’（）《》〈〉【】「」『』…—～·';
const OPENING = '“‘（《〈【「『';
const CLOSING = '，。、；：？！”’）》〉】」』…';
const escapeClass = (chars) => chars.replace(/[\]\\^-]/g, '\\$&');
const isHan = (char) => HAN.test(char);

// ---------------------------------------------------------------------------
// 文本清洗
// ---------------------------------------------------------------------------

export const CLEAN_RULES = [
  ['invisible', '删除不可见字符'],
  ['markdown', '去除 Markdown 符号'],
  ['mergeLines', '合并 PDF 断行'],
  ['punctuation', '中文标点统一为全角'],
  ['fullwidthAlnum', '全角字母数字转半角'],
  ['hanSpaces', '删除中文之间的空格'],
  ['mixedSpaces', '删除中文与英文、数字之间的空格'],
  ['repeatedPunct', '删除重复标点'],
  ['blankLines', '合并多余空行'],
];

export const CLEAN_DEFAULTS = Object.freeze({
  invisible: true, markdown: true, mergeLines: false, punctuation: true, fullwidthAlnum: true,
  hanSpaces: true, mixedSpaces: true, repeatedPunct: true, blankLines: true,
});

// Markdown as AI answers and notes write it, turned into plain text: tables
// become tab-separated rows (they paste into Excel and Word as tables).
function stripMarkdown(text, count) {
  const lines = text.split('\n');
  const out = [];
  let fence = false;
  for (let line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; count(); continue; }
    if (fence) { out.push(line); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { count(); continue; }
    // Table: |---|:---:| separators go, cells are joined by tabs.
    if (/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line) || /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) { count(); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()).join('\t');
      count();
    }
    line = line.replace(/^(\s{0,3})#{1,6}\s+(.*?)(\s+#+)?\s*$/, (match, indent, title) => { count(); return title; });
    line = line.replace(/^(\s*)>\s?/, (match) => { count(); return ''; });
    line = line.replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, (match, indent) => { count(); return indent; });
    line = line.replace(/^(\s*)[-*+]\s+/, (match, indent) => { count(); return indent; });
    out.push(line);
  }
  let result = out.join('\n');
  const inline = [
    [/!\[([^\]]*)\]\([^)]*\)/g, '$1'],
    [/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, label, url) => (label === url ? url : label + '（' + url + '）')],
    [/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2'],
    [/~~(?=\S)([\s\S]*?\S)~~/g, '$1'],
    [/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1$2'],
    [/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1$2'],
    [/`([^`\n]+)`/g, '$1'],
    [/<br\s*\/?>/gi, '\n'],
  ];
  for (const [pattern, replacement] of inline) {
    result = result.replace(pattern, (...args) => {
      count();
      return typeof replacement === 'function' ? replacement(...args) : replacement.replace(/\$(\d)/g, (m, n) => args[Number(n)] ?? '');
    });
  }
  return result;
}

// Display width: Chinese characters take two columns.
const widthOf = (text) => [...text].reduce((sum, char) => sum + (/[ᄀ-￿]/.test(char) ? 2 : 1), 0);
const NEW_BLOCK = /^(第[一二三四五六七八九十百零〇\d]+[章节条部分篇]|[一二三四五六七八九十]+、|[（(][一二三四五六七八九十\d]+[）)]|\d+[.、．](?!\d)|[-•·*●○■▪◆]\s|附件|[A-Za-z][.、]\s)/;
const SENTENCE_END = /[。！？；：…”」』）)!?.;:]$/;

// Text copied from a PDF breaks every line at the page's edge. Lines join
// back into paragraphs unless a line ends a paragraph: a sentence ending on a
// shorter line, a line much shorter than the rest, or the next line starting
// a new item (一、 （一） 1. - and the like). Blank lines stay paragraph breaks.
function mergeBrokenLines(text, count) {
  const lines = text.split('\n');
  const widths = lines.map((line) => widthOf(line.trim())).filter((width) => width > 0).sort((a, b) => a - b);
  const typical = widths.length ? widths[Math.floor(widths.length * 0.8)] : 0;
  const out = [];
  let current = null;
  const flush = () => { if (current !== null) out.push(current); current = null; };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); out.push(''); continue; }
    if (current === null) { current = raw.replace(/\s+$/, ''); continue; }
    const width = widthOf(current.trim());
    const ends = (SENTENCE_END.test(current) && width < typical * 0.9) || width < typical * 0.5;
    if (ends || NEW_BLOCK.test(line)) { flush(); current = raw.replace(/\s+$/, ''); continue; }
    count();
    if (/[A-Za-z]-$/.test(current) && /^[a-z]/.test(line)) current = current.slice(0, -1) + line;
    else if (/[A-Za-z0-9,.;:!?)'"]$/.test(current) && /^[A-Za-z0-9(]/.test(line)) current += ' ' + line;
    else current += line;
  }
  flush();
  return out.join('\n');
}

const TO_FULL = { ',': '，', ';': '；', ':': '：', '?': '？', '!': '！' };

// Cleans text copied from AI answers, PDFs and web pages. Spaces are never
// added: the two space rules only take away ones Chinese text does not use.
// Answers the text and how many changes each rule made.
export function cleanText(text, options = {}) {
  const o = { ...CLEAN_DEFAULTS, ...options };
  let s = String(text ?? '').replace(/\r\n?/g, '\n');
  const counts = {};
  const counter = (rule) => () => { counts[rule] = (counts[rule] || 0) + 1; };
  const replace = (rule, pattern, replacement) => {
    s = s.replace(pattern, (...args) => {
      counter(rule)();
      return typeof replacement === 'function' ? replacement(...args) : replacement.replace(/\$(\d)/g, (m, n) => args[Number(n)] ?? '');
    });
  };
  const hanOrPunct = '\\p{Script=Han}' + escapeClass(CJK_PUNCT);

  if (o.invisible) {
    replace('invisible', /[​-‍⁠﻿­]/g, '');
    replace('invisible', / /g, ' ');
    replace('invisible', /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  }
  if (o.markdown) s = stripMarkdown(s, counter('markdown'));
  if (o.mergeLines) s = mergeBrokenLines(s, counter('mergeLines'));
  if (o.fullwidthAlnum) replace('fullwidthAlnum', /[０-９Ａ-Ｚａ-ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
  if (o.punctuation) {
    // Only in Chinese context: after a Chinese character or punctuation, or
    // around Chinese text in brackets and quotes. 1,000, 3.14 and URLs stay.
    replace('punctuation', new RegExp('([' + hanOrPunct + '])[ \\t]*\\.{3,}', 'gu'), '$1……');
    replace('punctuation', new RegExp('([' + hanOrPunct + '])[ \\t]*([,;:?!])', 'gu'), (m, before, mark) => before + TO_FULL[mark]);
    replace('punctuation', new RegExp('(\\p{Script=Han})\\.(?![\\w.])', 'gu'), '$1。');
    replace('punctuation', new RegExp('(?<![\\d])([,;?!])[ \\t]*(?=\\p{Script=Han})', 'gu'), (m, mark) => TO_FULL[mark]);
    replace('punctuation', /\(([^()\n]*\p{Script=Han}[^()\n]*)\)/gu, '（$1）');
    replace('punctuation', /"([^"\n]*\p{Script=Han}[^"\n]*)"/gu, '“$1”');
  }
  if (o.hanSpaces) {
    replace('hanSpaces', new RegExp('(\\p{Script=Han})[ \\t\\u3000]+(?=\\p{Script=Han})', 'gu'), '$1');
    replace('hanSpaces', new RegExp('[ \\t]+(?=[' + escapeClass(CLOSING) + '])', 'gu'), '');
    replace('hanSpaces', new RegExp('([' + escapeClass(CLOSING + OPENING) + '])[ \\t]+(?=\\S)', 'gu'), '$1');
  }
  if (o.mixedSpaces) {
    replace('mixedSpaces', new RegExp('(\\p{Script=Han})[ \\t]+(?=[A-Za-z0-9])', 'gu'), '$1');
    replace('mixedSpaces', new RegExp('([A-Za-z0-9%])[ \\t]+(?=\\p{Script=Han})', 'gu'), '$1');
  }
  if (o.repeatedPunct) replace('repeatedPunct', /([，、；：。！？])\1+/g, '$1');
  if (o.blankLines) {
    replace('blankLines', /[ \t]+$/gm, '');
    replace('blankLines', /\n{3,}/g, '\n\n');
    const trimmed = s.replace(/^\n+|\n+$/g, '');
    if (trimmed !== s) { counter('blankLines')(); s = trimmed; }
  }
  return { text: s, counts };
}

// ---------------------------------------------------------------------------
// 字数统计
// ---------------------------------------------------------------------------

const count = (text, pattern) => (text.match(pattern) || []).length;

// Full-width and Chinese punctuation (not the full-width space).
const CJK_PUNCT_CHARS = '\u3001-\u3003\u3008-\u3011\u3014-\u301F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\u2018\u2019\u201C\u201D\u2014\u2026\u00B7';

// Counts for Chinese writing, as Word counts 字数: each Chinese character and
// Chinese punctuation mark, plus each run of other characters between spaces
// that holds a letter or digit (an English word, 2026, v1.5) as one.
export function countText(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  const han = count(s, /\p{Script=Han}/gu);
  const cjkPunct = count(s, new RegExp('[' + CJK_PUNCT_CHARS + ']', 'g'));
  const other = '[^\\s\\p{Script=Han}' + CJK_PUNCT_CHARS + ']';
  const latin = count(s, new RegExp(other + '*[A-Za-z0-9]' + other + '*', 'gu'));
  const chars = [...s.replace(/\n/g, '')].length;
  const nonSpace = [...s.replace(/\s/g, '')].length;
  const lines = s ? s.split('\n').length : 0;
  const paragraphs = s.split('\n').filter((line) => line.trim()).length;
  return {
    words: han + cjkPunct + latin, han, cjkPunct, latin, chars, nonSpace, lines, paragraphs,
    bytes: new TextEncoder().encode(s).length,
    // About 400 characters or 200 English words a minute read silently;
    // about 240 characters or 130 words spoken (a speech, a report).
    readMinutes: han / 400 + latin / 200,
    speakMinutes: han / 240 + latin / 130,
  };
}

// ---------------------------------------------------------------------------
// 文本对比
// ---------------------------------------------------------------------------

// Myers' diff of two arrays of comparable keys: [['=', i, j] | ['-', i] | ['+', j]].
// null when the inputs differ in more than maxEdits places (too costly to trace).
export function diffSequences(a, b, maxEdits = 3000) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const n = endA - start;
  const m = endB - start;
  const middle = [];
  if (n === 0) for (let j = 0; j < m; j += 1) middle.push(['+', start + j]);
  else if (m === 0) for (let i = 0; i < n; i += 1) middle.push(['-', start + i]);
  else {
    const max = n + m;
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    let found = -1;
    for (let d = 0; d <= max && found < 0; d += 1) {
      if (d > maxEdits) return null;
      trace.push(v.slice(offset - d - 1, offset + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[start + x] === b[start + y]) { x += 1; y += 1; }
        v[offset + k] = x;
        if (x >= n && y >= m) { found = d; break; }
      }
    }
    let x = n;
    let y = m;
    for (let d = found; d > 0; d -= 1) {
      const snapshot = trace[d];
      const get = (k) => snapshot[k + d + 1];
      const k = x - y;
      const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
      const prevK = down ? k + 1 : k - 1;
      const prevX = get(prevK);
      const prevY = prevX - prevK;
      const fromX = down ? prevX : prevX + 1;
      const fromY = down ? prevY + 1 : prevY;
      while (x > fromX && y > fromY) { middle.push(['=', start + x - 1, start + y - 1]); x -= 1; y -= 1; }
      middle.push(down ? ['+', start + prevY] : ['-', start + prevX]);
      x = prevX;
      y = prevY;
    }
    while (x > 0 && y > 0) { middle.push(['=', start + x - 1, start + y - 1]); x -= 1; y -= 1; }
    middle.reverse();
  }
  const ops = [];
  for (let i = 0; i < start; i += 1) ops.push(['=', i, i]);
  ops.push(...middle);
  for (let i = endA, j = endB; i < a.length; i += 1, j += 1) ops.push(['=', i, j]);
  return ops;
}

// Chinese is compared character by character, English and numbers word by word.
const TOKEN = /\n|[ \t　 ]+|[A-Za-z0-9_]+(?:['’][A-Za-z]+)*|./gsu;
export const tokenize = (text) => String(text).match(TOKEN) || [];
const isSpace = (token) => /^\s+$/.test(token);
const isPunct = (token) => /^[\p{P}\p{S}]+$/u.test(token);
// Ignored spaces or punctuation take no part in the comparison at all.
function comparer({ ignoreWhitespace = false, ignorePunct = false, ignoreCase = false }) {
  return {
    keep: (token) => !(ignoreWhitespace && isSpace(token)) && !(ignorePunct && isPunct(token)),
    key: (token) => (ignoreCase ? token.toLowerCase() : token),
  };
}

// A shortest edit can read badly: 落到实处 → 按期落实 comes out as
// 【增：按期】落【删：到】实【删：处】. A single unchanged token (a character, a
// word, a space; never a line break) between two changes joins them, and in
// each changed stretch what was taken out comes before what was put in.
export function readableOps(ops, aTokens, bTokens) {
  let result = ops.slice();
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 1; i < result.length - 1; i += 1) {
      const op = result[i];
      if (op[0] !== '=' || result[i - 1][0] === '=' || result[i + 1][0] === '=') continue;
      if (aTokens[op[1]] === '\n') continue;
      result.splice(i, 1, ['-', op[1]], ['+', op[2]]);
      changed = true;
    }
  }
  const ordered = [];
  for (let i = 0; i < result.length;) {
    if (result[i][0] === '=') { ordered.push(result[i]); i += 1; continue; }
    let j = i;
    while (j < result.length && result[j][0] !== '=') j += 1;
    const stretch = result.slice(i, j);
    ordered.push(...stretch.filter((op) => op[0] === '-'), ...stretch.filter((op) => op[0] === '+'));
    i = j;
  }
  return ordered;
}

// One changed stretch, compared token by token. Answers the merged segments
// and each side's own, marked.
function diffChunk(left, right, compare) {
  const a = tokenize(left);
  const b = tokenize(right);
  const ia = [];
  const ib = [];
  a.forEach((token, index) => { if (compare.keep(token)) ia.push(index); });
  b.forEach((token, index) => { if (compare.keep(token)) ib.push(index); });
  const keptA = ia.map((index) => a[index]);
  const keptB = ib.map((index) => b[index]);
  const raw = diffSequences(keptA.map(compare.key), keptB.map(compare.key));
  const ops = raw && readableOps(raw, keptA, keptB);
  const deleted = new Set();
  const inserted = new Set();
  const deletedBefore = new Map();
  if (!ops) {
    // Too different to trace: all of it changed.
    a.forEach((token, index) => { if (compare.keep(token)) deleted.add(index); });
    b.forEach((token, index) => { if (compare.keep(token)) inserted.add(index); });
    deletedBefore.set(0, [...deleted]);
  } else {
    let position = 0;
    for (const op of ops) {
      if (op[0] === '=') position = op[2] + 1;
      else if (op[0] === '+') { inserted.add(ib[op[1]]); position = op[1] + 1; }
      else {
        deleted.add(ia[op[1]]);
        const list = deletedBefore.get(position) || [];
        list.push(ia[op[1]]);
        deletedBefore.set(position, list);
      }
    }
  }
  // Merged: the new text, with what was taken out shown where it was.
  const merged = [];
  const push = (list, type, text) => {
    if (!text) return;
    const last = list[list.length - 1];
    if (last && last.type === type) last.text += text;
    else list.push({ type, text });
  };
  let next = 0;
  for (let index = 0; index < b.length; index += 1) {
    while (next < ib.length && ib[next] < index) next += 1;
    if (next < ib.length && ib[next] === index && deletedBefore.has(next)) {
      for (const del of deletedBefore.get(next)) push(merged, 'del', a[del]);
      deletedBefore.delete(next);
    }
    push(merged, inserted.has(index) ? 'ins' : 'equal', b[index]);
  }
  for (const [, list] of [...deletedBefore].sort((x, y) => x[0] - y[0])) for (const del of list) push(merged, 'del', a[del]);
  const leftSegments = [];
  const rightSegments = [];
  a.forEach((token, index) => push(leftSegments, deleted.has(index) ? 'del' : 'equal', token));
  b.forEach((token, index) => push(rightSegments, inserted.has(index) ? 'ins' : 'equal', token));
  return { merged, left: leftSegments, right: rightSegments };
}

const linesOf = (text) => String(text).replace(/\r\n?/g, '\n').match(/[^\n]*\n|[^\n]+$/g) || [];
const visible = (text) => [...text.replace(/\s/g, '')].length;

// Compares two versions of a text: lines first, then the changed lines token
// by token. Answers merged segments (for one view), each side's segments (for
// two columns) and what changed.
export function diffText(before, after, options = {}) {
  const compare = comparer(options);
  const linesA = linesOf(before);
  const linesB = linesOf(after);
  const lineKey = (line) => tokenize(line).filter(compare.keep).map(compare.key).join('\u0001');
  const ops = diffSequences(linesA.map(lineKey), linesB.map(lineKey), 4000)
    || [...linesA.map((_, i) => ['-', i]), ...linesB.map((_, j) => ['+', j])];
  const merged = [];
  const left = [];
  const right = [];
  const append = (list, segments) => {
    for (const segment of segments) {
      const last = list[list.length - 1];
      if (last && last.type === segment.type) last.text += segment.text;
      else list.push({ ...segment });
    }
  };
  let pendingA = '';
  let pendingB = '';
  const flush = () => {
    if (!pendingA && !pendingB) return;
    const chunk = diffChunk(pendingA, pendingB, compare);
    append(merged, chunk.merged);
    append(left, chunk.left);
    append(right, chunk.right);
    pendingA = '';
    pendingB = '';
  };
  for (const op of ops) {
    if (op[0] === '=') {
      flush();
      append(merged, [{ type: 'equal', text: linesB[op[2]] }]);
      append(left, [{ type: 'equal', text: linesA[op[1]] }]);
      append(right, [{ type: 'equal', text: linesB[op[2]] }]);
    } else if (op[0] === '-') pendingA += linesA[op[1]];
    else pendingB += linesB[op[1]];
  }
  flush();
  let inserted = 0;
  let deleted = 0;
  let changes = 0;
  let inChange = false;
  for (const segment of merged) {
    if (segment.type === 'equal') {
      if (visible(segment.text)) inChange = false;
      continue;
    }
    if (segment.type === 'ins') inserted += visible(segment.text);
    else deleted += visible(segment.text);
    if (!inChange && visible(segment.text)) { changes += 1; inChange = true; }
  }
  return { merged, left, right, stats: { inserted, deleted, changes, same: inserted === 0 && deleted === 0 } };
}

// Long unchanged stretches folded to a few lines around each change.
export function foldUnchanged(segments, context = 2) {
  const out = [];
  segments.forEach((segment, index) => {
    if (segment.type !== 'equal') { out.push(segment); return; }
    const lines = segment.text.split('\n');
    const first = index === 0;
    const last = index === segments.length - 1;
    const keepHead = first ? 0 : context + 1;
    const keepTail = last ? 0 : context + 1;
    if (lines.length <= keepHead + keepTail + 1) { out.push(segment); return; }
    const head = lines.slice(0, keepHead).join('\n');
    const tail = lines.slice(lines.length - keepTail).join('\n');
    const hidden = lines.length - keepHead - keepTail;
    if (head) out.push({ type: 'equal', text: head + '\n' });
    out.push({ type: 'gap', lines: hidden });
    if (tail) out.push({ type: 'equal', text: tail });
  });
  return out;
}

// The comparison as plain text, for pasting into a message.
export const diffReport = (segments) => segments.map((segment) => segment.type === 'ins' ? '【增：' + segment.text + '】'
  : segment.type === 'del' ? '【删：' + segment.text + '】' : segment.type === 'gap' ? '\n……（' + segment.lines + ' 行未改动）……\n' : segment.text).join('');
