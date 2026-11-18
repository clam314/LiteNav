// Pure, dependency-free logic behind the toolbox. Nothing here touches the DOM,
// so every tool can be unit tested under Node.

/** An error that points at a place in the user's input. */
export class ToolError extends Error {
  constructor(message, { line, column, offset } = {}) {
    super(message);
    this.name = 'ToolError';
    this.line = line;
    this.column = column;
    this.offset = offset;
  }
}

/**
 * A number kept as its original text, so 64-bit IDs and literals like 1.50
 * survive formatting. `raw` is how the source wrote it; `json` is valid JSON.
 */
export class Num {
  constructor(raw, json = raw) {
    this.raw = raw;
    this.json = json;
  }
}

export const isMap = (value) => value instanceof Map;
const entriesOf = (value) => (isMap(value) ? [...value] : Object.entries(value));
const sizeOf = (value) => (Array.isArray(value) ? value.length : isMap(value) ? value.size : Object.keys(value).length);
const isCollection = (value) => Array.isArray(value) || isMap(value) || (value !== null && typeof value === 'object' && !(value instanceof Num));

export function positionAt(text, offset) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') { line++; column = 1; } else column++;
  }
  return { line, column };
}

export function offsetOfLine(text, line) {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return offset;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Strict JSON parser that reports the line and column of the first problem.
 * Objects become Maps (key order is kept exactly) and numbers become Num.
 */
export function parseJson(source) {
  const text = String(source).replace(/^﻿/, '');
  let i = 0;
  const duplicates = [];
  let nodes = 0;
  const fail = (message, at = i) => { throw new ToolError(message, { ...positionAt(text, at), offset: at }); };
  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };
  // A missing comma is usually noticed on the next line; point at the end of the previous one.
  const missingComma = (end, message) => {
    if (text.slice(end, i).includes('\n')) fail('这一行末尾缺少逗号', end);
    fail(message);
  };
  const unexpected = () => (i >= text.length ? '内容意外结束' : '意外的字符 ' + JSON.stringify(text[i]));

  function string() {
    const start = i;
    i++;
    let out = '';
    let chunk = i;
    for (;;) {
      if (i >= text.length) fail('字符串没有闭合，缺少结尾的双引号', start);
      const c = text[i];
      if (c === '"') { out += text.slice(chunk, i); i++; return out; }
      if (c === '\\') {
        out += text.slice(chunk, i);
        const e = text[i + 1];
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e in simple) { out += simple[e]; i += 2; }
        else if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('\\u 后面应跟 4 位十六进制数');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else fail('无效的转义字符 \\' + (e ?? ''));
        chunk = i;
        continue;
      }
      if (text.charCodeAt(i) < 0x20) fail(c === '\n' ? '字符串中不能直接换行，请使用 \\n' : '字符串中不能直接包含控制字符');
      i++;
    }
  }

  function value(depth) {
    if (depth > 500) fail('嵌套层级过深');
    ws();
    nodes++;
    const c = text[i];
    if (c === '{') return object(depth);
    if (c === '[') return array(depth);
    if (c === '"') return string();
    if (c === '-' || (c >= '0' && c <= '9')) {
      JSON_NUMBER.lastIndex = i;
      const match = JSON_NUMBER.exec(text);
      if (!match || match[0] === '-') fail('数字格式不正确');
      const end = i + match[0].length;
      if (/[0-9.eE+-]/.test(text[end] ?? '')) fail('数字格式不正确（不允许前导零或多余符号）');
      i = end;
      return new Num(match[0]);
    }
    for (const [word, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) { i += word.length; return result; }
    }
    if (c === "'") fail('JSON 字符串必须使用双引号');
    if (c === undefined) fail('内容意外结束，这里缺少一个值');
    if (c === '}' || c === ']') fail('多余的逗号，或这里缺少一个值');
    fail(unexpected() + '，这里应为一个值');
  }

  function object(depth) {
    i++;
    const map = new Map();
    ws();
    if (text[i] === '}') { i++; return map; }
    for (;;) {
      ws();
      if (text[i] !== '"') {
        if (text[i] === '}') fail('对象末尾多了一个逗号');
        if (i >= text.length) fail('对象没有闭合，缺少 }');
        fail(text[i] === "'" ? '键名必须使用双引号' : '键名必须是双引号包裹的字符串');
      }
      const keyAt = i;
      const key = string();
      if (map.has(key)) duplicates.push({ key, ...positionAt(text, keyAt) });
      ws();
      if (text[i] !== ':') fail('键名后面缺少冒号 :');
      i++;
      map.set(key, value(depth + 1));
      const end = i;
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return map; }
      if (i >= text.length) fail('对象没有闭合，缺少 }');
      missingComma(end, '缺少逗号，或对象缺少结尾的 }');
    }
  }

  function array(depth) {
    i++;
    const list = [];
    ws();
    if (text[i] === ']') { i++; return list; }
    for (;;) {
      list.push(value(depth + 1));
      const end = i;
      ws();
      if (text[i] === ',') {
        i++;
        ws();
        if (text[i] === ']') fail('数组末尾多了一个逗号');
        continue;
      }
      if (text[i] === ']') { i++; return list; }
      if (i >= text.length) fail('数组没有闭合，缺少 ]');
      missingComma(end, '缺少逗号，或数组缺少结尾的 ]');
    }
  }

  ws();
  if (i >= text.length) throw new ToolError('请输入 JSON 内容');
  const result = value(0);
  ws();
  if (i < text.length) fail('JSON 已经结束，后面还有多余内容');
  return { value: result, duplicates, nodes };
}

/** Serialize a value (Maps, Num, plain objects) as JSON. An empty indent minifies. */
export function stringifyJson(value, indent = '  ') {
  const nl = indent ? '\n' : '';
  const colon = indent ? ': ' : ':';
  const walk = (v, pad) => {
    if (v instanceof Num) return v.json;
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return JSON.stringify(v);
    const inner = pad + indent;
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      return '[' + nl + v.map((item) => inner + walk(item, inner)).join(',' + nl) + nl + pad + ']';
    }
    const entries = entriesOf(v);
    if (!entries.length) return '{}';
    return '{' + nl + entries.map(([key, item]) => inner + JSON.stringify(String(key)) + colon + walk(item, inner)).join(',' + nl) + nl + pad + '}';
  };
  return walk(value, '');
}

// ---------------------------------------------------------------------------
// YAML (the everyday subset: block maps and lists, flow collections, quoted
// and plain scalars, block scalars, comments and multiple documents)
// ---------------------------------------------------------------------------

const SEQ_ITEM = /^-(?:[ \t]|$)/;
const YAML_NULL = /^(?:null|Null|NULL|~|)$/;
const YAML_TRUE = /^(?:true|True|TRUE)$/;
const YAML_FALSE = /^(?:false|False|FALSE)$/;
const YAML_INT = /^[-+]?[0-9]+$/;
const YAML_HEX = /^0x[0-9a-fA-F]+$/;
const YAML_OCT = /^0o[0-7]+$/;
const YAML_FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const YAML_INF = /^[-+]?\.(?:inf|Inf|INF)$/;
const YAML_NAN = /^\.(?:nan|NaN|NAN)$/;
const JSON_NUMBER_FULL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Resolve a plain YAML scalar with the YAML 1.2 core schema. */
export function resolvePlain(raw) {
  if (YAML_NULL.test(raw)) return null;
  if (YAML_TRUE.test(raw)) return true;
  if (YAML_FALSE.test(raw)) return false;
  if (YAML_INT.test(raw)) return new Num(raw, raw.replace(/^\+/, '').replace(/^(-?)0+(?=\d)/, '$1'));
  if (YAML_HEX.test(raw) || YAML_OCT.test(raw)) return new Num(raw, BigInt(raw).toString());
  if (YAML_FLOAT.test(raw)) return new Num(raw, JSON_NUMBER_FULL.test(raw) ? raw : String(Number(raw)));
  if (YAML_INF.test(raw) || YAML_NAN.test(raw)) return new Num(raw, 'null');
  return raw;
}

const stripComment = (text) => {
  const match = /(^|\s)#/.exec(text);
  return (match ? text.slice(0, match.index) : text).trim();
};

function readQuoted(text, start, fail) {
  const quote = text[start];
  let i = start + 1;
  let out = '';
  while (i < text.length) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") {
        if (text[i + 1] === "'") { out += "'"; i += 2; continue; }
        return { value: out, end: i + 1 };
      }
      out += c;
      i++;
      continue;
    }
    if (c === '"') return { value: out, end: i + 1 };
    if (c === '\\') {
      const e = text[i + 1];
      const simple = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', 0: '\0', b: '\b', f: '\f', ' ': ' ', e: '\x1b', a: '\x07', v: '\v', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029', '\t': '\t' };
      if (e in simple) { out += simple[e]; i += 2; continue; }
      const length = { x: 2, u: 4, U: 8 }[e];
      if (length) {
        const hex = text.slice(i + 2, i + 2 + length);
        if (hex.length !== length || !/^[0-9a-fA-F]+$/.test(hex)) fail('转义字符格式不正确');
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 2 + length;
        continue;
      }
      fail('无效的转义字符 \\' + (e ?? ''));
    }
    out += c;
    i++;
  }
  fail('引号没有闭合（暂不支持跨行的引号字符串）');
}

function scanFlow(text) {
  // Returns { depth, cut }: bracket depth after the text, and where a comment starts.
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === '\\') { i++; continue; }
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") { i++; continue; }
        quote = '';
      }
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return { depth, cut: i };
  }
  return { depth, cut: text.length };
}

function parseFlowText(src, fail) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const plain = (isKey) => {
    const start = i;
    while (i < src.length) {
      const c = src[i];
      if (c === ',' || c === ']' || c === '}' || c === '[' || c === '{') break;
      if (c === ':' && (i + 1 >= src.length || /[\s,\]}]/.test(src[i + 1]))) break;
      i++;
    }
    const raw = src.slice(start, i).trim();
    if (!raw && !isKey) fail('流式集合中有空的元素，检查是否多写了逗号');
    return isKey ? raw : resolvePlain(raw);
  };
  const scalar = (isKey) => {
    if (src[i] === '"' || src[i] === "'") {
      const quoted = readQuoted(src, i, fail);
      i = quoted.end;
      return quoted.value;
    }
    return plain(isKey);
  };
  const value = (depth) => {
    if (depth > 200) fail('嵌套层级过深');
    ws();
    if (src[i] === '[') {
      i++;
      const list = [];
      ws();
      if (src[i] === ']') { i++; return list; }
      for (;;) {
        list.push(value(depth + 1));
        ws();
        if (src[i] === ',') { i++; ws(); if (src[i] === ']') { i++; return list; } continue; }
        if (src[i] === ']') { i++; return list; }
        fail('流式列表缺少逗号或结尾的 ]');
      }
    }
    if (src[i] === '{') {
      i++;
      const map = new Map();
      ws();
      if (src[i] === '}') { i++; return map; }
      for (;;) {
        ws();
        const key = String(scalar(true));
        ws();
        let item = null;
        if (src[i] === ':') { i++; ws(); item = src[i] === ',' || src[i] === '}' ? null : value(depth + 1); }
        if (map.has(key)) fail('重复的键「' + key + '」');
        map.set(key, item);
        ws();
        if (src[i] === ',') { i++; ws(); if (src[i] === '}') { i++; return map; } continue; }
        if (src[i] === '}') { i++; return map; }
        fail('流式映射缺少逗号或结尾的 }');
      }
    }
    return scalar(false);
  };
  const result = value(0);
  ws();
  if (i < src.length) fail('流式集合结束后还有多余内容');
  return result;
}

class YamlParser {
  constructor(lines, start, end, info) {
    this.lines = lines;
    this.i = start;
    this.end = end;
    this.info = info;
  }

  fail(message, index = this.i) {
    throw new ToolError(message, { line: Math.min(index, this.lines.length - 1) + 1 });
  }

  indentOf(text) {
    let n = 0;
    while (text.charCodeAt(n) === 32) n++;
    return n;
  }

  next() {
    while (this.i < this.end) {
      const text = this.lines[this.i];
      const trimmed = text.trim();
      if (!trimmed || trimmed[0] === '#') { this.i++; continue; }
      if (text[this.indentOf(text)] === '\t') this.fail('缩进不能使用 Tab，请改用空格');
      return this.i;
    }
    return -1;
  }

  mark(index, depth, rest) {
    const record = this.info[index];
    if (record) { record.rest = rest; return record; }
    this.info[index] = { kind: 'node', depth, dashes: 0, rest };
    return this.info[index];
  }

  splitKey(text, index) {
    if (text.startsWith('? ') || text === '?') this.fail('暂不支持复杂键（? 语法）', index);
    if (text[0] === '"' || text[0] === "'") {
      const quoted = readQuoted(text, 0, (message) => this.fail(message, index));
      const match = /^\s*:(?:\s|$)/.exec(text.slice(quoted.end));
      return match ? { key: quoted.value, rest: text.slice(quoted.end + match[0].length) } : null;
    }
    if (text[0] === '[' || text[0] === '{' || text[0] === '#') return null;
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (c === '#' && k > 0 && /\s/.test(text[k - 1])) return null;
      if (c === ':' && (k + 1 === text.length || /\s/.test(text[k + 1]))) {
        const key = text.slice(0, k).trim();
        if (!key) this.fail('键名不能为空', index);
        return { key, rest: text.slice(k + 1) };
      }
    }
    return null;
  }

  parseBlock(minIndent, depth) {
    const index = this.next();
    if (index < 0) return null;
    const line = this.lines[index];
    const indent = this.indentOf(line);
    if (indent < minIndent) return null;
    const text = line.slice(indent).trimEnd();
    if (SEQ_ITEM.test(text)) return this.parseSeq(indent, depth);
    if (this.splitKey(text, index)) return this.parseMap(indent, depth);
    this.mark(index, depth, text);
    this.i = index + 1;
    return this.parseValue(text, minIndent - 1, index, depth - 1, false);
  }

  parseMap(indent, depth) {
    const map = new Map();
    let first = true;
    for (;;) {
      const index = this.next();
      if (index < 0) break;
      const line = this.lines[index];
      const current = this.indentOf(line);
      if (current < indent) break;
      const text = line.slice(current).trimEnd();
      if (current > indent) this.fail('缩进不一致：这一行比同级的键多缩进了 ' + (current - indent) + ' 个空格', index);
      if (SEQ_ITEM.test(text)) this.fail('这里应为“键: 值”，不能直接出现列表项（检查缩进）', index);
      const pair = this.splitKey(text, index);
      if (!pair) this.fail('应为“键: 值”格式：缺少冒号，或冒号后缺少空格', index);
      if (map.has(pair.key)) this.fail('重复的键「' + pair.key + '」', index);
      const record = this.mark(index, depth, text);
      if (first && record.dashes) record.compact = true;
      first = false;
      this.i = index + 1;
      map.set(pair.key, this.parseValue(pair.rest, indent, index, depth, true));
    }
    return map;
  }

  parseSeq(indent, depth) {
    const list = [];
    for (;;) {
      const index = this.next();
      if (index < 0) break;
      const line = this.lines[index];
      const current = this.indentOf(line);
      if (current < indent) break;
      const text = line.slice(current).trimEnd();
      if (current > indent) this.fail('缩进不一致：列表项应与上一项对齐', index);
      if (!SEQ_ITEM.test(text)) break;
      const after = text.slice(1);
      const rest = after.trimStart();
      const gap = after.length - rest.length;
      const record = this.info[index];
      if (record) { record.dashes++; record.rest = rest; }
      else this.info[index] = { kind: 'node', depth, dashes: 1, rest };
      if (!rest || rest[0] === '#') {
        this.i = index + 1;
        list.push(this.child(indent, depth));
        continue;
      }
      if (SEQ_ITEM.test(rest) || this.splitKey(rest, index)) {
        const column = current + 1 + gap;
        this.lines[index] = ' '.repeat(column) + rest;
        this.i = index;
        list.push(SEQ_ITEM.test(rest) ? this.parseSeq(column, depth + 1) : this.parseMap(column, depth + 1));
        continue;
      }
      this.i = index + 1;
      list.push(this.parseValue(rest, indent, index, depth, false));
    }
    return list;
  }

  child(indent, depth) {
    const index = this.next();
    if (index < 0) return null;
    return this.indentOf(this.lines[index]) > indent ? this.parseBlock(indent + 1, depth + 1) : null;
  }

  parseValue(rest, indent, index, depth, inMap) {
    let text = rest.trim();
    let forceString = false;
    if (text[0] === '&' || text[0] === '*') this.fail('暂不支持锚点与别名（& 和 *）', index);
    if (text[0] === '!') {
      const match = /^(!\S*)(?:\s+|$)/.exec(text);
      if (match[1] === '!!str') forceString = true;
      else if (!['!!int', '!!float', '!!bool', '!!null', '!!map', '!!seq'].includes(match[1])) this.fail('暂不支持自定义标签 ' + match[1], index);
      text = text.slice(match[0].length);
    }
    if (!text || text[0] === '#') {
      const next = this.next();
      if (next < 0) return null;
      const line = this.lines[next];
      const current = this.indentOf(line);
      if (current > indent) return this.parseBlock(indent + 1, depth + 1);
      if (inMap && current === indent && SEQ_ITEM.test(line.slice(current))) return this.parseSeq(indent, depth + 1);
      return null;
    }
    if (SEQ_ITEM.test(text)) this.fail('列表项不能和键写在同一行，请换行并缩进', index);
    if (text[0] === '|' || text[0] === '>') return this.parseBlockScalar(text, indent, index, depth);
    if (text[0] === '[' || text[0] === '{') return this.parseFlow(text, index, depth);
    if (text[0] === '"' || text[0] === "'") {
      const quoted = readQuoted(text, 0, (message) => this.fail(message, index));
      const tail = text.slice(quoted.end).trim();
      if (tail && tail[0] !== '#') this.fail('引号字符串后面有多余内容', index);
      return quoted.value;
    }
    if (text[0] === '@' || text[0] === '`' || text[0] === '%') this.fail('值不能以 ' + text[0] + ' 开头，请用引号包裹', index);
    let value = stripComment(text);
    for (;;) {
      const next = this.next();
      if (next < 0) break;
      const line = this.lines[next];
      const current = this.indentOf(line);
      if (current <= indent) break;
      const continued = line.slice(current).trimEnd();
      if (SEQ_ITEM.test(continued) || this.splitKey(continued, next)) this.fail('缩进不一致：上一行已经写了值，这一行不应再缩进', next);
      this.info[next] = { kind: 'cont', depth: depth + 1, rest: continued };
      value += ' ' + stripComment(continued);
      this.i = next + 1;
    }
    if (/:(?:\s|$)/.test(value)) this.fail('值中出现了“: ”，请用引号包裹整个值', index);
    return forceString ? value : resolvePlain(value);
  }

  parseBlockScalar(header, indent, index, depth) {
    const match = /^([|>])(?:([1-9])([+-]?)|([+-])([1-9]?))?(?:\s+#.*)?$/.exec(header);
    if (!match) this.fail('块标量（| 或 >）的写法不正确', index);
    const style = match[1];
    const digit = match[2] || match[5];
    const chomp = match[3] || match[4] || '';
    if (digit) this.info[index].indicator = true;
    let contentIndent = digit ? indent + Number(digit) : 0;
    const body = [];
    let j = index + 1;
    for (; j < this.end; j++) {
      const line = this.lines[j];
      if (!line.trim()) { body.push({ index: j, text: '' }); continue; }
      const current = this.indentOf(line);
      if (!contentIndent) {
        if (current <= indent) break;
        contentIndent = current;
      }
      if (current < contentIndent) break;
      body.push({ index: j, text: line.slice(contentIndent) });
    }
    let trailing = 0;
    while (body.length && !body[body.length - 1].text) { body.pop(); trailing++; }
    this.i = j;
    for (const item of body) this.info[item.index] = { kind: 'block', depth: depth + 1, rest: item.text };
    const lines = body.map((item) => item.text);
    if (!lines.length) return chomp === '+' ? '\n'.repeat(trailing) : '';
    let value;
    if (style === '|') value = lines.join('\n');
    else {
      value = lines[0];
      for (let k = 1; k < lines.length; k++) {
        const line = lines[k];
        const previous = lines[k - 1];
        if (!line) value += '\n';
        else if (!previous) value += line;
        else if (/^\s/.test(line) || /^\s/.test(previous)) value += '\n' + line;
        else value += ' ' + line;
      }
    }
    if (chomp === '-') return value;
    if (chomp === '+') return value + '\n' + '\n'.repeat(trailing);
    return value + '\n';
  }

  parseFlow(text, index, depth) {
    let scan = scanFlow(text);
    let source = text.slice(0, scan.cut);
    let depthOpen = scan.depth;
    let j = index;
    while (depthOpen > 0) {
      j++;
      if (j >= this.end) this.fail('流式集合没有闭合，缺少 ] 或 }', index);
      const line = this.lines[j].trim();
      if (!line) continue;
      this.info[j] = { kind: 'cont', depth: depth + 1, rest: line };
      scan = scanFlow(line);
      source += ' ' + line.slice(0, scan.cut);
      depthOpen += scan.depth;
    }
    this.i = j + 1;
    return parseFlowText(source, (message) => this.fail(message, index));
  }
}

function yamlLines(text) {
  return String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
}

function splitDocuments(lines) {
  const docs = [];
  let start = 0;
  const significant = (from, to) => {
    for (let k = from; k < to; k++) {
      const trimmed = lines[k].trim();
      if (trimmed && trimmed[0] !== '#') return true;
    }
    return false;
  };
  for (let k = 0; k < lines.length; k++) {
    if (!/^(?:---|\.\.\.)(?:\s|$)/.test(lines[k])) continue;
    const after = lines[k].slice(3).trim();
    if (after && after[0] !== '#') throw new ToolError('暂不支持在文档分隔符 --- 的同一行书写内容', { line: k + 1 });
    if (significant(start, k)) docs.push([start, k]);
    start = k + 1;
  }
  if (significant(start, lines.length) || !docs.length) docs.push([start, lines.length]);
  return docs;
}

/** Parse YAML into values (one per document) plus the layout used by formatYaml. */
export function parseYaml(source) {
  const original = yamlLines(source);
  if (!original.some((line) => line.trim() && line.trim()[0] !== '#')) throw new ToolError('请输入 YAML 内容');
  const lines = [...original];
  const info = [];
  const documents = splitDocuments(lines).map(([start, end]) => {
    const parser = new YamlParser(lines, start, end, info);
    const value = parser.parseBlock(0, 0);
    const left = parser.next();
    if (left >= 0) {
      parser.fail(parser.indentOf(lines[left]) > 0 ? '缩进不一致：这一行无法与上文对齐' : '这一行无法与上文组成合法结构（检查缩进，或是否混用了列表和键值）', left);
    }
    return value;
  });
  return { documents, original, info };
}

/**
 * Re-indent YAML to a consistent width while keeping comments, quoting,
 * key order and every value exactly as written.
 */
export function formatYaml(source, { indent = 2 } = {}) {
  const { original, info, documents } = parseYaml(source);
  const pad = (depth) => ' '.repeat(Math.max(0, depth) * indent);
  const out = original.map((line, k) => {
    const record = info[k];
    if (!record) return null;
    if (record.kind === 'block') return record.rest ? pad(record.depth) + record.rest : '';
    if (record.kind === 'cont') return pad(record.depth) + record.rest;
    let rest = record.rest;
    if (record.indicator) rest = rest.replace(/([|>])(?:[1-9]([+-]?)|([+-])[1-9])/, (_, style, a = '', b = '') => style + (a || b) + indent);
    let prefix = pad(record.depth);
    for (let d = 0; d < record.dashes; d++) {
      const last = d === record.dashes - 1;
      prefix += '-' + (!last || record.compact ? ' '.repeat(indent - 1) : rest ? ' ' : '');
    }
    return prefix + rest;
  });
  for (let k = 0; k < out.length; k++) {
    if (out[k] !== null) continue;
    const trimmed = original[k].trim();
    if (!trimmed) { out[k] = ''; continue; }
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(original[k])) { out[k] = trimmed; continue; }
    let j = k + 1;
    while (j < out.length && info[j]?.kind !== 'node') j++;
    const leading = j < out.length ? /^ */.exec(out[j] ?? '')[0] : '';
    out[k] = leading + trimmed;
  }
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  return { text, documents };
}

const YAML_INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;
const YAML_RESERVED_KEY = /^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE)$/;

function yamlNeedsQuote(text, isKey) {
  if (text === '' || text !== text.trim()) return true;
  if (YAML_INDICATOR_START.test(text) && !/^-[^\s-]/.test(text) && !/^[?:][^\s]/.test(text)) return true;
  if (/:(?:\s|$)/.test(text) || /\s#/.test(text) || /[\x00-\x1f\x7f\u2028\u2029]/.test(text)) return true;
  if (/^(?:---|\.\.\.)/.test(text)) return true;
  if (isKey) return YAML_RESERVED_KEY.test(text);
  return resolvePlain(text) !== text;
}

function yamlQuote(text) {
  return !text.includes("'") && !/[\x00-\x1f\x7f\u2028\u2029]/.test(text) ? "'" + text + "'" : JSON.stringify(text);
}

/** Serialize values as block-style YAML. */
export function stringifyYaml(value, { indent = 2 } = {}) {
  const step = ' '.repeat(indent);
  const dash = '-' + ' '.repeat(indent - 1);
  const nonEmpty = (v) => isCollection(v) && sizeOf(v) > 0;
  const scalar = (v, childPad) => {
    if (v === null || v === undefined) return { inline: 'null' };
    if (v instanceof Num) return { inline: v.raw };
    if (typeof v === 'boolean') return { inline: String(v) };
    if (typeof v === 'number') return { inline: Number.isNaN(v) ? '.nan' : Number.isFinite(v) ? String(v) : v > 0 ? '.inf' : '-.inf' };
    if (Array.isArray(v)) return { inline: '[]' };
    if (isCollection(v)) return { inline: '{}' };
    const text = String(v);
    if (text.includes('\n') && !/[\x00-\x09\x0b-\x1f\x7f]/.test(text) && !/^[ \n]/.test(text)) {
      const chomp = text.endsWith('\n') ? (text.endsWith('\n\n') ? '+' : '') : '-';
      const body = chomp === '-' ? text : text.slice(0, -1);
      return { header: '|' + chomp, lines: body.split('\n').map((line) => (line ? childPad + line : '')) };
    }
    return { inline: yamlNeedsQuote(text, false) ? yamlQuote(text) : text };
  };
  const key = (k) => (yamlNeedsQuote(String(k), true) ? yamlQuote(String(k)) : String(k));
  const block = (v, pad) => {
    if (Array.isArray(v)) {
      return v.flatMap((item) => {
        if (nonEmpty(item)) {
          const lines = block(item, pad + step);
          lines[0] = pad + dash + lines[0].slice(pad.length + indent);
          return lines;
        }
        const s = scalar(item, pad + step);
        return s.header ? [pad + '- ' + s.header, ...s.lines] : [pad + '- ' + s.inline];
      });
    }
    return entriesOf(v).flatMap(([k, item]) => {
      if (nonEmpty(item)) return [pad + key(k) + ':', ...block(item, pad + step)];
      const s = scalar(item, pad + step);
      return s.header ? [pad + key(k) + ': ' + s.header, ...s.lines] : [pad + key(k) + ': ' + s.inline];
    });
  };
  if (nonEmpty(value)) return block(value, '').join('\n');
  const s = scalar(value, step);
  return s.header ? [s.header, ...s.lines].join('\n') : s.inline;
}

export function jsonToYaml(source, { indent = 2 } = {}) {
  const { value } = parseJson(source);
  return stringifyYaml(value, { indent });
}

export function yamlToJson(source, { indent = '  ' } = {}) {
  const { documents } = parseYaml(source);
  const value = documents.length > 1 ? documents : documents[0];
  return { text: stringifyJson(value, indent), documents: documents.length };
}

export function countNodes(value) {
  if (!isCollection(value)) return 1;
  let total = 1;
  for (const [, item] of Array.isArray(value) ? value.entries() : entriesOf(value)) total += countNodes(item);
  return total;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const SQL_KEYWORDS = new Set(`ADD ALL ALTER AND ANY AS ASC BETWEEN BY CASE CAST CHECK COLUMN CONSTRAINT CREATE CROSS
DATABASE DEFAULT DELETE DESC DISTINCT DROP ELSE END ESCAPE EXCEPT EXISTS EXPLAIN FALSE FETCH FIRST FOR FOREIGN FROM
FULL GROUP HAVING IF ILIKE IN INDEX INNER INSERT INTERSECT INTERVAL INTO IS JOIN LAST LATERAL LEFT LIKE LIMIT
NATURAL NOT NULL NULLS OFFSET ON OR ORDER OUTER OVER PARTITION PRIMARY RECURSIVE REFERENCES REGEXP RETURNING RIGHT
ROWS SELECT SET TABLE THEN TOP TRUE TRUNCATE UNION UNIQUE UPDATE USING VALUES VIEW WHEN WHERE WINDOW WITH`.split(/\s+/));
const SQL_FUNCTIONS = new Set(`ABS ARRAY_AGG AVG CEIL CEILING CHAR_LENGTH COALESCE CONCAT CONCAT_WS CONVERT COUNT
CURRENT_DATE CURRENT_TIMESTAMP DATE DATE_ADD DATE_FORMAT DATE_SUB DATEDIFF DENSE_RANK EXTRACT FLOOR FROM_UNIXTIME
GROUP_CONCAT IFNULL INSTR JSON_EXTRACT JSON_OBJECT LAG LEAD LENGTH LOCATE LOWER LTRIM MAX MIN NOW NULLIF NVL
POSITION RANK REPLACE ROUND ROW_NUMBER RTRIM STRING_AGG SUBSTR SUBSTRING SUM TIMESTAMPDIFF TO_CHAR TO_DATE TRIM
UNIX_TIMESTAMP UPPER`.split(/\s+/));
const SQL_PHRASES = [
  'GROUP BY', 'ORDER BY', 'PARTITION BY', 'INSERT INTO', 'DELETE FROM', 'UNION ALL', 'UNION DISTINCT',
  'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN',
  'INNER JOIN', 'CROSS JOIN', 'NATURAL JOIN', 'ON DUPLICATE KEY UPDATE', 'ON CONFLICT', 'IS NOT',
  'NOT IN', 'NOT LIKE', 'NOT EXISTS', 'NOT BETWEEN',
].map((phrase) => phrase.split(' '));
const SQL_LIST_CLAUSES = new Set(['SELECT', 'SET', 'GROUP BY', 'ORDER BY', 'VALUES', 'RETURNING', 'ON DUPLICATE KEY UPDATE', 'PARTITION BY', 'WITH']);
const SQL_CLAUSES = new Set(['FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT INTO', 'DELETE FROM', 'UPDATE', 'ON CONFLICT', 'WINDOW', 'FETCH']);
const SQL_SET_OPERATORS = new Set(['UNION', 'UNION ALL', 'UNION DISTINCT', 'INTERSECT', 'EXCEPT']);
const SQL_JOINS = new Set(['JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'INNER JOIN', 'CROSS JOIN', 'NATURAL JOIN', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN']);
const SQL_TOKEN = /(\s+)|(--[^\n]*)|(\/\*[\s\S]*?(?:\*\/|$))|('(?:[^'\\]|\\[\s\S]|'')*(?:'|$)|"(?:[^"\\]|\\[\s\S]|"")*(?:"|$)|`(?:[^`]|``)*(?:`|$))|(\d+(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_\u0080-￿][\w$\u0080-￿]*)|(::|<=>|<=|>=|<>|!=|\|\||->>|->|:=|[-+*/%=<>!~&|^])|([(),;.])|([@:$?][\w$]*)|([\s\S])/gy;
const SQL_TYPES = ['ws', 'line-comment', 'block-comment', 'string', 'number', 'word', 'operator', 'punct', 'param', 'other'];

export function tokenizeSql(sql) {
  const tokens = [];
  SQL_TOKEN.lastIndex = 0;
  let match;
  while (SQL_TOKEN.lastIndex < sql.length && (match = SQL_TOKEN.exec(sql))) {
    const group = match.findIndex((part, index) => index > 0 && part !== undefined);
    tokens.push({ type: SQL_TYPES[group - 1], value: match[0] });
  }
  return tokens;
}

function mergePhrases(tokens) {
  const out = [];
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.type === 'word') {
      const phrase = SQL_PHRASES.find((words) => words.every((word, offset) => tokens[k + offset]?.type === 'word' && tokens[k + offset].value.toUpperCase() === word));
      if (phrase) {
        out.push({ type: 'word', value: tokens.slice(k, k + phrase.length).map((item) => item.value).join(' '), phrase: true });
        k += phrase.length - 1;
        continue;
      }
    }
    out.push(token);
  }
  return out;
}

export function formatSql(sql, { uppercase = true, indent = '  ', minify = false } = {}) {
  const tokens = mergePhrases(tokenizeSql(String(sql)).filter((token) => token.type !== 'ws'));
  if (!tokens.length) return '';
  const upperOf = (token) => (token.type === 'word' ? token.value.toUpperCase().replace(/\s+/g, ' ') : token.value);
  const isKeyword = (token) => token?.type === 'word' && (token.phrase || SQL_KEYWORDS.has(upperOf(token)));
  const display = (token, next) => {
    if (token.type !== 'word' || !uppercase) return token.value;
    const upper = upperOf(token);
    return isKeyword(token) || (SQL_FUNCTIONS.has(upper) && next?.value === '(') ? upper : token.value;
  };
  let previous = null;
  let clause = '';
  const spaced = (token) => {
    if (!previous) return false;
    const value = token.value;
    if (value === ',' || value === ')' || value === ';' || value === '.' || value === '::') return false;
    if (previous.value === '(' || previous.value === '.' || previous.value === '::' || previous.unary) return false;
    if (value === '(') {
      if (previous.type === 'word') return !previous.fn && (isKeyword(previous) || clause === 'INSERT INTO');
      return previous.type !== 'param' && previous.value !== ')';
    }
    return true;
  };
  const markUnary = (token) => {
    if (token.type === 'operator' && (token.value === '-' || token.value === '+')) {
      token.unary = !previous || previous.type === 'operator' || previous.value === '(' || previous.value === ',' || (isKeyword(previous) && !['NULL', 'TRUE', 'FALSE', 'END'].includes(upperOf(previous)));
    }
  };

  if (minify) {
    let out = '';
    for (let k = 0; k < tokens.length; k++) {
      const token = tokens[k];
      markUnary(token);
      let text = token.type === 'line-comment' ? '/* ' + token.value.slice(2).trim() + ' */' : display(token, tokens[k + 1]);
      if (token.type === 'word' && token.phrase) text = text.replace(/\s+/g, ' ');
      out += (out && spaced(token) ? ' ' : '') + text;
      previous = token;
    }
    return out;
  }

  const lines = [];
  let line = { level: 0, text: '' };
  let level = 0;
  const parens = [];
  const cases = [];
  let between = false;
  let joined = false;
  const newline = (target) => {
    if (line.text) lines.push(line);
    line = { level: Math.max(0, target), text: '' };
  };
  const write = (text, token) => {
    if (line.text && spaced(token)) line.text += ' ';
    line.text += text;
    previous = token;
  };

  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    const upper = upperOf(token);
    const text = display(token, tokens[k + 1]);
    const inline = parens.length > 0 && parens[parens.length - 1].kind === 'inline';
    const openCase = cases[cases.length - 1];
    markUnary(token);

    const asValue = previous?.type === 'operator' || tokens[k + 1]?.value === '(' && upper === 'VALUES' && clause === 'ON DUPLICATE KEY UPDATE';
    if (asValue && tokens[k + 1]?.value === '(') token.fn = true;
    if (token.type === 'word' && !inline && !asValue) {
      if (SQL_LIST_CLAUSES.has(upper) || SQL_CLAUSES.has(upper)) {
        newline(level);
        write(text, token);
        clause = upper;
        joined = false;
        newline(level + 1);
        continue;
      }
      if (SQL_SET_OPERATORS.has(upper)) {
        newline(level);
        write(text, token);
        newline(level);
        continue;
      }
      if (SQL_JOINS.has(upper)) {
        newline(level + 1);
        write(text, token);
        joined = true;
        continue;
      }
      if ((upper === 'AND' || upper === 'OR') && !openCase) {
        if (between && upper === 'AND') { between = false; write(text, token); continue; }
        newline(level + (joined ? 2 : 1));
        write(text, token);
        continue;
      }
    }
    if (token.type === 'word') {
      if (upper === 'BETWEEN' || upper === 'NOT BETWEEN') between = true;
      if (upper === 'CASE') { cases.push({ level: line.level, broken: !inline }); write(text, token); continue; }
      if ((upper === 'WHEN' || upper === 'ELSE') && openCase?.broken) { newline(openCase.level + 1); write(text, token); continue; }
      if (upper === 'END' && openCase) {
        cases.pop();
        if (openCase.broken) newline(openCase.level);
        write(text, token);
        continue;
      }
    }
    if (token.value === '(') {
      const next = upperOf(tokens[k + 1] ?? { type: 'punct', value: '' });
      write('(', token);
      if (next === 'SELECT' || next === 'WITH') {
        parens.push({ kind: 'sub', level, clause, joined });
        joined = false;
        level = line.level + 1;
      } else parens.push({ kind: 'inline' });
      continue;
    }
    if (token.value === ')') {
      const open = parens.pop();
      if (open?.kind === 'sub') {
        newline(level - 1);
        level = open.level;
        clause = open.clause;
        joined = open.joined;
      }
      write(')', token);
      continue;
    }
    if (token.value === ',') {
      write(',', token);
      if (!inline && clause !== 'LIMIT') newline(level + 1);
      continue;
    }
    if (token.value === ';') {
      write(';', token);
      newline(0);
      lines.push({ level: 0, text: '' });
      level = 0;
      clause = '';
      parens.length = 0;
      cases.length = 0;
      previous = null;
      continue;
    }
    if (token.type === 'line-comment') {
      write(token.value.trimEnd(), token);
      newline(line.level);
      previous = null;
      continue;
    }
    write(text, token);
  }
  newline(0);
  while (lines.length && !lines[lines.length - 1].text) lines.pop();
  return lines.map((item) => (item.text ? indent.repeat(item.level) + item.text : '')).join('\n');
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

const MAX_TIME = 8.64e15;

/** Guess the unit of a numeric timestamp from its number of digits. */
export function detectTimestamp(input) {
  const text = String(input).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const digits = match[2].replace(/^0+(?=\d)/, '').length;
  let unit;
  let ms;
  const value = Number(text);
  if (digits <= 10) { unit = 'seconds'; ms = value * 1000; }
  else if (digits <= 13) { unit = 'milliseconds'; ms = value; }
  else if (digits <= 16) { unit = 'microseconds'; ms = value / 1000; }
  else if (digits <= 19) { unit = 'nanoseconds'; ms = value / 1e6; }
  else return { unit: 'unknown', ms: NaN };
  return { unit, ms: Math.round(ms) };
}

const partsCache = new Map();
function zoneFormatter(timeZone) {
  if (!partsCache.has(timeZone)) {
    partsCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return partsCache.get(timeZone);
}

function zoneParts(ms, timeZone) {
  const parts = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second) };
}

/** Offset of a time zone from UTC at a given instant, in minutes. */
export function zoneOffset(ms, timeZone) {
  const p = zoneParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Format an instant as YYYY-MM-DD HH:mm:ss (with .SSS when it has milliseconds). */
export function formatInZone(ms, timeZone) {
  const p = zoneParts(ms, timeZone);
  const millis = ((ms % 1000) + 1000) % 1000;
  const year = p.year < 0 ? '-' + String(-p.year).padStart(4, '0') : String(p.year).padStart(4, '0');
  return year + '-' + pad2(p.month) + '-' + pad2(p.day) + ' ' + pad2(p.hour) + ':' + pad2(p.minute) + ':' + pad2(p.second) + (millis ? '.' + String(millis).padStart(3, '0') : '');
}

/** Wall-clock components in a time zone to an instant. */
export function zonedToEpoch({ year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let result = guess - zoneOffset(guess, timeZone) * 60000;
  const corrected = guess - zoneOffset(result, timeZone) * 60000;
  if (corrected !== result) result = corrected;
  return result;
}

const DATE_INPUT = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Parse a typed date-time; without an explicit offset it is read in `timeZone`. */
export function parseDateInput(input, timeZone) {
  const text = String(input).trim().replace(/年|月/g, '-').replace(/日/g, ' ').replace(/时|点/g, ':').replace(/分/g, ':').replace(/秒/g, '').replace(/\s+/g, ' ').replace(/[-:]\s*$/, '').trim();
  const match = DATE_INPUT.exec(text);
  if (match) {
    const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', zone] = match;
    const parts = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(s), millisecond: Number((frac + '000').slice(0, 3)) };
    const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    if (parts.month < 1 || parts.month > 12 || check.getUTCDate() !== parts.day || parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
      throw new ToolError('日期或时间超出范围');
    }
    if (zone) {
      let offset = 0;
      if (/^[+-]/.test(zone)) {
        const digits = zone.replace(':', '');
        offset = (zone[0] === '-' ? -1 : 1) * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5) || 0));
      }
      return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond) - offset * 60000;
    }
    return zonedToEpoch(parts, timeZone);
  }
  const parsed = Date.parse(String(input).trim());
  if (Number.isNaN(parsed)) throw new ToolError('无法识别的日期格式，可以输入如 2026-03-09 12:00:00');
  return parsed;
}

/** Interpret input as either a timestamp or a date-time. */
export function convertTime(input, timeZone, now = Date.now()) {
  const text = String(input).trim();
  if (!text) return null;
  const detected = detectTimestamp(text);
  let ms;
  let source;
  if (detected) {
    if (detected.unit === 'unknown') throw new ToolError('数字太长，无法识别为时间戳');
    ms = detected.ms;
    source = detected.unit;
  } else {
    ms = parseDateInput(text, timeZone);
    source = 'date';
  }
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_TIME) throw new ToolError('时间超出可表示的范围');
  return {
    source,
    ms,
    seconds: Math.floor(ms / 1000),
    zoned: formatInZone(ms, timeZone),
    offset: formatOffset(zoneOffset(ms, timeZone)),
    utc: formatInZone(ms, 'UTC'),
    iso: new Date(ms).toISOString(),
    relative: relativeTime(ms, now),
  };
}

export function relativeTime(ms, now = Date.now()) {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 1000) return '就是现在';
  const units = [['year', 365 * 864e5], ['month', 30 * 864e5], ['day', 864e5], ['hour', 36e5], ['minute', 6e4], ['second', 1e3]];
  const [unit, size] = units.find(([, amount]) => abs >= amount);
  return new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }).format(Math.trunc(diff / size), unit);
}

// ---------------------------------------------------------------------------
// URL encoding
// ---------------------------------------------------------------------------

export function encodeUrl(text, { scope = 'component' } = {}) {
  try {
    return scope === 'uri' ? encodeURI(text) : encodeURIComponent(text);
  } catch {
    throw new ToolError('文本中包含无法编码的字符（不完整的代理对）');
  }
}

/** Decode percent-escapes; invalid byte runs are replaced instead of failing. */
export function decodeUrl(text, { plusAsSpace = false, charset = 'utf-8' } = {}) {
  const source = plusAsSpace ? String(text).replace(/\+/g, ' ') : String(text);
  let invalid = false;
  const strict = new TextDecoder(charset, { fatal: true });
  const lenient = new TextDecoder(charset);
  const decoded = source.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(run.slice(k * 3 + 1, k * 3 + 3), 16);
    try { return strict.decode(bytes); } catch { invalid = true; return lenient.decode(bytes); }
  });
  return { text: decoded, invalid };
}

/** Split the query of a URL (or a bare a=1&b=2 string) into decoded pairs. */
export function parseQuery(text, options = {}) {
  const source = String(text).trim();
  if (!source || /\s/.test(source)) return [];
  let query;
  const mark = source.indexOf('?');
  if (mark >= 0) query = source.slice(mark + 1);
  else if (/^[^/=&]+=/.test(source) && !/^[a-z][a-z0-9+.-]*:/i.test(source)) query = source;
  else return [];
  query = query.split('#')[0];
  return query.split('&').filter(Boolean).map((pair) => {
    const eq = pair.indexOf('=');
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    const value = eq >= 0 ? pair.slice(eq + 1) : '';
    return [decodeUrl(key, { plusAsSpace: true, ...options }).text, decodeUrl(value, { plusAsSpace: true, ...options }).text];
  });
}

// ---------------------------------------------------------------------------
// Line cleanup
// ---------------------------------------------------------------------------

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export function cleanLines(text, { trim = true, removeEmpty = true, dedupe = true, ignoreCase = false, sort = 'none', split = 'line' } = {}) {
  const source = String(text);
  let items = split === 'smart' ? source.split(/[\s,;，；、]+/) : source.split(/\r?\n/);
  if (source === '') items = [];
  const total = items.length;
  if (trim) items = items.map((item) => item.trim());
  let empty = 0;
  if (removeEmpty || split === 'smart') {
    const kept = items.filter((item) => item.trim() !== '');
    empty = items.length - kept.length;
    items = kept;
  }
  let duplicates = 0;
  if (dedupe) {
    const seen = new Set();
    const kept = [];
    for (const item of items) {
      const key = ignoreCase ? item.toLowerCase() : item;
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      kept.push(item);
    }
    items = kept;
  }
  if (sort === 'asc') items.sort(collator.compare);
  if (sort === 'desc') items.sort((a, b) => collator.compare(b, a));
  return { text: items.join('\n'), stats: { total, kept: items.length, empty, duplicates } };
}
