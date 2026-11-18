// The toolbox view: everyday data formatting and conversion utilities.
// Everything runs in the browser; nothing typed here is sent to the server.
import { icon } from './icons.js';
import * as core from './tools-core.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STORAGE_KEY = 'litenav.tools.v1';
const MAX_SAVED_INPUT = 200_000;

export const TOOLS = [
  { id: 'json', group: 'data', name: 'JSON 格式化', title: 'JSON 格式化与校验', icon: 'braces', desc: '美化或压缩 JSON，定位语法错误，树形视图可折叠浏览；超长整数不会丢失精度。' },
  { id: 'yaml', group: 'data', name: 'YAML 格式化', title: 'YAML 格式化与校验', icon: 'file', desc: '统一缩进并检查语法错误，注释、引号和原有写法保持不变，支持多文档。' },
  { id: 'sql', group: 'data', name: 'SQL 格式化', title: 'SQL 格式化与美化', icon: 'database', desc: '把日志里复制的单行 SQL 排成关键字大写、层次清晰的格式，也能压缩回一行。' },
  { id: 'convert', group: 'data', name: 'JSON ⇄ YAML', title: 'JSON ⇄ YAML 互转', icon: 'swap', desc: '双向转换 Kubernetes、Docker Compose 等配置；多文档 YAML 会转换为 JSON 数组。' },
  { id: 'time', group: 'util', name: '时间戳转换', title: '时间戳与日期转换', icon: 'clock', desc: '输入时间戳或日期，自动识别秒、毫秒、微秒级时间戳，并按所选时区换算。' },
  { id: 'url', group: 'util', name: 'URL 编解码', title: 'URL 编码与解码', icon: 'link', desc: '转换链接中的中文与特殊字符，并拆解查询参数，告别乱码。' },
  { id: 'text', group: 'util', name: '文本去重', title: '文本去重与空行清理', icon: 'filter', desc: '粘贴一批文本、IP 或 ID，一键去除重复项、首尾空格与空行，还可以排序。' },
];
const GROUPS = [['data', '数据处理'], ['util', '实用工具']];

const DEFAULTS = {
  json: { mode: 'pretty', indent: '2', view: 'text' },
  yaml: { indent: '2' },
  sql: { mode: 'pretty', indent: '2', uppercase: true },
  convert: { direction: 'json2yaml', indent: '2' },
  time: { zone: 'local' },
  url: { mode: 'decode', scope: 'component', plus: true, charset: 'utf-8' },
  text: { trim: true, removeEmpty: true, dedupe: true, ignoreCase: false, sort: 'none', split: 'line' },
};

const SAMPLES = {
  json: '{"id":9007199254740993,"name":"轻航 LiteNav","enabled":true,"tags":["导航","自建服务"],"owner":{"team":"infra","members":[{"name":"Ada","role":"admin"},{"name":"Lin","role":"viewer"}]},"retries":3,"timeout":1.50,"note":null}',
  yaml: '# 服务编排\nservices:\n    web:\n        image: nginx:1.27   # 前端\n        ports:\n        - "8080:80"\n        environment:\n              TZ: Asia/Shanghai\n              LOG_LEVEL: info\n    db:\n      image: postgres:16\n      volumes: [pgdata:/var/lib/postgresql/data]\nvolumes:\n    pgdata: {}\n',
  sql: "select u.id, u.name, count(o.id) as orders, sum(o.amount) total from users u left join orders o on o.user_id = u.id and o.status = 'paid' where u.created_at >= '2026-01-01' and u.city in ('上海', '杭州') group by u.id, u.name having count(o.id) > 3 order by total desc limit 20;",
  json2yaml: '{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","labels":{"app":"web"}},"spec":{"replicas":2,"selector":{"matchLabels":{"app":"web"}},"template":{"metadata":{"labels":{"app":"web"}},"spec":{"containers":[{"name":"web","image":"nginx:1.27","ports":[{"containerPort":80}],"args":["--port","8080"]}]}}}}',
  yaml2json: 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\n    restart: unless-stopped\n    healthcheck:\n      test: ["CMD", "curl", "-f", "http://localhost"]\n      interval: 30s\n',
  urlDecode: 'https://www.example.com/search?q=%E8%BD%BB%E8%88%AA%20LiteNav&lang=zh-CN&tags=%E5%AF%BC%E8%88%AA%2C%E5%B7%A5%E5%85%B7',
  urlEncode: 'https://www.example.com/search?q=轻航 LiteNav&tags=导航,工具',
  text: '192.168.1.10\n  192.168.1.2\n\n192.168.1.10\n10.0.0.8 \n\n192.168.1.2\n10.0.0.12\n',
};

const ZONES = [
  ['local', '本地时区'], ['UTC', 'UTC'], ['Asia/Shanghai', '北京 / 上海'], ['Asia/Tokyo', '东京'],
  ['Asia/Singapore', '新加坡'], ['Europe/London', '伦敦'], ['Europe/Berlin', '柏林'],
  ['America/New_York', '纽约'], ['America/Los_Angeles', '洛杉矶'],
];
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const zoneOf = (value) => (value === 'local' ? localZone() : value);

let state = loadState();
let saveTimer;
let runTimer;
let clockTimer;
let lastOutput = '';
let treeValues = [];
let notify = () => {};

function loadState() {
  const fresh = { last: 'json', inputs: {}, options: structuredClone(DEFAULTS) };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return fresh;
    for (const [tool, defaults] of Object.entries(DEFAULTS)) {
      const options = saved.options?.[tool] || {};
      for (const key of Object.keys(defaults)) {
        if (typeof options[key] === typeof defaults[key]) fresh.options[tool][key] = options[key];
      }
    }
    for (const [key, value] of Object.entries(saved.inputs || {})) if (typeof value === 'string') fresh.inputs[key] = value;
    if (TOOLS.some((tool) => tool.id === saved.last)) fresh.last = saved.last;
  } catch {
    // Storage may be unavailable (private mode); the toolbox still works.
  }
  return fresh;
}

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const inputs = Object.fromEntries(Object.entries(state.inputs).filter(([, value]) => value.length <= MAX_SAVED_INPUT));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, inputs }));
    } catch {
      // Ignore quota or privacy errors.
    }
  }, 300);
}

export function resolveTool(id) {
  return TOOLS.some((tool) => tool.id === id) ? id : state.last;
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

const seg = (name, value, options, label) => '<div class="seg" role="group" aria-label="' + esc(label) + '">' +
  options.map(([key, text]) => '<button type="button" class="seg-btn' + (key === value ? ' is-active' : '') + '" data-opt="' + name + '" data-value="' + esc(key) + '" aria-pressed="' + (key === value) + '">' + text + '</button>').join('') + '</div>';
const select = (name, value, options, label) => '<label class="tool-select"><span>' + label + '</span><select class="form-select" data-opt="' + name + '">' +
  options.map(([key, text]) => '<option value="' + esc(key) + '"' + (key === value ? ' selected' : '') + '>' + esc(text) + '</option>').join('') + '</select></label>';
const check = (name, value, label) => '<label class="tool-check"><input type="checkbox" data-opt="' + name + '"' + (value ? ' checked' : '') + '>' + label + '</label>';
const indentSelect = (value, tab = true) => select('indent', value, [['2', '2 空格'], ['4', '4 空格'], ...(tab ? [['tab', 'Tab']] : [])], '缩进');
const smallButton = (cmd, label, iconName) => '<button type="button" class="btn btn-ghost btn-small" data-cmd="' + cmd + '">' + (iconName ? icon(iconName, 14) : '') + label + '</button>';

function panes({ inputLabel, outputLabel, placeholder, outputTools = '' }) {
  return '<div class="tool-panes">' +
    '<div class="tool-pane"><div class="pane-head"><span class="pane-title">' + inputLabel + '</span><span class="pane-meta" data-input-meta></span></div>' +
    '<textarea class="code-area" data-input spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="' + esc(inputLabel) + '" placeholder="' + esc(placeholder) + '"></textarea></div>' +
    '<div class="tool-pane"><div class="pane-head"><span class="pane-title">' + outputLabel + '</span><span class="pane-tools">' + outputTools + smallButton('copy', '复制', 'copy') + '</span></div>' +
    '<div class="pane-output" data-output></div></div></div>' +
    '<div class="tool-status" data-status role="status" aria-live="polite"></div>';
}

function controls(inner) {
  return '<div class="tool-controls">' + inner + '<span class="tool-controls-spacer"></span>' + smallButton('sample', '示例') + smallButton('clear', '清空') + '</div>';
}

function bodyMarkup(id) {
  const o = state.options[id];
  switch (id) {
    case 'json':
      return controls(seg('mode', o.mode, [['pretty', '美化'], ['minify', '压缩']], '输出方式') + indentSelect(o.indent)) +
        panes({
          inputLabel: '输入 JSON', outputLabel: '结果', placeholder: '粘贴 JSON，自动校验并格式化',
          outputTools: seg('view', o.view, [['text', '文本'], ['tree', '树形']], '结果视图') +
            (o.view === 'tree' ? smallButton('expand', '全部展开') + smallButton('collapse', '全部折叠') : ''),
        });
    case 'yaml':
      return controls(indentSelect(o.indent, false) + '<span class="tool-hint">只调整缩进与列表对齐，注释和值的写法保持原样</span>') +
        panes({ inputLabel: '输入 YAML', outputLabel: '格式化结果', placeholder: '粘贴 YAML，自动检查语法并统一缩进' });
    case 'sql':
      return controls(seg('mode', o.mode, [['pretty', '美化'], ['minify', '压缩为一行']], '输出方式') + indentSelect(o.indent) + check('uppercase', o.uppercase, '关键字大写')) +
        panes({ inputLabel: '输入 SQL', outputLabel: '格式化结果', placeholder: '粘贴 SQL，例如从日志里复制的单行语句' });
    case 'convert': {
      const toYaml = o.direction === 'json2yaml';
      return controls(seg('direction', o.direction, [['json2yaml', 'JSON → YAML'], ['yaml2json', 'YAML → JSON']], '转换方向') +
        indentSelect(o.indent, !toYaml) + smallButton('swap', '结果作为输入并反向', 'swap')) +
        panes({ inputLabel: toYaml ? '输入 JSON' : '输入 YAML', outputLabel: toYaml ? 'YAML 结果' : 'JSON 结果', placeholder: toYaml ? '粘贴 JSON' : '粘贴 YAML' });
    }
    case 'url': {
      const decode = o.mode === 'decode';
      return controls(seg('mode', o.mode, [['decode', '解码'], ['encode', '编码']], '方向') +
        (decode
          ? check('plus', o.plus, '把 + 视为空格') + select('charset', o.charset, [['utf-8', 'UTF-8'], ['gbk', 'GBK']], '字符集')
          : select('scope', o.scope, [['component', '参数值（编码全部特殊字符）'], ['uri', '完整链接（保留 : / ? & =）']], '范围'))) +
        panes({ inputLabel: decode ? '输入编码后的文本' : '输入原始文本', outputLabel: decode ? '解码结果' : '编码结果', placeholder: decode ? '粘贴含 %E4%B8%AD 之类编码的链接或参数' : '输入含中文或特殊字符的链接或参数' }) +
        '<div data-after></div>';
    }
    case 'text':
      return controls(check('trim', o.trim, '去除首尾空格') + check('removeEmpty', o.removeEmpty, '删除空行') + check('dedupe', o.dedupe, '去除重复') +
        check('ignoreCase', o.ignoreCase, '忽略大小写') +
        select('split', o.split, [['line', '按行'], ['smart', '按空格 / 逗号 / 分号']], '拆分') +
        select('sort', o.sort, [['none', '保持原顺序'], ['asc', '升序'], ['desc', '降序']], '排序')) +
        panes({ inputLabel: '输入文本', outputLabel: '清理结果', placeholder: '每行一项，例如一批 IP、ID 或关键词' });
    case 'time':
      return '<div class="time-now" aria-label="当前时间">' +
        ['seconds', 'milliseconds', 'datetime'].map((key) => '<div class="now-item"><span class="now-label">' + ({ seconds: '当前秒级时间戳', milliseconds: '当前毫秒级时间戳', datetime: '当前时间' })[key] + '</span><code class="now-value" data-now="' + key + '"></code>' +
          '<button type="button" class="icon-button" data-cmd="copy-now" data-key="' + key + '" aria-label="复制' + ({ seconds: '秒级时间戳', milliseconds: '毫秒级时间戳', datetime: '当前时间' })[key] + '" title="复制">' + icon('copy', 15) + '</button></div>').join('') + '</div>' +
        '<div class="tool-controls">' + select('zone', o.zone, ZONES.map(([key, label]) => [key, key === 'local' ? label + '（' + localZone() + '）' : label + (key === 'UTC' ? '' : '（' + key + '）')]), '时区') +
        '<span class="tool-controls-spacer"></span>' + smallButton('now', '填入当前时间', 'clock') + smallButton('clear', '清空') + '</div>' +
        '<label class="sr-only" for="time-input">时间戳或日期</label><input id="time-input" class="form-input time-input" data-input spellcheck="false" autocomplete="off" placeholder="输入时间戳（如 1773028800）或日期（如 2026-03-09 12:00:00）">' +
        '<div class="time-results" data-output></div><div class="tool-status" data-status role="status" aria-live="polite"></div>';
    default:
      return '';
  }
}

export function toolsMarkup(id) {
  const tool = TOOLS.find((item) => item.id === id) || TOOLS[0];
  return '<div class="tools-view" data-tool="' + tool.id + '">' +
    '<nav class="tool-tabs" aria-label="工具列表">' + GROUPS.map(([group, label]) => '<div class="tool-tab-group"><span class="tool-tab-label">' + label + '</span><div class="tool-tab-list">' +
      TOOLS.filter((item) => item.group === group).map((item) => '<a href="#tools/' + item.id + '" class="tool-tab' + (item.id === tool.id ? ' active" aria-current="page' : '') + '">' + icon(item.icon, 16) + '<span>' + item.name + '</span></a>').join('') +
      '</div></div>').join('') + '</nav>' +
    '<section class="tool-card" aria-labelledby="tool-title"><header class="tool-head"><h2 id="tool-title">' + tool.title + '</h2><p>' + tool.desc + '</p></header>' +
    '<div data-tool-body>' + bodyMarkup(tool.id) + '</div></section>' +
    '<p class="tools-privacy">' + icon('check', 14) + '所有处理都在浏览器本地完成，内容不会上传到服务器。</p></div>';
}

// ---------------------------------------------------------------------------
// Running tools
// ---------------------------------------------------------------------------

const indentText = (value) => (value === 'tab' ? '\t' : ' '.repeat(Number(value) || 2));
const formatBytes = (text) => {
  const bytes = new TextEncoder().encode(text).length;
  return bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(2) + ' MB';
};
const describe = (value) => {
  if (Array.isArray(value)) return '数组（' + value.length + ' 项）';
  if (core.isMap(value)) return '对象（' + value.size + ' 个键）';
  return value instanceof core.Num ? '数字' : value === null ? 'null' : typeof value === 'string' ? '字符串' : '布尔值';
};

const runners = {
  json(source, o) {
    if (!source.trim()) return { idle: '粘贴 JSON 后会自动校验并格式化' };
    let parsed = core.parseJson(source);
    const notes = [];
    if (typeof parsed.value === 'string' && /^\s*[[{]/.test(parsed.value)) {
      try { parsed = core.parseJson(parsed.value); notes.push('输入是被转义成字符串的 JSON，已解析其中的内容'); } catch { /* keep the string */ }
    }
    for (const duplicate of parsed.duplicates.slice(0, 3)) notes.push('第 ' + duplicate.line + ' 行的键「' + duplicate.key + '」重复，以最后一次出现为准');
    const text = core.stringifyJson(parsed.value, o.mode === 'minify' ? '' : indentText(o.indent));
    return {
      text, tree: o.view === 'tree' ? parsed.value : undefined,
      status: { kind: notes.length ? 'warn' : 'ok', text: ['有效的 JSON · ' + describe(parsed.value) + ' · ' + parsed.nodes + ' 个节点 · ' + formatBytes(text), ...notes].join('；') },
    };
  },
  yaml(source, o) {
    if (!source.trim()) return { idle: '粘贴 YAML 后会自动检查语法并统一缩进' };
    const result = core.formatYaml(source, { indent: Number(o.indent) });
    return { text: result.text, status: { kind: 'ok', text: '有效的 YAML · ' + result.documents.length + ' 个文档 · 已统一为 ' + o.indent + ' 空格缩进' } };
  },
  sql(source, o) {
    if (!source.trim()) return { idle: '粘贴 SQL 后会自动排版' };
    const text = core.formatSql(source, { uppercase: o.uppercase, indent: indentText(o.indent), minify: o.mode === 'minify' });
    return { text, status: { kind: 'ok', text: (o.mode === 'minify' ? '已压缩为一行' : '已格式化') + (o.uppercase ? ' · 关键字已大写' : '') + ' · 字符串与注释内容保持不变' } };
  },
  convert(source, o) {
    if (!source.trim()) return { idle: o.direction === 'json2yaml' ? '粘贴 JSON 后会自动转换为 YAML' : '粘贴 YAML 后会自动转换为 JSON' };
    if (o.direction === 'json2yaml') return { text: core.jsonToYaml(source, { indent: o.indent === '4' ? 4 : 2 }), status: { kind: 'ok', text: 'JSON → YAML 转换完成' } };
    const result = core.yamlToJson(source, { indent: indentText(o.indent) });
    return { text: result.text, status: { kind: result.documents > 1 ? 'warn' : 'ok', text: 'YAML → JSON 转换完成' + (result.documents > 1 ? '；' + result.documents + ' 个文档已合并为 JSON 数组' : '') + ' · YAML 注释不会出现在 JSON 中' } };
  },
  url(source, o) {
    if (!source) return { idle: o.mode === 'decode' ? '粘贴编码后的链接，自动解码' : '输入文本，自动编码', params: [] };
    const params = core.parseQuery(source, { charset: o.charset });
    if (o.mode === 'encode') {
      const text = core.encodeUrl(source, { scope: o.scope });
      return { text, params, status: { kind: 'ok', text: '已编码 · ' + source.length + ' → ' + text.length + ' 个字符' } };
    }
    const result = core.decodeUrl(source, { plusAsSpace: o.plus, charset: o.charset });
    return {
      text: result.text, params,
      status: result.invalid
        ? { kind: 'warn', text: '部分编码不是有效的 ' + o.charset.toUpperCase() + '，已用 � 代替' + (o.charset === 'utf-8' ? '；如果是中文乱码，可以把字符集切换为 GBK 试试' : '') }
        : { kind: 'ok', text: source === result.text ? '没有需要解码的内容' : '已解码' },
    };
  },
  text(source, o) {
    if (!source) return { idle: '粘贴文本后会自动清理' };
    const { text, stats } = core.cleanLines(source, o);
    return { text, status: { kind: 'ok', text: '共 ' + stats.total + ' 项 → 保留 ' + stats.kept + ' 项 · 去除重复 ' + stats.duplicates + ' · 删除空项 ' + stats.empty } };
  },
  time(source, o) {
    if (!source.trim()) return { idle: '支持 10 位秒、13 位毫秒、16 位微秒时间戳，以及 2026-03-09 12:00:00、2026/3/9、ISO 8601 等日期' };
    const result = core.convertTime(source, zoneOf(o.zone));
    const unit = { seconds: '秒级时间戳', milliseconds: '毫秒级时间戳', microseconds: '微秒级时间戳', nanoseconds: '纳秒级时间戳', date: '日期时间（按 ' + zoneOf(o.zone) + ' 解读）' }[result.source];
    return {
      rows: [
        ['秒级时间戳', String(result.seconds)],
        ['毫秒级时间戳', String(result.ms)],
        [(o.zone === 'local' ? '本地时间' : zoneOf(o.zone) + ' 时间') + '（' + result.offset + '）', result.zoned],
        ['UTC 时间', result.utc],
        ['ISO 8601', result.iso],
        ['距离现在', result.relative],
      ],
      status: { kind: 'ok', text: '识别为' + unit },
    };
  },
};

function statusMarkup(status) {
  const iconName = { ok: 'check', warn: 'alert', error: 'alert' }[status.kind];
  return (iconName ? icon(iconName, 15) : '') + '<span>' + esc(status.text) + '</span>';
}

function setStatus(root, status) {
  const element = root.querySelector('[data-status]');
  if (!element) return;
  element.className = 'tool-status' + (status.kind ? ' is-' + status.kind : '');
  element.innerHTML = statusMarkup(status);
}

function excerpt(line, column) {
  const text = line ?? '';
  if (!column) return esc(text.length > 240 ? text.slice(0, 240) + '…' : text);
  let start = 0;
  let end = text.length;
  if (text.length > 160) { start = Math.max(0, column - 1 - 70); end = Math.min(text.length, column - 1 + 70); }
  const before = text.slice(start, column - 1);
  const at = text[column - 1] ?? ' ';
  const after = text.slice(column, end);
  return (start ? '…' : '') + esc(before) + '<mark class="err-mark">' + esc(at === ' ' ? ' ' : at) + '</mark>' + esc(after) + (end < text.length ? '…' : '');
}

function errorMarkup(error, source) {
  const where = error.line ? '第 ' + error.line + ' 行' + (error.column ? '，第 ' + error.column + ' 列' : '') + '：' : '';
  let code = '';
  if (error.line) {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const from = Math.max(1, error.line - 2);
    const to = Math.min(lines.length, error.line + 2);
    for (let n = from; n <= to; n++) {
      code += '<div class="err-row' + (n === error.line ? ' is-error' : '') + '"><span class="err-num">' + n + '</span><span class="err-code">' + (n === error.line ? excerpt(lines[n - 1], error.column) : excerpt(lines[n - 1])) + '</span></div>';
    }
  }
  return '<div class="tool-error" role="alert"><p class="tool-error-head">' + icon('alert', 16) + '<span>' + esc(where + error.message) + '</span></p>' +
    (code ? '<div class="err-excerpt">' + code + '</div><div><button type="button" class="btn btn-secondary btn-small" data-cmd="locate" data-line="' + error.line + '" data-column="' + (error.column || 1) + '">定位到输入</button></div>' : '') + '</div>';
}

function outputTextarea(container, text) {
  let area = container.querySelector('textarea[data-output-text]');
  if (!area) {
    container.innerHTML = '<textarea class="code-area" data-output-text readonly spellcheck="false" aria-label="结果"></textarea>';
    area = container.firstElementChild;
  }
  area.value = text;
}

function updateMeta(root, source) {
  const meta = root.querySelector('[data-input-meta]');
  if (meta) meta.textContent = source ? source.length.toLocaleString('zh-CN') + ' 字符 · ' + source.split('\n').length.toLocaleString('zh-CN') + ' 行' : '';
}

function run(root) {
  const view = root.querySelector('.tools-view');
  if (!view) return;
  const id = view.dataset.tool;
  const source = state.inputs[id] ?? '';
  const options = state.options[id];
  const output = view.querySelector('[data-output]');
  updateMeta(view, source);
  let result;
  try {
    result = runners[id](source, options);
  } catch (error) {
    if (!(error instanceof core.ToolError)) throw error;
    lastOutput = '';
    if (id === 'time') output.innerHTML = '';
    else output.innerHTML = errorMarkup(error, source);
    setStatus(view, { kind: 'error', text: (id === 'time' ? '' : '格式有误 · ') + error.message });
    renderParams(view, []);
    return;
  }
  if (result.idle) {
    lastOutput = '';
    output.innerHTML = id === 'time' ? '' : '<div class="pane-empty">结果会显示在这里</div>';
    setStatus(view, { text: result.idle });
    renderParams(view, result.params || []);
    return;
  }
  if (result.rows) {
    lastOutput = result.rows.map(([label, value]) => label + '：' + value).join('\n');
    output.innerHTML = result.rows.map(([label, value]) => '<div class="result-row"><span class="now-label">' + esc(label) + '</span><code class="result-value">' + esc(value) + '</code>' +
      '<button type="button" class="icon-button" data-cmd="copy-value" data-value="' + esc(value) + '" aria-label="复制' + esc(label) + '" title="复制">' + icon('copy', 15) + '</button></div>').join('');
  } else if (result.tree !== undefined) {
    lastOutput = result.text;
    output.innerHTML = treeMarkup(result.tree);
    output.querySelectorAll('.json-tree > details[open]').forEach(fillNode);
  } else {
    lastOutput = result.text;
    outputTextarea(output, result.text);
  }
  setStatus(view, result.status);
  renderParams(view, result.params || []);
}

function renderParams(view, params) {
  const container = view.querySelector('[data-after]');
  if (!container) return;
  container.innerHTML = params.length
    ? '<div class="params"><div class="params-head"><span class="pane-title">查询参数</span><span class="pane-meta">' + params.length + ' 个</span></div><table class="params-table"><thead><tr><th scope="col">参数名</th><th scope="col">值（已解码）</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>' +
      params.map(([key, value]) => '<tr><td><code>' + esc(key) + '</code></td><td><code>' + (value ? esc(value) : '<span class="muted">（空）</span>') + '</code></td><td><button type="button" class="icon-button" data-cmd="copy-value" data-value="' + esc(value) + '" aria-label="复制 ' + esc(key) + ' 的值" title="复制值">' + icon('copy', 14) + '</button></td></tr>').join('') +
      '</tbody></table></div>'
    : '';
}

// ---------------------------------------------------------------------------
// JSON tree (children are rendered lazily when a node is opened)
// ---------------------------------------------------------------------------

const TREE_OPEN_DEPTH = 2;
const isNode = (value) => Array.isArray(value) || core.isMap(value);

function scalarHtml(value) {
  if (value instanceof core.Num) return '<span class="jt-num">' + esc(value.json) + '</span>';
  if (value === null) return '<span class="jt-null">null</span>';
  if (typeof value === 'boolean') return '<span class="jt-bool">' + value + '</span>';
  return '<span class="jt-str">' + esc(JSON.stringify(value)) + '</span>';
}

function nodeHtml(key, value, last, depth) {
  const label = key === null ? '' : typeof key === 'number' ? '<span class="jt-index">' + key + '</span><span class="jt-punct">: </span>' : '<span class="jt-key">' + esc(JSON.stringify(key)) + '</span><span class="jt-punct">: </span>';
  const comma = last ? '' : '<span class="jt-punct">,</span>';
  if (!isNode(value)) return '<div class="jt-leaf">' + label + scalarHtml(value) + comma + '</div>';
  const isArray = Array.isArray(value);
  const size = isArray ? value.length : value.size;
  const [open, close] = isArray ? ['[', ']'] : ['{', '}'];
  if (!size) return '<div class="jt-leaf">' + label + '<span class="jt-punct">' + open + close + '</span>' + comma + '</div>';
  const id = treeValues.push(value) - 1;
  return '<details class="jt-node" data-node="' + id + '" data-depth="' + depth + '"' + (depth < TREE_OPEN_DEPTH ? ' open' : '') + '><summary>' + label + '<span class="jt-punct">' + open + '</span>' +
    '<span class="jt-summary">' + size + (isArray ? ' 项' : ' 个键') + '</span><span class="jt-closed">' + close + comma + '</span></summary>' +
    '<div class="jt-children"></div><div class="jt-end"><span class="jt-punct">' + close + '</span>' + comma + '</div></details>';
}

function treeMarkup(value) {
  treeValues = [];
  return '<div class="json-tree" role="tree" aria-label="JSON 树形视图">' + nodeHtml(null, value, true, 0) + '</div>';
}

function fillNode(details) {
  if (details.dataset.filled) return;
  const value = treeValues[Number(details.dataset.node)];
  if (!value) return;
  details.dataset.filled = 'true';
  const depth = Number(details.dataset.depth) + 1;
  const entries = Array.isArray(value) ? value.map((item, index) => [index, item]) : [...value];
  details.querySelector(':scope > .jt-children').innerHTML = entries.map(([key, item], index) => nodeHtml(key, item, index === entries.length - 1, depth)).join('');
  details.querySelectorAll(':scope > .jt-children > details[open]').forEach(fillNode);
}

function expandTree(view) {
  const tree = view.querySelector('.json-tree');
  if (!tree) return;
  let opened = 0;
  for (;;) {
    const closed = tree.querySelectorAll('details.jt-node:not([open])');
    if (!closed.length) break;
    for (const details of closed) { fillNode(details); details.open = true; opened++; }
    if (opened > 5000) { notify('节点太多，只展开了前 5000 个'); break; }
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

async function copyText(text) {
  if (!text) { notify('没有可复制的内容'); return; }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) { notify('复制失败，请手动选择内容复制'); return; }
  }
  notify('已复制到剪贴板');
}

function currentView() {
  return document.querySelector('.tools-view');
}

function rerenderBody(view) {
  const id = view.dataset.tool;
  view.querySelector('[data-tool-body]').innerHTML = bodyMarkup(id);
  hydrate(view.parentElement);
}

function setOption(view, name, value) {
  const id = view.dataset.tool;
  state.options[id][name] = value;
  saveState();
  rerenderBody(view);
}

function setInput(view, value) {
  state.inputs[view.dataset.tool] = value;
  const input = view.querySelector('[data-input]');
  if (input) input.value = value;
  saveState();
  run(view.parentElement);
}

function sampleFor(id) {
  const o = state.options[id];
  if (id === 'convert') return o.direction === 'json2yaml' ? SAMPLES.json2yaml : SAMPLES.yaml2json;
  if (id === 'url') return o.mode === 'decode' ? SAMPLES.urlDecode : SAMPLES.urlEncode;
  return SAMPLES[id] ?? '';
}

function locate(view, line, column) {
  const input = view.querySelector('[data-input]');
  const source = input.value;
  const offset = Math.min(source.length, core.offsetOfLine(source, line) + column - 1);
  input.focus();
  input.setSelectionRange(offset, Math.min(source.length, offset + 1));
  const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20;
  input.scrollTop = Math.max(0, (line - 4) * lineHeight);
}

function handleCommand(view, button) {
  const id = view.dataset.tool;
  switch (button.dataset.cmd) {
    case 'sample': setInput(view, sampleFor(id)); break;
    case 'clear': setInput(view, ''); view.querySelector('[data-input]')?.focus(); break;
    case 'copy': copyText(lastOutput); break;
    case 'copy-value': copyText(button.dataset.value); break;
    case 'copy-now': copyText(view.querySelector('[data-now="' + button.dataset.key + '"]')?.textContent); break;
    case 'now': setInput(view, String(Math.floor(Date.now() / 1000))); break;
    case 'locate': locate(view, Number(button.dataset.line), Number(button.dataset.column)); break;
    case 'expand': expandTree(view); break;
    case 'collapse':
      view.querySelectorAll('.json-tree details.jt-node').forEach((details) => { details.open = details.dataset.depth === '0'; });
      break;
    case 'swap': {
      const o = state.options.convert;
      const output = lastOutput;
      o.direction = o.direction === 'json2yaml' ? 'yaml2json' : 'json2yaml';
      if (o.direction === 'json2yaml' && o.indent === 'tab') o.indent = '2';
      if (output) state.inputs.convert = output;
      saveState();
      rerenderBody(view);
      break;
    }
  }
}

let bound = false;
function bindEvents() {
  if (bound) return;
  bound = true;
  document.addEventListener('input', (event) => {
    const input = event.target.closest?.('.tools-view [data-input]');
    if (!input) return;
    const view = input.closest('.tools-view');
    state.inputs[view.dataset.tool] = input.value;
    saveState();
    clearTimeout(runTimer);
    runTimer = setTimeout(() => run(view.parentElement), input.value.length > 50_000 ? 350 : 80);
  });
  document.addEventListener('click', (event) => {
    const view = event.target.closest?.('.tools-view');
    if (!view) return;
    const option = event.target.closest('button[data-opt]');
    if (option) { setOption(view, option.dataset.opt, option.dataset.value); return; }
    const command = event.target.closest('[data-cmd]');
    if (command) handleCommand(view, command);
  });
  document.addEventListener('change', (event) => {
    const control = event.target.closest?.('.tools-view [data-opt]');
    if (!control || control.tagName === 'BUTTON') return;
    setOption(control.closest('.tools-view'), control.dataset.opt, control.type === 'checkbox' ? control.checked : control.value);
  });
  // `toggle` does not bubble, so listen in the capture phase.
  document.addEventListener('toggle', (event) => {
    if (event.target.matches?.('.json-tree details.jt-node') && event.target.open) fillNode(event.target);
  }, true);
}

function tickClock(view) {
  const now = Date.now();
  const values = { seconds: String(Math.floor(now / 1000)), milliseconds: String(now), datetime: core.formatInZone(Math.floor(now / 1000) * 1000, zoneOf(state.options.time.zone)) };
  for (const [key, value] of Object.entries(values)) {
    const element = view.querySelector('[data-now="' + key + '"]');
    if (element) element.textContent = value;
  }
}

function hydrate(root) {
  const view = root.querySelector('.tools-view');
  if (!view) return;
  const id = view.dataset.tool;
  const input = view.querySelector('[data-input]');
  if (input) input.value = state.inputs[id] ?? '';
  clearInterval(clockTimer);
  if (id === 'time') {
    tickClock(view);
    clockTimer = setInterval(() => {
      if (!view.isConnected) { clearInterval(clockTimer); return; }
      tickClock(view);
    }, 250);
  }
  run(root);
}

/** Call after the toolbox markup is in the document. */
export function mountTools(root, { toast } = {}) {
  if (toast) notify = toast;
  bindEvents();
  const view = root.querySelector('.tools-view');
  if (!view) return;
  if (state.last !== view.dataset.tool) { state.last = view.dataset.tool; saveState(); }
  hydrate(root);
}
