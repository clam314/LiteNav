// The toolbox view: everyday data formatting and conversion utilities.
// Everything runs in the browser; nothing typed here is sent to the server.
import { icon } from './icons.js';
import * as core from './tools-core.js';
import * as gw from './gongwen-core.js';
import * as tt from './text-tools.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STORAGE_KEY = 'litenav.tools.v1';
const MAX_SAVED_INPUT = 200_000;

export const TOOLS = [
  { id: 'clean', group: 'text', name: '文本清洗', title: '文本清洗与格式规范', icon: 'wand', desc: '清理从 AI 回答、PDF 或网页复制来的文字：去掉 Markdown 符号和不可见字符，合并 PDF 断行，统一中文标点，删除多余空格（不会添加空格）。' },
  { id: 'count', group: 'text', name: '字数统计', title: '字数统计', icon: 'hash', desc: '按 Word 的口径统计字数，并给出汉字、标点、英文、段落和阅读时长；在文本里选中一段，可以单独看这一段的字数。' },
  { id: 'diff', group: 'text', name: '文本对比', title: '文本对比', icon: 'columns', desc: '对比两版文稿，中文逐字、英文逐词标出增删；可以忽略空格、标点或大小写，只看改动处。' },
  { id: 'json', group: 'data', name: 'JSON 格式化', title: 'JSON 格式化与校验', icon: 'braces', desc: '美化或压缩 JSON，定位语法错误，树形视图可折叠浏览；超长整数不会丢失精度。' },
  { id: 'yaml', group: 'data', name: 'YAML 格式化', title: 'YAML 格式化与校验', icon: 'file', desc: '统一缩进并检查语法错误，注释、引号和原有写法保持不变，支持多文档。' },
  { id: 'sql', group: 'data', name: 'SQL 格式化', title: 'SQL 格式化与美化', icon: 'database', desc: '把日志里复制的单行 SQL 排成关键字大写、层次清晰的格式，也能压缩回一行。' },
  { id: 'convert', group: 'data', name: 'JSON ⇄ YAML', title: 'JSON ⇄ YAML 互转', icon: 'swap', desc: '双向转换 Kubernetes、Docker Compose 等配置；多文档 YAML 会转换为 JSON 数组。' },
  { id: 'time', group: 'util', name: '时间戳转换', title: '时间戳与日期转换', icon: 'clock', desc: '输入时间戳或日期，自动识别秒、毫秒、微秒级时间戳，并按所选时区换算。' },
  { id: 'url', group: 'util', name: 'URL 编解码', title: 'URL 编码与解码', icon: 'link', desc: '转换链接中的中文与特殊字符，并拆解查询参数，告别乱码。' },
  { id: 'text', group: 'text', name: '文本去重', title: '文本去重与空行清理', icon: 'filter', desc: '粘贴一批文本、IP 或 ID，一键去除重复项、首尾空格与空行，还可以排序。' },
  { id: 'gongwen', group: 'text', name: '汇报排版', title: '汇报文档格式排版', icon: 'gongwen', desc: '上传 Word（.docx）文档或粘贴文稿，统一 A4 版心、标题层级、仿宋/楷体/小标宋与表格样式，支持“一是”至“十是”加粗、Times 西文中文标点保护与未闭合引号检测。' },
];
const GROUPS = [['text', '文本与文档'], ['data', '数据处理'], ['util', '实用工具']];

const DEFAULTS = {
  json: { mode: 'pretty', indent: '2', view: 'text' },
  yaml: { indent: '2' },
  sql: { mode: 'pretty', indent: '2', uppercase: true },
  convert: { direction: 'json2yaml', indent: '2' },
  time: { zone: 'local' },
  url: { mode: 'decode', scope: 'component', plus: true, charset: 'utf-8' },
  text: { trim: true, removeEmpty: true, dedupe: true, ignoreCase: false, sort: 'none', split: 'line' },
  clean: { ...tt.CLEAN_DEFAULTS },
  count: {},
  diff: { view: 'merged', ignoreWhitespace: false, ignorePunct: false, ignoreCase: false, changedOnly: false },
  gongwen: { ...gw.DEFAULT_GONGWEN_OPTIONS },
};

const SAMPLES = {
  json: '{"id":9007199254740993,"name":"轻航 LiteNav","enabled":true,"tags":["导航","自建服务"],"owner":{"team":"infra","members":[{"name":"Ada","role":"admin"},{"name":"Lin","role":"viewer"}]},"retries":3,"timeout":1.50,"note":null}',
  yaml: '# 服务编排\nservices:\n    web:\n        image: nginx:1.27   # 前端\n        ports:\n        - "8080:80"\n        environment:\n              TZ: Asia/Shanghai\n              LOG_LEVEL: info\n    db:\n      image: postgres:16\n      volumes: [pgdata:/var/lib/postgresql/data]\nvolumes:\n    pgdata: {}\n',
  sql: "select u.id, u.name, count(o.id) as orders, sum(o.amount) total from users u left join orders o on o.user_id = u.id and o.status = 'paid' where u.created_at >= '2026-01-01' and u.city in ('上海', '杭州') group by u.id, u.name having count(o.id) > 3 order by total desc limit 20;",
  json2yaml: '{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","labels":{"app":"web"}},"spec":{"replicas":2,"selector":{"matchLabels":{"app":"web"}},"template":{"metadata":{"labels":{"app":"web"}},"spec":{"containers":[{"name":"web","image":"nginx:1.27","ports":[{"containerPort":80}],"args":["--port","8080"]}]}}}}',
  yaml2json: 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\n    restart: unless-stopped\n    healthcheck:\n      test: ["CMD", "curl", "-f", "http://localhost"]\n      interval: 30s\n',
  urlDecode: 'https://www.example.com/search?q=%E8%BD%BB%E8%88%AA%20LiteNav&lang=zh-CN&tags=%E5%AF%BC%E8%88%AA%2C%E5%B7%A5%E5%85%B7',
  urlEncode: 'https://www.example.com/search?q=轻航 LiteNav&tags=导航,工具',
  clean: '## 关于 2026 年工作计划的说明\n\n**一、总体目标**\n\n今年要 完成 30 个项目,覆盖 5 个城市;重点推进 AI 应用落地.\n- 提升服务效率（目标:提高 20%）\n- 建设 统一平台 ,实现数据共享。。\n\n\n(注:具体安排以"正式通知"为准)\u200b\n',
  count: '轻航 LiteNav 是一个轻量的个人导航页。2026 年发布的 v1.5 版本，新增了回收站、最近使用和文本处理工具。\n\n所有处理都在浏览器本地完成，内容不会上传到服务器。',
  diffA: '各单位要高度重视，认真组织实施，确保各项任务落到实处。\n请于11月30日前将工作总结报送办公室。\n联系人：张三，电话：12345678。',
  diffB: '各单位要高度重视，精心组织实施，确保各项任务按期落实。\n请于12月5日前将书面工作总结报送办公室。\n联系人：张三，电话：12345678。',
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
let gwLoadSeq = 0;
const gwState = {
  mode: 'structure',
  sourceKind: null,
  session: null,
  overrides: {},
  formatted: null,
  error: null,
  busy: false,
  showGuides: true,
  activeBlockId: null,
};

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
    if (fresh.options.gongwen.tableFormat === 'tidy') fresh.options.gongwen.tableFormat = 'elegant';
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
    case 'clean':
      return controls(tt.CLEAN_RULES.map(([key, label]) => check(key, o[key], label)).join('')) +
        panes({ inputLabel: '原文', outputLabel: '清洗结果', placeholder: '粘贴从 AI 回答、PDF 或网页复制的文字，自动清洗' });
    case 'count':
      return controls('<span class="tool-hint">在左侧选中一段文字，可以单独统计这一段</span>') +
        panes({ inputLabel: '文本', outputLabel: '统计结果', placeholder: '粘贴或输入文字，实时统计字数' });
    case 'diff': {
      const area = (side, label, placeholder) => '<div class="tool-pane"><div class="pane-head"><span class="pane-title">' + label + '</span><span class="pane-meta" data-input-meta="' + side + '"></span></div>' +
        '<textarea class="code-area" data-input="' + side + '" spellcheck="false" autocomplete="off" aria-label="' + label + '" placeholder="' + placeholder + '"></textarea></div>';
      return controls(seg('view', o.view, [['merged', '合并显示'], ['split', '左右对照']], '显示方式') + check('ignoreWhitespace', o.ignoreWhitespace, '忽略空格') +
        check('ignorePunct', o.ignorePunct, '忽略标点') + check('ignoreCase', o.ignoreCase, '忽略大小写') + check('changedOnly', o.changedOnly, '只看改动处') + smallButton('diff-swap', '交换', 'swap')) +
        '<div class="tool-panes diff-inputs">' + area('a', '原文', '粘贴修改前的文字') + area('b', '修改后', '粘贴修改后的文字') + '</div>' +
        '<div class="tool-pane diff-result"><div class="pane-head"><span class="pane-title">对比结果</span><span class="pane-tools">' + smallButton('copy', '复制', 'copy') + '</span></div><div class="diff-output" data-output></div></div>' +
        '<div class="tool-status" data-status role="status" aria-live="polite"></div>';
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
    case 'gongwen': {
      const chip = (name, value, label) => '<label class="gw-chip' + (value ? ' is-on' : '') + '"><input type="checkbox" data-opt="' + name + '"' + (value ? ' checked' : '') + '>' + icon('check', 13) + '<span>' + label + '</span></label>';
      return '<input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" data-gw-file hidden>' +
        '<div class="gw-toolbar">' +
        '<div class="tool-controls gw-controls-main">' +
        select('fontPreset', o.fontPreset, [
          ['standard', '标准公文（方正小标宋 / 仿宋 / 楷体）'],
          ['gb2312', '传统 GB2312（小标宋 / 仿宋_GB2312）'],
          ['universal', '免装字库（华文中宋 / 仿宋 / 楷体）'],
        ], '字体') +
        select('latinFont', o.latinFont, [
          ['times', 'Times New Roman（保护中文标点）'],
          ['match', '跟随中文字体'],
        ], '西文数字') +
        select('lineSpacing', o.lineSpacing, [['28', '固定值 28 磅'], ['29', '固定值 29 磅'], ['30', '固定值 30 磅']], '行距') +
        select('tableFormat', o.tableFormat, [
          ['elegant', '雅灰表头（去深色填充）'],
          ['three', '公文三线表'],
          ['clean', '纯白细框表'],
          ['keep', '保持原表样'],
        ], '表格') +
        select('pageNumber', o.pageNumber, [['center', '底端居中（— 1 —）'], ['mirror', '奇偶页（国标双面）'], ['keep', '保持原样']], '页码') +
        '<span class="tool-controls-spacer"></span>' +
        smallButton('gw-upload', '上传 .docx', 'upload') + smallButton('sample', '示例') + smallButton('clear', '清空') + '</div>' +
        '<div class="gw-chip-bar" role="group" aria-label="细节优化开关">' +
        chip('h3Bold', o.h3Bold, '三级标题加粗') +
        chip('boldSeq', o.boldSeq, '“一是”至“十是”加粗') +
        chip('smartQuotes', o.smartQuotes, '直引号转弯引号 & 闭合检测') +
        chip('cleanText', o.cleanText, '清理空格、空行与序号') +
        '<span class="tool-controls-spacer"></span>' +
        '<button type="button" class="gw-guide-btn' + (gwState.showGuides ? ' is-on' : '') + '" data-cmd="gw-guides" aria-pressed="' + gwState.showGuides + '">版心参考线</button>' +
        '</div></div>' +
        '<div data-gw-banner></div>' +
        '<div class="tool-panes">' +
        '<div class="tool-pane"><div class="pane-head"><span class="pane-title">文档与段落角色</span><span class="pane-tools">' +
        '<span data-gw-reset-slot></span>' +
        '<div class="seg" role="group" aria-label="输入方式">' +
        [['structure', '结构微调'], ['text', '粘贴文稿']].map(([key, label]) => '<button type="button" class="seg-btn' + (gwState.mode === key ? ' is-active' : '') + '" data-cmd="gw-mode" data-mode="' + key + '" aria-pressed="' + (gwState.mode === key) + '">' + label + '</button>').join('') +
        '</div></span></div><div class="pane-output" data-gw-left></div></div>' +
        '<div class="tool-pane"><div class="pane-head"><span class="pane-title">A4 版式预览</span><span class="pane-tools">' +
        smallButton('copy', '复制文本', 'copy') +
        '<button type="button" class="btn btn-primary btn-small" data-cmd="gw-download" disabled>' + icon('download', 14) + '下载 .docx</button>' +
        '</span></div><div class="pane-output" data-output></div></div></div>' +
        '<div class="tool-status" data-status role="status" aria-live="polite"></div>';
    }
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
const formatSize = (bytes) => (bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(2) + ' MB');
const formatBytes = (text) => formatSize(new TextEncoder().encode(text).length);
const describe = (value) => {
  if (Array.isArray(value)) return '数组（' + value.length + ' 项）';
  if (core.isMap(value)) return '对象（' + value.size + ' 个键）';
  return value instanceof core.Num ? '数字' : value === null ? 'null' : typeof value === 'string' ? '字符串' : '布尔值';
};

const CLEAN_NOTES = { invisible: '不可见字符', markdown: 'Markdown 符号', mergeLines: '断行', punctuation: '标点', fullwidthAlnum: '全角字母数字', hanSpaces: '空格', mixedSpaces: '空格', repeatedPunct: '重复标点', blankLines: '空行' };
const minutes = (value) => (value < 0.5 ? '不到 1 分钟' : '约 ' + Math.max(1, Math.round(value)) + ' 分钟');
const segmentsHtml = (segments) => segments.map((segment) => segment.type === 'gap'
  ? '<span class="diff-gap">…… ' + segment.lines + ' 行未改动 ……</span>'
  : segment.type === 'equal' ? esc(segment.text) : '<' + segment.type + '>' + esc(segment.text) + '</' + segment.type + '>').join('');

const runners = {
  clean(source, o) {
    if (!source) return { idle: '粘贴文字后会按勾选的规则自动清洗' };
    const { text, counts } = tt.cleanText(source, o);
    const notes = new Map();
    for (const [rule, times] of Object.entries(counts)) notes.set(CLEAN_NOTES[rule], (notes.get(CLEAN_NOTES[rule]) || 0) + times);
    return { text, status: notes.size ? { kind: 'ok', text: '已清洗：' + [...notes].map(([label, times]) => label + ' ' + times + ' 处').join(' · ') } : { kind: 'ok', text: '没有需要清洗的内容' } };
  },
  count(source) {
    if (!source) return { idle: '输入文字后实时统计' };
    const c = tt.countText(source);
    const items = [
      ['字数', c.words, '按 Word 的口径：汉字和中文标点各算一个，英文单词、数字各算一个', true],
      ['汉字', c.han, '不含标点'], ['中文标点', c.cjkPunct], ['英文单词和数字', c.latin],
      ['字符（不含空格）', c.nonSpace], ['字符（含空格）', c.chars], ['段落', c.paragraphs], ['行数', c.lines],
    ];
    const html = '<div class="count-results"><div class="count-grid">' + items.map(([label, value, hint, main]) => '<div class="count-item' + (main ? ' is-main' : '') + '"' + (hint ? ' title="' + esc(hint) + '"' : '') + '><span class="count-label">' + label + '</span><span class="count-value">' + value.toLocaleString('zh-CN') + '</span></div>').join('') + '</div>' +
      '<p class="count-note">阅读' + minutes(c.readMinutes) + '，朗读或发言' + minutes(c.speakMinutes) + ' · ' + formatSize(c.bytes) + '（UTF-8）</p></div>';
    return { html, copy: items.map(([label, value]) => label + '：' + value).join('\n'), status: { kind: 'ok', text: '字数按 Word 的口径统计；征文、公文要求的“字数”通常就是这个数' } };
  },
  diff(source, o) {
    if (!source.a && !source.b) return { idle: '在上面两栏分别粘贴修改前后的文字，自动标出差异' };
    const result = tt.diffText(source.a, source.b, o);
    const ignored = [o.ignoreWhitespace && '空格', o.ignorePunct && '标点', o.ignoreCase && '大小写'].filter(Boolean);
    if (result.stats.same) {
      return { html: '<div class="pane-empty">' + (ignored.length ? '忽略' + ignored.join('、') + '后，两段文字相同' : '两段文字完全相同') + '</div>', copy: '', status: { kind: 'ok', text: '没有差异' } };
    }
    const merged = o.changedOnly ? tt.foldUnchanged(result.merged) : result.merged;
    const html = o.view === 'split'
      ? '<div class="diff-split"><div class="diff-text">' + segmentsHtml(result.left) + '</div><div class="diff-text">' + segmentsHtml(result.right) + '</div></div>'
      : '<div class="diff-text">' + segmentsHtml(merged) + '</div>';
    const { inserted, deleted, changes } = result.stats;
    return { html, copy: tt.diffReport(merged), status: { kind: 'ok', text: changes + ' 处改动 · 新增 ' + inserted + ' 字 · 删除 ' + deleted + ' 字' + (ignored.length ? ' · 已忽略' + ignored.join('、') : '') } };
  },
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

function updateMeta(root, source, side = '') {
  const meta = root.querySelector(side ? '[data-input-meta="' + side + '"]' : '[data-input-meta]');
  if (meta) meta.textContent = source ? source.length.toLocaleString('zh-CN') + ' 字符 · ' + source.split('\n').length.toLocaleString('zh-CN') + ' 行' : '';
}

function renderTokensHtml(tokens, fallbackText) {
  if (!tokens || !tokens.length) return esc(fallbackText ?? '').replace(/\n/g, '<br>');
  return tokens.map((token) => (
    token.seq
      ? '<strong class="gw-seq-bold">' + esc(token.text) + '</strong>'
      : esc(token.text).replace(/\n/g, '<br>')
  )).join('');
}

function gongwenBannerMarkup(formatted) {
  const { stats, warnings, fonts, options } = formatted;
  const pills = [
    '<span class="gw-pill"><b>' + stats.paragraphs + '</b> 段正文' + (stats.headings ? ' · <b>' + stats.headings + '</b> 处标题' : '') + '</span>',
    '<span class="gw-pill">字体：' + esc(fonts.title + ' / ' + fonts.body) + (options.latinFont === 'times' ? ' + Times' : '') + '</span>',
  ];
  if (stats.replacedFonts) pills.push('<span class="gw-pill is-accent">替换旧字库 <b>' + stats.replacedFonts + '</b> 处</span>');
  if (stats.boldedSeqWords) pills.push('<span class="gw-pill is-accent">“一是”类加粗 <b>' + stats.boldedSeqWords + '</b> 处</span>');
  if (stats.replacedQuotes) pills.push('<span class="gw-pill is-accent">直引号转换 <b>' + stats.replacedQuotes + '</b> 个</span>');
  if (stats.protectedPunct) pills.push('<span class="gw-pill is-ok">保护中文标点 <b>' + stats.protectedPunct + '</b> 处</span>');
  const cleanups = stats.trimmedSpaces + stats.removedBlankLines + stats.normalizedPunct + stats.normalizedDates;
  if (cleanups) pills.push('<span class="gw-pill is-ok">排版净化 <b>' + cleanups + '</b> 处</span>');

  const warnHtml = warnings.length
    ? '<div class="gw-warn-banner" role="alert">' + icon('alert', 16) + '<div class="gw-warn-copy">' +
      warnings.map((w) => {
        const jumpBtns = (w.blockIds || []).slice(0, 4).map((bid) => {
          const idx = formatted.blocks.findIndex((b) => b.id === bid);
          return idx >= 0
            ? '<button type="button" class="gw-jump-btn" data-cmd="gw-focus-block" data-block="' + esc(bid) + '">定位第 ' + (idx + 1) + ' 项</button>'
            : '';
        }).join('');
        return '<div class="gw-warn-line"><span>' + esc(w.message) + '</span>' + jumpBtns + '</div>';
      }).join('') + '</div></div>'
    : '';

  return '<div class="gw-summary-strip">' + pills.join('') + '</div>' + warnHtml;
}

function focusGongwenBlock(view, blockId, { scrollLeft = true } = {}) {
  if (!blockId) return;
  gwState.activeBlockId = blockId;
  view.querySelectorAll('.gw-block.is-active, .gw-p.is-active, .gw-p-box.is-active, .gw-table-wrap.is-active').forEach((node) => node.classList.remove('is-active'));
  const leftItem = view.querySelector('.gw-block[data-block-id="' + blockId + '"]');
  if (leftItem) {
    leftItem.classList.add('is-active');
    if (scrollLeft) leftItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const previewItem = view.querySelector('[data-preview-block="' + blockId + '"]');
  if (previewItem) {
    previewItem.classList.add('is-active');
    previewItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function runGongwen(view, { keepLeftText = false } = {}) {
  const left = view.querySelector('[data-gw-left]');
  const output = view.querySelector('[data-output]');
  const banner = view.querySelector('[data-gw-banner]');
  const downloadBtn = view.querySelector('[data-cmd="gw-download"]');
  const resetSlot = view.querySelector('[data-gw-reset-slot]');
  const options = state.options.gongwen;

  if (gwState.busy) {
    if (downloadBtn) downloadBtn.disabled = true;
    if (banner) banner.innerHTML = '';
    setStatus(view, { text: '正在解析 Word 文档…' });
    return;
  }

  if (gwState.error) {
    gwState.formatted = null;
    lastOutput = '';
    if (downloadBtn) downloadBtn.disabled = true;
    if (resetSlot) resetSlot.innerHTML = '';
    if (banner) banner.innerHTML = '';
    left.innerHTML = '<div class="gw-empty is-error">' + icon('alert', 28) +
      '<h3>文档无法解析</h3><p>' + esc(gwState.error) + '</p>' +
      '<div class="gw-empty-actions"><button type="button" class="btn btn-secondary btn-small" data-cmd="gw-upload">' + icon('upload', 14) + '重新选择 .docx</button>' +
      '<button type="button" class="btn btn-ghost btn-small" data-cmd="sample">加载示例公文</button></div></div>';
    output.innerHTML = '<div class="pane-empty">修复或更换文档后将在此显示 A4 版式预览</div>';
    setStatus(view, { kind: 'error', text: gwState.error });
    return;
  }

  if (!gwState.session) {
    gwState.formatted = null;
    lastOutput = '';
    if (downloadBtn) downloadBtn.disabled = true;
    if (resetSlot) resetSlot.innerHTML = '';
    if (banner) banner.innerHTML = '';
    if (gwState.mode === 'text') {
      if (!keepLeftText || !left.querySelector('[data-gw-text]')) {
        left.innerHTML = '<div class="gw-text-wrap"><div class="gw-source-bar"><span class="gw-source-meta">直接粘贴文稿即可自动识别公文要素并导出标准 .docx</span>' +
          '<button type="button" class="btn btn-ghost btn-small" data-cmd="gw-upload">' + icon('upload', 14) + '改传 .docx</button></div>' +
          '<textarea class="code-area gw-textarea" data-gw-text spellcheck="false" aria-label="公文文稿" placeholder="粘贴公文草稿（支持发文字号、标题、主送机关、一至四级标题、“一是”至“十是”、附件与落款）…"></textarea></div>';
        left.querySelector('[data-gw-text]').value = state.inputs.gongwen ?? '';
      }
    } else {
      left.innerHTML = '<div class="gw-dropzone" data-gw-drop-card>' +
        '<div class="gw-mini-sheet" aria-hidden="true"><span></span><i></i><b></b><b></b><b></b><em></em></div>' +
        '<h3>拖入 .docx Word 文档，或点击选择文件</h3>' +
        '<p>自动完成国标版心排版、GB2312 字库归一、“一是”至“十是”加粗、直引号配对转换及 Times 西文标点保护。</p>' +
        '<div class="gw-feature-tags">' +
        '<span>仿宋_GB2312 → 仿宋</span><span>“一是”自动加粗</span><span>保护 “ ” —— …… ·</span><span>未闭合引号检测</span></div>' +
        '<div class="gw-empty-actions">' +
        '<button type="button" class="btn btn-primary btn-small" data-cmd="gw-upload">' + icon('upload', 14) + '选择 .docx 文件</button>' +
        '<button type="button" class="btn btn-secondary btn-small" data-cmd="gw-mode" data-mode="text">粘贴纯文本文稿</button>' +
        '<button type="button" class="btn btn-ghost btn-small" data-cmd="sample">加载示例</button></div></div>';
    }
    output.innerHTML = '<div class="gw-spec-empty"><h4>GB/T 9704-2012 公文排版与字体精修规则</h4>' +
      '<dl class="gw-spec-grid">' +
      '<div><dt>版心与页边距</dt><dd>A4 纸 · 天头 37mm、订口 28mm、下 35mm、右 26mm，四号宋体页码</dd></div>' +
      '<div><dt>标题与四级序号</dt><dd>标题二号方正小标宋简体居中；一至四级依次为黑体、楷体、仿宋' + (options.h3Bold ? '加粗' : '') + '、仿宋</dd></div>' +
      '<div><dt>字库归一与序词加粗</dt><dd>统一正文、样式表、页眉页脚与批注字库；自动加粗正文“一是”至“十是”</dd></div>' +
      '<div><dt>西文与中文标点保护</dt><dd>数字与英文设为 Times New Roman，同时锁定 “ ” ‘ ’ —— …… · 保持中文全角字体</dd></div>' +
      '<div><dt>智能引号与闭合诊断</dt><dd>英文直引号自动转为成对中文弯引号，分区域检测奇数或未闭合引号并定位提示</dd></div>' +
      '<div><dt>附件、落款与图表</dt><dd>多附件悬挂对齐首字；署名与日期右空四字居中对齐；保护表格与图片行距</dd></div>' +
      '</dl></div>';
    setStatus(view, { text: '支持上传 .docx（Word 2007 及以上）或直接粘贴文稿，全部在浏览器本地完成' });
    return;
  }

  const formatted = gw.applyGongwenFormatting(gwState.session, options, gwState.overrides);
  gwState.formatted = formatted;
  const overrideCount = formatted.blocks.filter((b) => b.overridden).length;
  if (resetSlot) {
    resetSlot.innerHTML = overrideCount ? smallButton('gw-reset-roles', '恢复自动识别（' + overrideCount + '）', 'refresh') : '';
  }
  if (downloadBtn) downloadBtn.disabled = false;
  if (banner) banner.innerHTML = gongwenBannerMarkup(formatted);

  lastOutput = formatted.blocks.filter((b) => b.kind === 'paragraph').map((b) => b.text).join('\n');

  if (gwState.mode === 'text') {
    if (!keepLeftText || !left.querySelector('[data-gw-text]')) {
      const textVal = gwState.sourceKind === 'text' ? (state.inputs.gongwen ?? '') : lastOutput;
      left.innerHTML = '<div class="gw-text-wrap"><div class="gw-source-bar"><span class="gw-source-meta">' +
        (gwState.sourceKind === 'file' ? '编辑下方文本将以纯文本重建文档（原 .docx 表格/图片可点「更换文件」保留）' : '修改文稿后右侧实时刷新 A4 版式预览') + '</span>' +
        '<button type="button" class="btn btn-ghost btn-small" data-cmd="gw-upload">' + icon('upload', 14) + '上传 .docx</button></div>' +
        '<textarea class="code-area gw-textarea" data-gw-text spellcheck="false" aria-label="公文文稿" placeholder="粘贴公文草稿…"></textarea></div>';
      left.querySelector('[data-gw-text]').value = textVal;
    }
  } else {
    const prevScroll = left.querySelector('.gw-block-list')?.scrollTop ?? 0;
    const metaParts = [
      gwState.sourceKind === 'file' ? formatSize(gwState.session.byteLength) : '文稿生成',
      formatted.stats.paragraphs + ' 段',
    ];
    if (formatted.stats.tables) metaParts.push(formatted.stats.tables + ' 个表格');
    if (formatted.stats.images) metaParts.push(formatted.stats.images + ' 处图片');

    left.innerHTML = '<div class="gw-inspector">' +
      '<div class="gw-source-bar"><div class="gw-source-file">' + icon('gongwen', 16) +
      '<strong>' + esc(gwState.session.fileName) + '</strong><span>' + esc(metaParts.join(' · ')) + '</span></div>' +
      '<button type="button" class="btn btn-ghost btn-small" data-cmd="gw-upload">' + icon('upload', 14) + '更换文件</button></div>' +
      '<div class="gw-block-list" role="list" aria-label="段落角色列表">' +
      formatted.blocks.map((block, index) => {
        const activeCls = gwState.activeBlockId === block.id ? ' is-active' : '';
        if (block.kind !== 'paragraph') {
          return '<div class="gw-block is-special' + activeCls + '" data-block-id="' + esc(block.id) + '" role="listitem"><span class="gw-block-num">' + (index + 1) + '</span>' +
            '<span class="gw-fixed-badge">' + (block.kind === 'table' ? '表格保护' : '图片保护') + '</span>' +
            '<span class="gw-block-text">' + esc(block.text) + '</span></div>';
        }
        const changed = block.rawText !== block.text;
        const hasSeq = (block.tokens || block.restTokens || []).some((t) => t.seq);
        const cls = 'gw-block' + (block.overridden ? ' is-overridden' : '') + (block.quoteWarning ? ' is-quote-warn' : '') + activeCls;
        return '<div class="' + cls + '" data-block-id="' + esc(block.id) + '" data-role="' + esc(block.role) + '" role="listitem">' +
          '<span class="gw-block-num">' + (index + 1) + '</span>' +
          '<select class="form-select gw-role-select" data-gw-role="' + esc(block.id) + '" aria-label="第 ' + (index + 1) + ' 段角色">' +
          gw.ROLES.map(([roleKey, roleLabel]) => '<option value="' + esc(roleKey) + '"' + (roleKey === block.role ? ' selected' : '') + '>' + esc(roleLabel) + '</option>').join('') +
          '</select>' +
          '<span class="gw-block-text" title="' + esc(block.rawText) + '">' + esc(block.text) + '</span>' +
          '<span class="gw-block-badges">' +
          (block.quoteWarning ? '<em class="gw-warn-tag">引号未闭合</em>' : '') +
          (hasSeq ? '<em class="gw-seq-tag">序词加粗</em>' : '') +
          (changed && !block.quoteWarning ? '<em class="gw-fix-tag">已规范</em>' : '') +
          '</span></div>';
      }).join('') + '</div></div>';
    const listEl = left.querySelector('.gw-block-list');
    if (listEl && prevScroll) listEl.scrollTop = prevScroll;
  }

  output.innerHTML = gongwenPaperMarkup(formatted);

  const fixes = [];
  if (formatted.stats.boldedSeqWords) fixes.push('“一是”类加粗 ' + formatted.stats.boldedSeqWords + ' 处');
  if (formatted.stats.replacedQuotes) fixes.push('直引号转换 ' + formatted.stats.replacedQuotes + ' 个');
  if (formatted.stats.protectedPunct) fixes.push('保护特殊标点 ' + formatted.stats.protectedPunct + ' 处');
  if (formatted.stats.trimmedSpaces + formatted.stats.removedBlankLines) {
    fixes.push('清理空格/空行 ' + (formatted.stats.trimmedSpaces + formatted.stats.removedBlankLines) + ' 处');
  }
  if (formatted.stats.normalizedPunct + formatted.stats.normalizedDates) {
    fixes.push('规范序号与日期 ' + (formatted.stats.normalizedPunct + formatted.stats.normalizedDates) + ' 处');
  }
  if (formatted.warnings.length) {
    setStatus(view, { kind: 'warn', text: formatted.warnings[0].message + ' · 其余公文版式已完成排版' });
  } else {
    const summary = '已按 GB/T 9704 完成排版 · 共 ' + formatted.stats.paragraphs + ' 段';
    setStatus(view, { kind: 'ok', text: [summary, ...fixes].join(' · ') });
  }
}

function gongwenTableMarkup(block, tableFormat, activeCls, idAttr) {
  const rows = block.previewRows || [];
  if (!rows.length) {
    return '<div class="gw-p-box' + activeCls + '"' + idAttr + '>表格（' + block.rows + ' 行 × ' + block.cols + ' 列）</div>';
  }
  const styleKey = tableFormat === 'tidy' ? 'elegant' : (tableFormat || 'elegant');
  const hasHeader = rows.length > 1;
  const thead = hasHeader
    ? '<thead><tr>' + rows[0].map((cell) => '<th' + (cell.colspan > 1 ? ' colspan="' + cell.colspan + '"' : '') + '>' + esc(cell.text).replace(/\n/g, '<br>') + '</th>').join('') + '</tr></thead>'
    : '';
  const bodyRows = hasHeader ? rows.slice(1) : rows;
  const tbody = '<tbody>' + bodyRows.map((row) => '<tr>' + row.map((cell) => {
    const alignAttr = cell.align === 'center' || cell.align === 'right' ? ' class="is-' + cell.align + '"' : '';
    const spanAttr = cell.colspan > 1 ? ' colspan="' + cell.colspan + '"' : '';
    return '<td' + spanAttr + alignAttr + '>' + renderTokensHtml(cell.tokens, cell.text) + '</td>';
  }).join('') + '</tr>').join('') + '</tbody>';
  const more = block.rows > rows.length ? '<div class="gw-table-more">已预览前 ' + rows.length + ' 行（共 ' + block.rows + ' 行）</div>' : '';
  return '<div class="gw-table-wrap' + activeCls + '"' + idAttr + '><table class="gw-table is-' + esc(styleKey) + '">' + thead + tbody + '</table>' + more + '</div>';
}

function gongwenPaperMarkup(formatted) {
  const { options, blocks } = formatted;
  const lineEm = (Number(options.lineSpacing) / 16).toFixed(3);
  const paraBlocks = blocks;
  let prevParaRole = null;
  const findNextParaRole = (from) => {
    for (let i = from + 1; i < paraBlocks.length; i++) {
      if (paraBlocks[i].kind === 'paragraph') return paraBlocks[i].role;
    }
    return null;
  };

  const inner = paraBlocks.map((block, idx) => {
    const activeCls = gwState.activeBlockId === block.id ? ' is-active' : '';
    const idAttr = ' data-preview-block="' + esc(block.id) + '"';
    if (block.kind === 'table') {
      return gongwenTableMarkup(block, options.tableFormat, activeCls, idAttr);
    }
    if (block.kind === 'media') {
      return '<div class="gw-p-box' + activeCls + '"' + idAttr + '>内嵌图片 / 图形 · 单倍行距居中保护，防止固定行距裁切</div>';
    }
    const role = block.role;
    const nextRole = findNextParaRole(idx);
    const warnCls = block.quoteWarning ? ' is-quote-warn' : '';
    const extraCls = warnCls + activeCls;
    let html = '';

    switch (role) {
      case 'secret_urgent':
        html = '<p class="gw-p is-secret' + extraCls + '"' + idAttr + '>' + esc(block.text) + '</p>';
        break;
      case 'doc_no':
        html = '<p class="gw-p is-doc-no' + extraCls + '"' + idAttr + '>' + esc(block.text) + '</p><div class="gw-red-rule" aria-hidden="true"><span>★</span></div>';
        break;
      case 'title':
      case 'attachment_title':
        html = '<p class="gw-p is-title' + (nextRole === role || nextRole === 'subtitle' ? ' is-tight' : '') + extraCls + '"' + idAttr + '>' + esc(block.text).replace(/\n/g, '<br>') + '</p>';
        break;
      case 'subtitle':
        html = '<p class="gw-p is-subtitle' + (nextRole === 'subtitle' ? ' is-tight' : '') + extraCls + '"' + idAttr + '>' + esc(block.text) + '</p>';
        break;
      case 'salutation':
        html = '<p class="gw-p is-salutation' + extraCls + '"' + idAttr + '>' + esc(block.text) + '</p>';
        break;
      case 'h1':
        html = '<p class="gw-p is-h1' + extraCls + '"' + idAttr + '>' + (block.lead && block.rest
          ? '<span class="gw-inline-h1">' + esc(block.lead) + '</span><span class="gw-inline-body">' + renderTokensHtml(block.restTokens, block.rest) + '</span>'
          : esc(block.text)) + '</p>';
        break;
      case 'h2':
        html = '<p class="gw-p is-h2' + extraCls + '"' + idAttr + '>' + (block.lead && block.rest
          ? '<span class="gw-inline-h2">' + esc(block.lead) + '</span><span class="gw-inline-body">' + renderTokensHtml(block.restTokens, block.rest) + '</span>'
          : esc(block.text)) + '</p>';
        break;
      case 'h3':
        html = '<p class="gw-p is-h3' + (options.h3Bold ? ' is-bold' : '') + extraCls + '"' + idAttr + '>' + (block.lead && block.rest
          ? '<span class="gw-inline-h3">' + esc(block.lead) + '</span><span class="gw-inline-body">' + renderTokensHtml(block.restTokens, block.rest) + '</span>'
          : esc(block.text)) + '</p>';
        break;
      case 'attachment_list': {
        const multi = /^附件：\d+\./.test(block.text);
        html = '<p class="gw-p is-att-list' + (multi ? ' is-multi' : '') + (prevParaRole === 'attachment_list' ? ' is-cont' : '') + extraCls + '"' + idAttr + '>' + esc(block.text) + '</p>';
        break;
      }
      case 'attachment_item':
        html = '<p class="gw-p is-att-item' + extraCls + '"' + idAttr + '>' + esc(block.text) + '</p>';
        break;
      case 'signature':
        html = '<p class="gw-p is-signature' + (prevParaRole === 'signature' ? ' is-cont' : '') + extraCls + '"' + idAttr + ' style="--gw-right:' + (block.rightChars || 4) + 'em">' + esc(block.text) + '</p>';
        break;
      case 'date':
        html = '<p class="gw-p is-date' + (prevParaRole === 'signature' ? ' is-under-sig' : '') + extraCls + '"' + idAttr + ' style="--gw-right:' + (block.rightChars || 4) + 'em">' + esc(block.text) + '</p>';
        break;
      case 'cc':
        html = '<p class="gw-p is-cc' + (prevParaRole === 'cc' ? ' is-cont' : '') + extraCls + '"' + idAttr + '>' + renderTokensHtml(block.tokens, block.text) + '</p>';
        break;
      case 'attachment_marker':
        html = (idx > 0 ? '<div class="gw-page-break" aria-hidden="true"><span>附件另起页</span></div>' : '') +
          '<p class="gw-p is-att-marker' + extraCls + '"' + idAttr + '>' + esc(block.text) + '</p>';
        break;
      default:
        html = '<p class="gw-p is-body' + extraCls + '"' + idAttr + '>' + renderTokensHtml(block.tokens, block.text) + '</p>';
    }
    prevParaRole = role;
    return html;
  }).join('');

  const footer = options.pageNumber === 'keep'
    ? ''
    : '<footer class="gw-footer is-' + esc(options.pageNumber) + '" aria-label="页码预览">— 1 —</footer>';

  const guidesCls = gwState.showGuides ? ' show-guides' : '';
  return '<div class="gw-preview-stage">' +
    '<div class="gw-stage-caption"><span>A4 · 210 × 297 mm</span><span>版心 156 × 225 mm（天头 37mm · 订口 28mm）</span></div>' +
    '<article class="gw-paper' + guidesCls + '" data-latin="' + esc(options.latinFont) + '" style="--gw-line:' + lineEm + 'em" aria-label="A4 公文版式预览">' +
    '<div class="gw-paper-body">' +
    '<span class="gw-guide-label is-top" aria-hidden="true">天头 37mm</span><span class="gw-guide-label is-left" aria-hidden="true">订口 28mm</span>' +
    '<span class="gw-corner is-tl"></span><span class="gw-corner is-tr"></span><span class="gw-corner is-bl"></span><span class="gw-corner is-br"></span>' +
    inner + '</div>' + footer + '</article></div>';
}

async function loadGongwenFile(file, view) {
  if (!file) return;
  const seq = ++gwLoadSeq;
  if (file.size > 50 * 1024 * 1024) {
    gwState.error = '文档超过 50 MB，请检查是否包含未压缩的超大媒体后再试';
    gwState.session = null;
    runGongwen(view);
    return;
  }
  gwState.busy = true;
  gwState.error = null;
  runGongwen(view);
  try {
    const buffer = await file.arrayBuffer();
    const session = await gw.parseGongwenDocx(buffer, file.name);
    if (seq !== gwLoadSeq) return;
    gwState.busy = false;
    gwState.mode = 'structure';
    gwState.sourceKind = 'file';
    gwState.session = session;
    gwState.overrides = {};
    gwState.error = null;
    if (view.isConnected) rerenderBody(view);
  } catch (error) {
    if (seq !== gwLoadSeq) return;
    gwState.busy = false;
    gwState.session = null;
    gwState.error = error instanceof core.ToolError ? error.message : '读取 Word 文档失败，请确认文件为未损坏的 .docx 格式';
    if (view.isConnected) runGongwen(view);
  }
}

async function loadGongwenText(text, view, { keepLeftText = false, switchToStructure = false, fileName = '公文文稿.docx' } = {}) {
  const seq = ++gwLoadSeq;
  state.inputs.gongwen = text;
  saveState();
  if (!text.trim()) {
    gwState.session = null;
    gwState.sourceKind = null;
    gwState.overrides = {};
    gwState.error = null;
    gwState.busy = false;
    if (view.isConnected) runGongwen(view, { keepLeftText });
    return;
  }
  try {
    const session = await gw.buildSessionFromText(text, fileName);
    if (seq !== gwLoadSeq) return;
    gwState.busy = false;
    gwState.sourceKind = 'text';
    gwState.session = session;
    gwState.overrides = {};
    gwState.error = null;
    if (switchToStructure) {
      gwState.mode = 'structure';
      if (view.isConnected) rerenderBody(view);
    } else if (view.isConnected) {
      runGongwen(view, { keepLeftText });
    }
  } catch (error) {
    if (seq !== gwLoadSeq) return;
    gwState.error = error instanceof core.ToolError ? error.message : '处理文稿时出错';
    if (view.isConnected) runGongwen(view, { keepLeftText });
  }
}

async function downloadGongwenDocx(view) {
  if (!gwState.session || !gwState.formatted) return;
  const btn = view.querySelector('[data-cmd="gw-download"]');
  if (btn) btn.disabled = true;
  try {
    const bytes = await gw.exportGongwenDocx(gwState.session, gwState.formatted);
    const outName = gw.outputFileName(gwState.session.fileName);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = outName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    notify('已导出 ' + outName);
  } catch {
    notify('导出 .docx 失败，请重试');
  } finally {
    if (btn && view.isConnected && gwState.formatted) btn.disabled = false;
  }
}

function run(root) {
  const view = root.querySelector('.tools-view');
  if (!view) return;
  const id = view.dataset.tool;
  if (id === 'gongwen') {
    runGongwen(view);
    return;
  }
  const source = id === 'diff' ? { a: state.inputs['diff:a'] ?? '', b: state.inputs['diff:b'] ?? '' } : state.inputs[id] ?? '';
  const options = state.options[id];
  const output = view.querySelector('[data-output]');
  if (id === 'diff') { updateMeta(view, source.a, 'a'); updateMeta(view, source.b, 'b'); }
  else updateMeta(view, source);
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
  } else if (result.html !== undefined) {
    lastOutput = result.copy ?? '';
    output.innerHTML = result.html;
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

// 文本对比 has two inputs (data-input="a" and "b"), kept as diff:a and diff:b.
const inputKey = (view, input) => (input.dataset.input ? view.dataset.tool + ':' + input.dataset.input : view.dataset.tool);

function setDiffInputs(view, a, b) {
  state.inputs['diff:a'] = a;
  state.inputs['diff:b'] = b;
  view.querySelector('[data-input="a"]').value = a;
  view.querySelector('[data-input="b"]').value = b;
  saveState();
  run(view.parentElement);
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
  if (id === 'gongwen') {
    switch (button.dataset.cmd) {
      case 'gw-upload':
        view.querySelector('[data-gw-file]')?.click();
        return;
      case 'gw-mode':
        gwState.mode = button.dataset.mode === 'text' ? 'text' : 'structure';
        rerenderBody(view);
        if (gwState.mode === 'text') view.querySelector('[data-gw-text]')?.focus();
        return;
      case 'gw-reset-roles':
        gwState.overrides = {};
        runGongwen(view);
        return;
      case 'gw-guides':
        gwState.showGuides = !gwState.showGuides;
        button.classList.toggle('is-on', gwState.showGuides);
        button.setAttribute('aria-pressed', String(gwState.showGuides));
        view.querySelector('.gw-paper')?.classList.toggle('show-guides', gwState.showGuides);
        return;
      case 'gw-focus-block':
        if (gwState.mode !== 'structure') {
          gwState.mode = 'structure';
          rerenderBody(view);
        }
        focusGongwenBlock(view, button.dataset.block, { scrollLeft: true });
        return;
      case 'gw-download':
        downloadGongwenDocx(view);
        return;
      case 'sample':
        gwState.activeBlockId = null;
        loadGongwenText(gw.SAMPLE_GONGWEN_TEXT, view, { switchToStructure: true, fileName: '政务服务标准化通知.docx' });
        return;
      case 'clear':
        ++gwLoadSeq;
        gwState.sourceKind = null;
        gwState.session = null;
        gwState.overrides = {};
        gwState.formatted = null;
        gwState.error = null;
        gwState.busy = false;
        gwState.activeBlockId = null;
        state.inputs.gongwen = '';
        saveState();
        rerenderBody(view);
        return;
      case 'copy':
        copyText(lastOutput);
        return;
    }
  }
  if (id === 'diff' && ['sample', 'clear', 'diff-swap'].includes(button.dataset.cmd)) {
    if (button.dataset.cmd === 'sample') setDiffInputs(view, SAMPLES.diffA, SAMPLES.diffB);
    else if (button.dataset.cmd === 'clear') { setDiffInputs(view, '', ''); view.querySelector('[data-input="a"]').focus(); }
    else setDiffInputs(view, state.inputs['diff:b'] ?? '', state.inputs['diff:a'] ?? '');
    return;
  }
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
    const gwArea = event.target.closest?.('.tools-view [data-gw-text]');
    if (gwArea) {
      if (event.isComposing) return;
      const view = gwArea.closest('.tools-view');
      clearTimeout(runTimer);
      runTimer = setTimeout(() => loadGongwenText(gwArea.value, view, { keepLeftText: true }), 120);
      return;
    }
    const input = event.target.closest?.('.tools-view [data-input]');
    if (!input) return;
    const view = input.closest('.tools-view');
    state.inputs[inputKey(view, input)] = input.value;
    saveState();
    clearTimeout(runTimer);
    runTimer = setTimeout(() => run(view.parentElement), input.value.length > 50_000 ? 350 : 80);
  });
  // 字数统计: a selection in the text is counted on its own.
  document.addEventListener('selectionchange', () => {
    const input = document.activeElement;
    if (!input?.matches?.('.tools-view[data-tool="count"] [data-input]')) return;
    const view = input.closest('.tools-view');
    const selected = input.value.slice(input.selectionStart, input.selectionEnd);
    const meta = view.querySelector('[data-input-meta]');
    if (!selected.trim()) { updateMeta(view, input.value); meta?.classList.remove('is-selection'); return; }
    const c = tt.countText(selected);
    meta.textContent = '选中 ' + c.words.toLocaleString('zh-CN') + ' 字（汉字 ' + c.han.toLocaleString('zh-CN') + '）';
    meta.classList.add('is-selection');
  });
  document.addEventListener('compositionend', (event) => {
    const gwArea = event.target.closest?.('.tools-view [data-gw-text]');
    if (!gwArea) return;
    const view = gwArea.closest('.tools-view');
    clearTimeout(runTimer);
    runTimer = setTimeout(() => loadGongwenText(gwArea.value, view, { keepLeftText: true }), 80);
  });
  document.addEventListener('click', (event) => {
    const view = event.target.closest?.('.tools-view');
    if (!view) return;
    const option = event.target.closest('button[data-opt]');
    if (option) { setOption(view, option.dataset.opt, option.dataset.value); return; }
    const command = event.target.closest('[data-cmd]');
    if (command) { handleCommand(view, command); return; }
    if (event.target.closest('[data-gw-drop-card]')) { view.querySelector('[data-gw-file]')?.click(); return; }
    const blockRow = event.target.closest('.gw-block[data-block-id]');
    if (blockRow && !event.target.closest('select')) {
      focusGongwenBlock(view, blockRow.dataset.blockId, { scrollLeft: false });
    }
  });
  document.addEventListener('change', (event) => {
    const fileInput = event.target.closest?.('.tools-view [data-gw-file]');
    if (fileInput) {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) loadGongwenFile(file, fileInput.closest('.tools-view'));
      return;
    }
    const roleSelect = event.target.closest?.('.tools-view [data-gw-role]');
    if (roleSelect) {
      const view = roleSelect.closest('.tools-view');
      const blockId = roleSelect.dataset.gwRole;
      const block = gwState.formatted?.blocks.find((item) => item.id === blockId);
      if (block && roleSelect.value === block.autoRole) delete gwState.overrides[blockId];
      else gwState.overrides[blockId] = roleSelect.value;
      runGongwen(view);
      return;
    }
    const control = event.target.closest?.('.tools-view [data-opt]');
    if (!control || control.tagName === 'BUTTON') return;
    setOption(control.closest('.tools-view'), control.dataset.opt, control.type === 'checkbox' ? control.checked : control.value);
  });
  document.addEventListener('dragover', (event) => {
    const view = event.target.closest?.('.tools-view[data-tool="gongwen"]');
    if (!view || !event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    view.classList.add('is-file-drag');
  });
  document.addEventListener('dragleave', (event) => {
    const view = event.target.closest?.('.tools-view[data-tool="gongwen"]');
    if (!view) return;
    if (!view.contains(event.relatedTarget)) view.classList.remove('is-file-drag');
  });
  document.addEventListener('drop', (event) => {
    const view = event.target.closest?.('.tools-view[data-tool="gongwen"]');
    if (!view) return;
    view.classList.remove('is-file-drag');
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    event.preventDefault();
    loadGongwenFile(file, view);
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
  for (const input of view.querySelectorAll('[data-input]')) input.value = state.inputs[inputKey(view, input)] ?? '';
  clearInterval(clockTimer);
  if (id === 'time') {
    tickClock(view);
    clockTimer = setInterval(() => {
      if (!view.isConnected) { clearInterval(clockTimer); return; }
      tickClock(view);
    }, 250);
  }
  if (id === 'gongwen' && !gwState.session && !gwState.busy && !gwState.error && state.inputs.gongwen?.trim()) {
    loadGongwenText(state.inputs.gongwen, view);
    return;
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
