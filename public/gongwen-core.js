// Zero-dependency Chinese official document (GB/T 9704-2012《党政机关公文格式》)
// .docx reader, structure classifier, OOXML formatter, and .docx builder.
// Integrates GB2312/modern font normalization, “一是”–“十是” bolding, smart quote conversion
// with per-story/per-paragraph unclosed-quote diagnostics, and Times New Roman punctuation protection.
// Runs identically in modern browsers and Node.js without DOMParser or third-party packages.

import { ToolError } from './tools-core.js';

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8');

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const FOOTER_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';
const FOOTER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';

// 1 mm = 56.6929134 twips (1 inch = 25.4 mm = 1440 twips).
// GB/T 9704-2012 §6.1–6.2: A4 (210mm × 297mm), 天头 37mm, 订口 28mm, 版心 156mm × 225mm (右 26mm, 下 35mm).
export const PAGE_SPECS = {
  width: 11906,       // 210 mm
  height: 16838,      // 297 mm
  marginTop: 2098,    // 37 mm
  marginBottom: 1984, // 35 mm
  marginLeft: 1587,   // 28 mm
  marginRight: 1474,  // 26 mm
  header: 850,        // 15 mm
  footer: 1587,       // 28 mm (places page number ~7mm below 版心 bottom edge)
};

export const FONT_PRESETS = {
  standard: {
    label: '标准公文（方正小标宋 / 仿宋 / 楷体）',
    title: '方正小标宋简体',
    h1: '黑体',
    h2: '楷体',
    body: '仿宋',
    pageNum: '宋体',
  },
  gb2312: {
    label: '传统 GB2312（小标宋 / 仿宋_GB2312 / 楷体_GB2312）',
    title: '方正小标宋简体',
    h1: '黑体',
    h2: '楷体_GB2312',
    body: '仿宋_GB2312',
    pageNum: '宋体',
  },
  universal: {
    label: '免装字库（华文中宋 / 仿宋 / 楷体）',
    title: '华文中宋',
    h1: '黑体',
    h2: '楷体',
    body: '仿宋',
    pageNum: '宋体',
  },
};

export const ROLES = [
  ['doc_no', '发文字号'],
  ['secret_urgent', '密级/紧急'],
  ['title', '公文标题'],
  ['subtitle', '副标题'],
  ['salutation', '主送机关'],
  ['h1', '一级标题'],
  ['h2', '二级标题'],
  ['h3', '三级标题'],
  ['h4', '四级标题'],
  ['body', '正文段落'],
  ['attachment_list', '附件说明'],
  ['attachment_item', '附件序号项'],
  ['signature', '发文署名'],
  ['date', '成文日期'],
  ['note', '附注'],
  ['cc', '版记/抄送'],
  ['attachment_marker', '附件标记'],
  ['attachment_title', '附件标题'],
];

export const ROLE_LABELS = Object.fromEntries(ROLES);

export const DEFAULT_GONGWEN_OPTIONS = {
  fontPreset: 'standard',  // 'standard' (仿宋/楷体/方正小标宋简体) | 'gb2312' | 'universal'
  latinFont: 'times',      // 'times' (Times New Roman + 特殊标点字体保护) | 'match'
  lineSpacing: '28',       // '28' | '29' | '30' (pt)
  pageNumber: 'center',    // 'center' (单面常用) | 'mirror' (GB/T 9704 奇偶页) | 'keep'
  tableFormat: 'elegant',  // 'elegant' (雅灰表头) | 'three' (公文三线表) | 'clean' (纯白细线) | 'keep'
  h3Bold: true,            // 三级标题加粗
  boldSeq: true,           // 自动加粗“一是”至“十是”及项目符号领起词
  smartQuotes: true,       // 英文直引号转中文弯引号并校验闭合
  cleanText: true,         // 清理段首空格、多余空行与序号标点
};

// Punctuation marks in Unicode General Punctuation / Latin-1 that Word mistakenly renders in
// Times New Roman unless their run explicitly binds hAnsi/ascii to the Chinese font:
// “ (8220), ” (8221), ‘ (8216), ’ (8217), — (8212), … (8230), · (183).
export const PROTECTED_PUNCT_RE = /[\u201c\u201d\u2018\u2019\u2014\u2026\u00b7]/g;
const SEQ_WORD_RE = /(?<![第唯统万专])((?:[一二三四五六七八九]|十)是)/g;
const BULLET_LEAD_RE = /^(•\s*[^：:\n]{2,18}[：:])(?=\S)/;
const ASCII_SPAN_RE = /[\x21-\x7e]+(?: [\x21-\x7e]+)*/g;

export const SAMPLE_GONGWEN_TEXT = [
  '  市政办发[2026] 18 号  ',
  '',
  '关于进一步提升政务服务标准化规范化便利化水平的通知。',
  '',
  '',
  '各区、县人民政府，市政府各部门、各直属单位:',
  '',
  '    为深入贯彻落实上级决策部署，持续优化营商环境，切实提升企业和群众办事满意度，现就2026年重点工作通知如下：',
  '',
  '  一. 总体要求。',
  '　　坚持以人民为中心的发展思想，围绕"高效办成一件事"目标，重点推进三方面改革：一是健全清单化管理制度；二是推行线上线下融合办理——年底前实现高频事项100%网上可办；三是完善好差评闭环监督体系……切实让数据多跑路、群众少跑腿。',
  '',
  '  (一)、健全事项管理机制',
  '    1、统一事项要素。各部门要严格按照市级目录清单，逐项核对受理条件、申请材料、办理时限等要素，做到同一事项无差别受理·同标准办理。',
  '    2、精简办事材料。凡是能够通过电子证照库、数据共享平台核验的信息，一律不得要求申请人重复提交纸质材料。',
  '    (1)、全面清理没有法律法规依据的证明事项；',
  '    (2)、推广告知承诺制与"容缺受理"服务模式。',
  '',
  '  (二)优化线下窗口服务。健全"一窗综合受理"工作规程，合理设置潮汐窗口与帮办代办专区，缩短群众等候时间。阶段重点任务分工如下：',
  '| 完成时限 | 重点事项 | 责任分工及推进标准 |',
  '| 2026年6月 | 事项清单标准化核验：围绕受理条件、时限与材料开展逐项梳理 | 市行政审批局牵头，各部门按标准完成目录同源挂接 |',
  '| 2026年9月 | 电子证照免提交改造：推动高频证照与申报表单自动关联调用 | 市大数据局协同支撑，实现首批50项高频业务"免证办" |',
  '| 2026年12月 | 窗口综合受理效能评估：建立常态化好差评回访与整改台账 | 各区县政务服务中心落实闭环督导 |',
  '',
  '  二、保障措施',
  '    各地区、各部门要加强组织领导，明确分管负责同志与联络员，定期开展服务效能自查与整改。',
  '',
  '',
  '  附件:1.政务服务事项标准化核查清单。',
  '       2.窗口服务规范自查表。',
  '',
  '',
  '',
  'XX市人民政府办公室',
  '二〇二六年十一月二十六日',
  '  (此件公开发布)  ',
].join('\n');

// ---------------------------------------------------------------------------
// CRC-32 & Minimal ZIP Archive (Deflate-raw + Store)
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateRaw(bytes, uncompressedSize) {
  if (!bytes.length || uncompressedSize === 0) return new Uint8Array(0);
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new ToolError('Word 文档内部压缩数据损坏，无法解压');
  }
}

async function deflateRaw(bytes) {
  if (!bytes.length) return new Uint8Array(0);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 26;
const DOS_TIME = (9 << 11) | (0 << 5) | 0;

export async function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
  if (bytes.length < 22) throw new ToolError('文件为空或不是有效的 .docx 文档');
  if (OLE2_MAGIC.every((b, idx) => bytes[idx] === b)) {
    throw new ToolError('该文件是旧版 .doc（Word 97–2003）二进制格式，请先在 Word 或 WPS 中“另存为 .docx”后再上传');
  }
  if (bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66) {
    throw new ToolError('该文件是 RTF 格式，请先在 Word 或 WPS 中“另存为 .docx”后再上传');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const minEocd = Math.max(0, bytes.length - 65557);
  for (let pos = bytes.length - 22; pos >= minEocd; pos--) {
    if (view.getUint32(pos, true) === 0x06054b50) {
      const commentLen = view.getUint16(pos + 20, true);
      if (pos + 22 + commentLen <= bytes.length) { eocd = pos; break; }
    }
  }
  if (eocd < 0) throw new ToolError('无法识别为 .docx（Word 2007+）文档，请确认文件未损坏且为 .docx 格式');

  const totalEntries = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (totalEntries === 0xffff || cdOffset === 0xffffffff) {
    throw new ToolError('不支持 ZIP64 超大文档');
  }

  const entries = new Map();
  let ptr = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > bytes.length || view.getUint32(ptr, true) !== 0x02014b50) {
      throw new ToolError('Word 文档目录结构损坏');
    }
    const flags = view.getUint16(ptr + 8, true);
    if (flags & 1) throw new ToolError('该 Word 文档设有密码保护，请先取消加密后再上传');
    const method = view.getUint16(ptr + 10, true);
    const crc = view.getUint32(ptr + 16, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);

    const name = UTF8_DECODER.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;
    if (name.includes('..') || name.startsWith('/')) continue;

    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new ToolError('Word 文档内部条目损坏：' + name);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressedData = bytes.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, { name, method, crc, compressedData, uncompressedSize, rawData: null });
  }

  return createZipHandle(entries);
}

function createZipHandle(entries = new Map()) {
  return {
    entries,
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    delete: (name) => entries.delete(name),
    async bytes(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.rawData) return entry.rawData;
      if (entry.method === 0) {
        entry.rawData = entry.compressedData.slice();
      } else if (entry.method === 8) {
        entry.rawData = await inflateRaw(entry.compressedData, entry.uncompressedSize);
      } else {
        throw new ToolError('不支持的压缩算法（条目 ' + name + '）');
      }
      return entry.rawData;
    },
    async text(name) {
      const raw = await this.bytes(name);
      if (!raw) return null;
      return UTF8_DECODER.decode(raw).replace(/^\uFEFF/, '');
    },
    setBytes(name, rawBytes) {
      const data = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
      entries.set(name, {
        name,
        method: 8,
        crc: crc32(data),
        compressedData: null,
        uncompressedSize: data.length,
        rawData: data,
      });
    },
    setText(name, text) {
      this.setBytes(name, UTF8_ENCODER.encode(text));
    },
    async toUint8Array() {
      const prepared = [];
      let localTotal = 0;
      let cdTotal = 0;
      for (const entry of entries.values()) {
        const nameBytes = UTF8_ENCODER.encode(entry.name);
        const utf8Flag = [...entry.name].some((ch) => ch.charCodeAt(0) > 0x7f) ? 0x0800 : 0;
        let method = entry.method;
        let compressed = entry.compressedData;
        let uncompressedSize = entry.uncompressedSize;
        let crc = entry.crc;
        if (!compressed) {
          const raw = entry.rawData || new Uint8Array(0);
          uncompressedSize = raw.length;
          crc = crc32(raw);
          if (raw.length > 64) {
            method = 8;
            compressed = await deflateRaw(raw);
          } else {
            method = 0;
            compressed = raw;
          }
        }
        prepared.push({ nameBytes, utf8Flag, method, crc, compressed, uncompressedSize, localOffset: localTotal });
        localTotal += 30 + nameBytes.length + compressed.length;
        cdTotal += 46 + nameBytes.length;
      }

      const out = new Uint8Array(localTotal + cdTotal + 22);
      const view = new DataView(out.buffer);
      let offset = 0;

      for (const item of prepared) {
        view.setUint32(offset, 0x04034b50, true);
        view.setUint16(offset + 4, 20, true);
        view.setUint16(offset + 6, item.utf8Flag, true);
        view.setUint16(offset + 8, item.method, true);
        view.setUint16(offset + 10, DOS_TIME, true);
        view.setUint16(offset + 12, DOS_DATE, true);
        view.setUint32(offset + 14, item.crc, true);
        view.setUint32(offset + 18, item.compressed.length, true);
        view.setUint32(offset + 22, item.uncompressedSize, true);
        view.setUint16(offset + 26, item.nameBytes.length, true);
        view.setUint16(offset + 28, 0, true);
        out.set(item.nameBytes, offset + 30);
        out.set(item.compressed, offset + 30 + item.nameBytes.length);
        offset += 30 + item.nameBytes.length + item.compressed.length;
      }

      const cdStart = offset;
      for (const item of prepared) {
        view.setUint32(offset, 0x02014b50, true);
        view.setUint16(offset + 4, 20, true);
        view.setUint16(offset + 6, 20, true);
        view.setUint16(offset + 8, item.utf8Flag, true);
        view.setUint16(offset + 10, item.method, true);
        view.setUint16(offset + 12, DOS_TIME, true);
        view.setUint16(offset + 14, DOS_DATE, true);
        view.setUint32(offset + 16, item.crc, true);
        view.setUint32(offset + 20, item.compressed.length, true);
        view.setUint32(offset + 24, item.uncompressedSize, true);
        view.setUint16(offset + 28, item.nameBytes.length, true);
        view.setUint16(offset + 30, 0, true);
        view.setUint16(offset + 32, 0, true);
        view.setUint16(offset + 34, 0, true);
        view.setUint16(offset + 36, 0, true);
        view.setUint32(offset + 38, 0, true);
        view.setUint32(offset + 42, item.localOffset, true);
        out.set(item.nameBytes, offset + 46);
        offset += 46 + item.nameBytes.length;
      }

      view.setUint32(offset, 0x06054b50, true);
      view.setUint16(offset + 4, 0, true);
      view.setUint16(offset + 6, 0, true);
      view.setUint16(offset + 8, prepared.length, true);
      view.setUint16(offset + 10, prepared.length, true);
      view.setUint32(offset + 12, cdTotal, true);
      view.setUint32(offset + 16, cdStart, true);
      view.setUint16(offset + 20, 0, true);
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal Lossless XML Parser & Serializer (No DOMParser / XXE-safe)
// ---------------------------------------------------------------------------

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, token) => {
    if (token[0] === '#') {
      const code = token[1] === 'x' || token[1] === 'X' ? parseInt(token.slice(2), 16) : parseInt(token.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    return XML_ENTITIES[token] ?? match;
  });
}

function cleanXmlChars(text) {
  return String(text ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '');
}

function escapeXmlText(text) {
  return cleanXmlChars(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function escapeXmlAttr(text) {
  return cleanXmlChars(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

export function el(name, attrs = [], children = []) {
  const pairList = Array.isArray(attrs) ? attrs.map(([k, v]) => [k, String(v)]) : Object.entries(attrs).map(([k, v]) => [k, String(v)]);
  return { type: 'element', name, attrs: pairList, children };
}

export function txt(text) {
  return { type: 'text', text: String(text ?? '') };
}

export function getAttr(node, name) {
  const hit = node?.attrs?.find(([k]) => k === name);
  return hit ? hit[1] : undefined;
}

export function setAttr(node, name, value) {
  const str = String(value);
  const hit = node.attrs.find(([k]) => k === name);
  if (hit) hit[1] = str;
  else node.attrs.push([name, str]);
  return node;
}

export function removeAttr(node, name) {
  node.attrs = node.attrs.filter(([k]) => k !== name);
  return node;
}

export function findChild(node, name) {
  return node?.children?.find((child) => child.type === 'element' && child.name === name) || null;
}

export function findChildren(node, name) {
  return node?.children?.filter((child) => child.type === 'element' && child.name === name) || [];
}

export function parseXml(source) {
  const xml = String(source ?? '').replace(/^\uFEFF/, '');
  const root = { type: 'root', children: [] };
  const stack = [root];
  let i = 0;
  const len = xml.length;

  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      const rest = xml.slice(i);
      if (rest) stack[stack.length - 1].children.push({ type: 'text', text: decodeXml(rest) });
      break;
    }
    if (lt > i) {
      stack[stack.length - 1].children.push({ type: 'text', text: decodeXml(xml.slice(i, lt)) });
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) throw new ToolError('XML 注释未闭合');
      stack[stack.length - 1].children.push({ type: 'raw', raw: xml.slice(lt, end + 3) });
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) throw new ToolError('XML CDATA 未闭合');
      stack[stack.length - 1].children.push({ type: 'text', text: xml.slice(lt + 9, end) });
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) throw new ToolError('XML 声明未闭合');
      stack[stack.length - 1].children.push({ type: 'raw', raw: xml.slice(lt, end + 2) });
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      let depth = 1;
      let cursor = lt + 2;
      while (cursor < len && depth > 0) {
        if (xml[cursor] === '<') depth++;
        else if (xml[cursor] === '>') depth--;
        cursor++;
      }
      i = cursor;
      continue;
    }
    if (xml[lt + 1] === '/') {
      const gt = xml.indexOf('>', lt + 2);
      if (gt < 0) throw new ToolError('XML 结束标签不完整');
      const closeName = xml.slice(lt + 2, gt).trim();
      if (stack.length <= 1 || stack[stack.length - 1].name !== closeName) {
        throw new ToolError('XML 标签不匹配：' + closeName);
      }
      stack.pop();
      i = gt + 1;
      continue;
    }

    let cursor = lt + 1;
    while (cursor < len && !/[\s/>]/.test(xml[cursor])) cursor++;
    const tagName = xml.slice(lt + 1, cursor);
    if (!tagName) throw new ToolError('XML 标签名为空');

    const attrs = [];
    let selfClosing = false;
    while (cursor < len) {
      while (cursor < len && /\s/.test(xml[cursor])) cursor++;
      if (cursor >= len) throw new ToolError('XML 标签未闭合：' + tagName);
      if (xml[cursor] === '>') { cursor++; break; }
      if (xml[cursor] === '/' && xml[cursor + 1] === '>') { selfClosing = true; cursor += 2; break; }

      const attrStart = cursor;
      while (cursor < len && !/[\s=/>]/.test(xml[cursor])) cursor++;
      const attrName = xml.slice(attrStart, cursor);
      while (cursor < len && /\s/.test(xml[cursor])) cursor++;
      let attrValue = '';
      if (xml[cursor] === '=') {
        cursor++;
        while (cursor < len && /\s/.test(xml[cursor])) cursor++;
        const quote = xml[cursor];
        if (quote === '"' || quote === "'") {
          const valStart = cursor + 1;
          const valEnd = xml.indexOf(quote, valStart);
          if (valEnd < 0) throw new ToolError('XML 属性引号未闭合：' + attrName);
          attrValue = decodeXml(xml.slice(valStart, valEnd));
          cursor = valEnd + 1;
        } else {
          const valStart = cursor;
          while (cursor < len && !/[\s/>]/.test(xml[cursor])) cursor++;
          attrValue = decodeXml(xml.slice(valStart, cursor));
        }
      }
      if (attrName) attrs.push([attrName, attrValue]);
    }

    const node = { type: 'element', name: tagName, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = cursor;
  }

  if (stack.length !== 1) throw new ToolError('XML 结构未闭合：' + stack[stack.length - 1].name);
  return root;
}

export function cloneXml(node) {
  if (node.type === 'root') return { type: 'root', children: node.children.map(cloneXml) };
  if (node.type === 'element') {
    return {
      type: 'element',
      name: node.name,
      attrs: node.attrs.map(([k, v]) => [k, v]),
      children: node.children.map(cloneXml),
    };
  }
  return { ...node };
}

export function serializeXml(node) {
  if (node.type === 'root') {
    const hasDecl = node.children.some((c) => c.type === 'raw' && c.raw.startsWith('<?xml'));
    const prefix = hasDecl ? '' : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    return prefix + node.children.map(serializeXml).join('');
  }
  if (node.type === 'raw') return node.raw;
  if (node.type === 'text') return escapeXmlText(node.text);
  const attrStr = node.attrs.map(([k, v]) => ' ' + k + '="' + escapeXmlAttr(v) + '"').join('');
  if (!node.children.length) return '<' + node.name + attrStr + '/>';
  let inner = '';
  for (let i = 0; i < node.children.length; i++) inner += serializeXml(node.children[i]);
  return '<' + node.name + attrStr + '>' + inner + '</' + node.name + '>';
}

// ---------------------------------------------------------------------------
// ECMA-376 Element Sequence Order (CT_PPr, CT_RPr, CT_SectPr)
// ---------------------------------------------------------------------------

const orderMap = (names) => new Map(names.map((name, idx) => [name, idx]));

const PPR_ORDER = orderMap([
  'w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr', 'w:widowControl',
  'w:numPr', 'w:suppressLineNumbers', 'w:pBdr', 'w:shd', 'w:tabs', 'w:suppressAutoHyphens',
  'w:kinsoku', 'w:wordWrap', 'w:overflowPunct', 'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN',
  'w:bidi', 'w:adjustRightInd', 'w:snapToGrid', 'w:spacing', 'w:ind', 'w:contextualSpacing',
  'w:mirrorIndents', 'w:suppressOverlap', 'w:jc', 'w:textDirection', 'w:textAlignment',
  'w:textboxTightWrap', 'w:outlineLvl', 'w:divId', 'w:cnfStyle', 'w:rPr', 'w:sectPr', 'w:pPrChange',
]);

const RPR_ORDER = orderMap([
  'w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps', 'w:smallCaps', 'w:strike',
  'w:dstrike', 'w:outline', 'w:shadow', 'w:emboss', 'w:imprint', 'w:noProof', 'w:snapToGrid',
  'w:vanish', 'w:webHidden', 'w:color', 'w:spacing', 'w:w', 'w:kern', 'w:position', 'w:sz',
  'w:szCs', 'w:highlight', 'w:u', 'w:effect', 'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign',
  'w:rtl', 'w:cs', 'w:em', 'w:lang', 'w:eastAsianLayout', 'w:specVanish', 'w:oMath', 'w:rPrChange',
]);

const SECTPR_ORDER = orderMap([
  'w:headerReference', 'w:footerReference', 'w:footnotePr', 'w:endnotePr', 'w:type', 'w:pgSz',
  'w:pgMar', 'w:paperSrc', 'w:pgBorders', 'w:lnNumType', 'w:pgNumType', 'w:cols', 'w:formProt',
  'w:vAlign', 'w:noEndnote', 'w:titlePg', 'w:textDirection', 'w:bidi', 'w:rtlGutter', 'w:docGrid',
  'w:printerSettings', 'w:sectPrChange',
]);

const TBLPR_ORDER = orderMap([
  'w:tblStyle', 'w:tblpPr', 'w:tblOverlap', 'w:bidiVisual', 'w:tblStyleRowBandSize',
  'w:tblStyleColBandSize', 'w:tblW', 'w:jc', 'w:tblCellSpacing', 'w:tblInd', 'w:tblBorders',
  'w:shd', 'w:tblLayout', 'w:tblCellMar', 'w:tblLook', 'w:tblCaption', 'w:tblDescription', 'w:tblPrChange',
]);

const TRPR_ORDER = orderMap([
  'w:cnfStyle', 'w:divId', 'w:gridBefore', 'w:gridAfter', 'w:wBefore', 'w:wAfter',
  'w:cantSplit', 'w:trHeight', 'w:tblHeader', 'w:tblCellSpacing', 'w:jc', 'w:hidden',
  'w:ins', 'w:del', 'w:trPrChange',
]);

const TCPR_ORDER = orderMap([
  'w:cnfStyle', 'w:tcW', 'w:gridSpan', 'w:hMerge', 'w:vMerge', 'w:tcBorders',
  'w:shd', 'w:noWrap', 'w:tcMar', 'w:textDirection', 'w:tcFitText', 'w:vAlign',
  'w:hideMark', 'w:headers', 'w:cellIns', 'w:cellDel', 'w:cellMerge', 'w:tcPrChange',
]);

function sortSchemaChildren(parent, schemaMap) {
  parent.children = parent.children
    .filter((child) => !(child.type === 'text' && !child.text.trim()))
    .map((child, idx) => ({ child, idx, rank: child.type === 'element' ? (schemaMap.get(child.name) ?? 900) : 950 }))
    .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
    .map((entry) => entry.child);
}

function replaceChild(parent, name, newChild) {
  parent.children = parent.children.filter((child) => !(child.type === 'element' && child.name === name));
  if (newChild) parent.children.push(newChild);
}

// ---------------------------------------------------------------------------
// Chinese Numerals, Dates, Quotes & Numbering.xml Materializer
// ---------------------------------------------------------------------------

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function toChineseCount(n) {
  const num = Math.trunc(Number(n));
  if (!Number.isFinite(num) || num <= 0) return String(n);
  if (num < 10) return CN_DIGITS[num];
  if (num === 10) return '十';
  if (num < 20) return '十' + CN_DIGITS[num % 10];
  if (num < 100) {
    const tens = Math.floor(num / 10);
    const ones = num % 10;
    return CN_DIGITS[tens] + '十' + (ones ? CN_DIGITS[ones] : '');
  }
  if (num < 1000) {
    const hundreds = Math.floor(num / 100);
    const rem = num % 100;
    if (!rem) return CN_DIGITS[hundreds] + '百';
    if (rem < 10) return CN_DIGITS[hundreds] + '百零' + CN_DIGITS[rem];
    const tens = Math.floor(rem / 10);
    const ones = rem % 10;
    return CN_DIGITS[hundreds] + '百' + CN_DIGITS[tens] + '十' + (ones ? CN_DIGITS[ones] : '');
  }
  return String(num);
}

const CN_DIGIT_VAL = { '〇': 0, '零': 0, '○': 0, 'Ｏ': 0, O: 0, o: 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

function parseCnSmallInt(token) {
  const str = token.trim();
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  if (str === '十') return 10;
  if (str.startsWith('十') && str.length === 2 && str[1] in CN_DIGIT_VAL) return 10 + CN_DIGIT_VAL[str[1]];
  if (str.endsWith('十') && str.length === 2 && str[0] in CN_DIGIT_VAL) return CN_DIGIT_VAL[str[0]] * 10;
  if (str.length === 3 && str[1] === '十' && str[0] in CN_DIGIT_VAL && str[2] in CN_DIGIT_VAL) {
    return CN_DIGIT_VAL[str[0]] * 10 + CN_DIGIT_VAL[str[2]];
  }
  if (str.length === 1 && str in CN_DIGIT_VAL) return CN_DIGIT_VAL[str];
  if (str.length === 2 && CN_DIGIT_VAL[str[0]] === 0 && str[1] in CN_DIGIT_VAL) return CN_DIGIT_VAL[str[1]];
  return NaN;
}

export function parseOfficialDate(text) {
  const clean = String(text ?? '').trim();
  const m = clean.match(/^((?:19|20)\d{2}|[一二三四五六七八九〇零○ＯOo]{4})\s*(?:年|[.\-/])\s*([0-9一二三四五六七八九十〇零○]{1,2})\s*(?:月|[.\-/])\s*([0-9一二三四五六七八九十〇零○]{1,3})\s*日?$/);
  if (!m) return null;
  if (clean.includes('年') && !clean.endsWith('日')) return null;
  let yearStr = m[1];
  if (!/^\d{4}$/.test(yearStr)) {
    yearStr = [...yearStr].map((ch) => CN_DIGIT_VAL[ch] ?? '').join('');
  }
  const year = parseInt(yearStr, 10);
  const month = parseCnSmallInt(m[2]);
  const day = parseCnSmallInt(m[3]);
  if (!Number.isFinite(year) || year < 1949 || year > 2100) return null;
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  return { year, month, day, formatted: `${year}年${month}月${day}日` };
}

/**
 * Replaces straight ASCII double quotes `"` with alternating `“` and `”` and checks
 * whether quotes in `text` are properly paired and ordered.
 */
export function convertSmartQuotes(text, enabled = true) {
  let straightCount = 0;
  let out = String(text ?? '');
  if (enabled && out.includes('"')) {
    out = out.replace(/"/g, () => (++straightCount % 2 === 1 ? '\u201c' : '\u201d'));
  }
  let depth = 0;
  let orderError = false;
  for (const ch of out) {
    if (ch === '\u201c') depth++;
    else if (ch === '\u201d') {
      if (depth <= 0) orderError = true;
      else depth--;
    }
  }
  const unbalanced = straightCount % 2 === 1 || depth !== 0 || orderError;
  return { text: out, straightCount, unbalanced };
}

function mapFontName(name, fonts) {
  const raw = String(name || '').trim();
  if (!raw) return raw;
  if (['仿宋_GB2312', '仿宋', 'FangSong_GB2312', 'FangSong', 'STFangsong'].includes(raw)) return fonts.body;
  if (['楷体_GB2312', '楷体', 'KaiTi_GB2312', 'KaiTi', 'STKaiti'].includes(raw)) return fonts.h2;
  if (['小标宋', '方正小标宋', '方正小标宋_GBK', '方正小标宋简体', 'FZXiaoBiaoSong-B05S', '华文中宋'].includes(raw)) return fonts.title;
  return raw;
}

function formatNumFmt(n, fmt) {
  if (['chineseCounting', 'chineseCountingThousand', 'japaneseCounting', 'ideographTraditional'].includes(fmt)) {
    return toChineseCount(n);
  }
  if (fmt === 'decimalZero') return n < 10 ? '0' + n : String(n);
  if (fmt === 'lowerLetter') return String.fromCharCode(96 + (((n - 1) % 26) + 1));
  if (fmt === 'upperLetter') return String.fromCharCode(64 + (((n - 1) % 26) + 1));
  return String(n);
}

function parseNumberingDefinitions(numberingRoot) {
  if (!numberingRoot) return null;
  const rootEl = findChild(numberingRoot, 'w:numbering');
  if (!rootEl) return null;
  const abstracts = new Map();
  for (const abs of findChildren(rootEl, 'w:abstractNum')) {
    const absId = getAttr(abs, 'w:abstractNumId');
    if (!absId) continue;
    const levels = new Map();
    for (const lvl of findChildren(abs, 'w:lvl')) {
      const ilvl = Number(getAttr(lvl, 'w:ilvl') ?? '0');
      const numFmt = getAttr(findChild(lvl, 'w:numFmt'), 'w:val') || 'decimal';
      const lvlText = getAttr(findChild(lvl, 'w:lvlText'), 'w:val') || '%1.';
      const start = Number(getAttr(findChild(lvl, 'w:start'), 'w:val') ?? '1') || 1;
      levels.set(ilvl, { numFmt, lvlText, start });
    }
    abstracts.set(absId, levels);
  }
  const nums = new Map();
  for (const num of findChildren(rootEl, 'w:num')) {
    const numId = getAttr(num, 'w:numId');
    const absId = getAttr(findChild(num, 'w:abstractNumId'), 'w:val');
    if (numId && absId && abstracts.has(absId)) {
      nums.set(numId, abstracts.get(absId));
    }
  }
  const counters = new Map();
  return {
    nextPrefix(numId, ilvl) {
      const levels = nums.get(String(numId));
      if (!levels) return '';
      const lvl = levels.get(ilvl);
      if (!lvl || lvl.numFmt === 'bullet' || lvl.numFmt === 'none') return '';
      let state = counters.get(numId);
      if (!state) { state = new Map(); counters.set(numId, state); }
      const current = (state.get(ilvl) ?? (lvl.start - 1)) + 1;
      state.set(ilvl, current);
      for (const key of state.keys()) {
        if (key > ilvl) state.delete(key);
      }
      const usesOwnPlaceholder = lvl.lvlText.includes('%' + (ilvl + 1));
      return lvl.lvlText.replace(/%([1-9])/g, (_, d) => {
        const targetLvl = !usesOwnPlaceholder && d === '1' ? ilvl : Number(d) - 1;
        const spec = levels.get(targetLvl) || lvl;
        const val = state.get(targetLvl) ?? spec.start;
        return formatNumFmt(val, spec.numFmt);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Paragraph Inspection & GB/T 9704-2012 Structure Classification
// ---------------------------------------------------------------------------

const DOC_TYPES_SUFFIX = /(?:命令|决定|公告|通告|通知|通报|议案|报告|请示|批复|意见|函|纪要|方案|办法|规定|细则|规则|章程|纲要|规划|计划|总结|汇报|讲话|致辞|倡议书|公开信|说明|指南|清单|制度|通则|事项|情况|材料|建议|分析|进展|专报|简报|综述|要点|台账|口径|白皮书|动态)[。.]?$/;
const DOC_NO_RE = /^[\u4e00-\u9fa5A-Za-z0-9（）()·]{1,24}[〔\[【(（]\s*(?:19|20)\d{2}\s*[〕\]】)）]\s*第?\s*\d{1,5}\s*号$/;
const SECRET_URGENT_RE = /^(?:(?:绝密|机密|秘密)\s*[★☆*]\s*\S+|特提|特急|加急|平急)$/;

const H1_PROSE_GUARD = /^[一二三四五六七八九十]+(?:是|旦|方面|系列|般|致|并|贯|经|律|同|再|直|揽子|体化|刀切|步|线|线城市|季度|年半|年|月|日|周|天|次|个|些|点|定|起|样|下)/;
const H1_RE = /^([一二三四五六七八九十百]+)\s*([、.．])\s*(\S.*)$/;
const H2_RE = /^[（(]\s*([一二三四五六七八九十百]+)\s*[）)]\s*[、.．]?\s*(\S.*)$/;
const DEC_H2_RE = /^(\d{1,2}\.\d{1,2})(?![.\d%％年月日亿万元家户个人次倍])\s*([\u4e00-\u9fa5A-Za-z“"（(].*)$/;
const DEC_H3_RE = /^(\d{1,2}\.\d{1,2}\.\d{1,2})(?![.\d%％])\s*([\u4e00-\u9fa5A-Za-z“"（(].*)$/;
const H3_RE = /^(\d{1,2})\s*([.．、])\s*(?!\d)(\S.*)$/;
const H4_RE = /^[（(]\s*(\d{1,2})\s*[）)]\s*[、.．]?\s*(\S.*)$/;
const BULLET_RE = /^[•·▪◆➢]\s*(\S[\s\S]*)$/;
const ATTACHMENT_LIST_RE = /^附\s*件\s*[：:]\s*(.*)$/;
const ATTACHMENT_MARKER_RE = /^附\s*件\s*(\d{0,2})\s*[：:]?$/;
const NOTE_RE = /^[（(]\s*(?:此件[\u4e00-\u9fa5]+|不予公开|内部[\u4e00-\u9fa5]*|联系人\s*[：:].+)[）)]$/;
const CC_RE = /^(?:抄\s*送|分\s*送|发)\s*[：:]/;
const PRINT_LINE_RE = /印发$/;

const MEDIA_TAGS = new Set(['w:drawing', 'w:pict', 'w:object', 'mc:AlternateContent', 'm:oMath', 'm:oMathPara']);
const COMPLEX_INLINE_TAGS = new Set([
  'w:drawing', 'w:pict', 'w:object', 'mc:AlternateContent', 'm:oMath', 'm:oMathPara',
  'w:fldSimple', 'w:fldChar', 'w:footnoteReference', 'w:endnoteReference', 'w:commentReference',
]);

function walkParagraphSummary(pNode) {
  let text = '';
  let hasMedia = false;
  let hasComplexInline = false;
  let hasPageBreak = false;
  const pPr = findChild(pNode, 'w:pPr');
  const hasSectPr = Boolean(pPr && findChild(pPr, 'w:sectPr'));
  if (pPr && findChild(pPr, 'w:pageBreakBefore')) hasPageBreak = true;

  function visit(node) {
    if (node.type !== 'element') return;
    // Skip paragraph props, tracked deletions, and floating textbox stories (processed separately).
    if (node.name === 'w:pPr' || node.name === 'w:del' || node.name === 'w:txbxContent') return;
    if (MEDIA_TAGS.has(node.name)) hasMedia = true;
    if (COMPLEX_INLINE_TAGS.has(node.name)) hasComplexInline = true;
    if (node.name === 'w:t') {
      for (const c of node.children) if (c.type === 'text') text += c.text;
      return;
    }
    if (node.name === 'w:tab') { text += '\t'; return; }
    if (node.name === 'w:br') {
      const brType = getAttr(node, 'w:type');
      if (brType === 'page') hasPageBreak = true;
      else text += '\n';
      return;
    }
    for (const child of node.children) visit(child);
  }
  for (const child of pNode.children) visit(child);

  const jc = pPr ? getAttr(findChild(pPr, 'w:jc'), 'w:val') : undefined;
  const pStyle = pPr ? getAttr(findChild(pPr, 'w:pStyle'), 'w:val') : undefined;
  return { rawText: text, hasMedia, hasComplexInline, hasPageBreak, hasSectPr, jc, pStyle };
}

function matchesHeading(trimmed) {
  if (H1_RE.test(trimmed) && !H1_PROSE_GUARD.test(trimmed)) return 'h1';
  if (H2_RE.test(trimmed)) return 'h2';
  if (DEC_H3_RE.test(trimmed) && trimmed.length <= 65 && !/[。；]$/.test(trimmed)) return 'h3';
  if (DEC_H2_RE.test(trimmed) && trimmed.length <= 65 && !/[。；]$/.test(trimmed)) return 'h2';
  const h3 = H3_RE.exec(trimmed);
  if (h3 && !/^[年月日%％]/.test(h3[3])) return 'h3';
  if (H4_RE.test(trimmed)) return 'h4';
  return null;
}

export function classifyParagraphs(items) {
  const roles = new Array(items.length).fill('body');
  if (!items.length) return roles;

  let bodyStarted = false;
  let inAttachmentList = false;
  let expectingAttachmentTitle = false;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const t = item.text.trim();
    if (!t) continue;

    if (i > 1 && ATTACHMENT_MARKER_RE.test(t) && !t.includes('：') && !t.includes(':')) {
      roles[i] = 'attachment_marker';
      inAttachmentList = false;
      expectingAttachmentTitle = true;
      continue;
    }
    if (expectingAttachmentTitle) {
      expectingAttachmentTitle = false;
      if (!matchesHeading(t) && t.length <= 70 && !/[。；]$/.test(t)) {
        roles[i] = 'attachment_title';
        continue;
      }
    }

    if (!bodyStarted && i <= 3 && SECRET_URGENT_RE.test(t)) {
      roles[i] = 'secret_urgent';
      continue;
    }
    if (!bodyStarted && i <= 4 && DOC_NO_RE.test(t)) {
      roles[i] = 'doc_no';
      continue;
    }

    if (!bodyStarted) {
      const prevRole = i > 0 ? roles[i - 1] : null;
      const heading = matchesHeading(t);
      if (!heading && prevRole !== 'title' && prevRole !== 'subtitle') {
        const isLikelyTitle = t.length <= 85 && (
          DOC_TYPES_SUFFIX.test(t) ||
          item.jc === 'center' ||
          /^(?:Title|Heading\s*1|标题)$/i.test(item.pStyle || '') ||
          (i === 0 && t.length <= 52 && !/[：:。；！？]$/.test(t))
        );
        const nextText = items[i + 1]?.text.trim() || '';
        const isSplitTitleFirstLine = i <= 2 && t.length <= 45 && !/[：:。；！？]$/.test(t) &&
          nextText.length > 0 && nextText.length <= 45 && DOC_TYPES_SUFFIX.test(nextText) && !matchesHeading(nextText);
        if (isLikelyTitle || isSplitTitleFirstLine) {
          roles[i] = 'title';
          if (isSplitTitleFirstLine && !DOC_TYPES_SUFFIX.test(t)) {
            roles[i + 1] = 'title';
            i++;
          }
          continue;
        }
      }

      if (prevRole === 'title') {
        if (/^(?:——|--|—)/.test(t) && t.length <= 60) {
          roles[i] = 'subtitle';
          continue;
        }
        if (/^[（(].*[）)]$/.test(t) && t.length <= 40) {
          roles[i] = 'subtitle';
          continue;
        }
      }

      if ((prevRole === 'title' || prevRole === 'subtitle' || i <= 3) &&
          /[：:]$/.test(t) && t.length <= 120 && !ATTACHMENT_LIST_RE.test(t) && !CC_RE.test(t) && !heading) {
        roles[i] = 'salutation';
        bodyStarted = true;
        continue;
      }
    }

    bodyStarted = true;

    if (CC_RE.test(t) || (i >= items.length - 3 && PRINT_LINE_RE.test(t) && t.length <= 40)) {
      roles[i] = 'cc';
      inAttachmentList = false;
      continue;
    }

    if (ATTACHMENT_LIST_RE.test(t)) {
      roles[i] = 'attachment_list';
      inAttachmentList = true;
      continue;
    }

    if (inAttachmentList) {
      if (/^\d{1,2}\s*[.．、]\s*\S/.test(t) && t.length <= 90 && !/[。！？]$/.test(t.replace(/[。.]$/, ''))) {
        roles[i] = 'attachment_item';
        continue;
      }
      inAttachmentList = false;
    }

    const heading = matchesHeading(t);
    if (heading) {
      roles[i] = heading;
      continue;
    }
  }

  const sectionEnds = [];
  for (let i = 0; i < items.length; i++) {
    if (roles[i] === 'attachment_marker') sectionEnds.push(i - 1);
  }
  sectionEnds.push(items.length - 1);

  for (const endIdx of sectionEnds) {
    if (endIdx < 1) continue;
    let cursor = endIdx;
    while (cursor >= 0 && roles[cursor] === 'cc') cursor--;
    if (cursor >= 1 && NOTE_RE.test(items[cursor].text.trim())) {
      roles[cursor] = 'note';
      cursor--;
    }
    if (cursor >= 1 && parseOfficialDate(items[cursor].text.trim())) {
      roles[cursor] = 'date';
      const sigIdx = cursor - 1;
      if (sigIdx >= 1 && roles[sigIdx] === 'body') {
        const sigText = items[sigIdx].text.trim();
        if (sigText.length >= 2 && sigText.length <= 32 && !/[。；！？：:，,]$/.test(sigText)) {
          roles[sigIdx] = 'signature';
        }
      }
    }
  }

  return roles;
}

// ---------------------------------------------------------------------------
// Text Normalization, Smart Quotes & Sequence-Word Bolding
// ---------------------------------------------------------------------------

function splitRunInClause(text, maxClause = 38) {
  const periodIdx = text.indexOf('。');
  if (periodIdx > 0 && periodIdx < text.length - 1 && periodIdx <= maxClause) {
    return { lead: text.slice(0, periodIdx + 1), rest: text.slice(periodIdx + 1).replace(/^\s+/, '') };
  }
  return null;
}

function visualHanWidth(text) {
  let width = 0;
  for (const ch of text) {
    width += ch.charCodeAt(0) <= 0x7f ? 0.5 : 1;
  }
  return width;
}

function normalizeByRole(rawText, role, { cleanText, smartQuotes }) {
  let text = String(rawText ?? '').replace(/\r\n?/g, '\n');
  let trimmedSpaces = 0;
  let normalizedPunct = 0;
  let normalizedDates = 0;

  if (cleanText) {
    const beforeTrim = text;
    text = text.replace(/^[ \t\u3000\u00a0]+/, '').replace(/[ \t\u3000\u00a0]+$/, '');
    if (text !== beforeTrim && /^[ \t\u3000\u00a0]+/.test(beforeTrim)) trimmedSpaces = 1;
  } else {
    text = text.trimEnd();
  }

  // Smart straight-quote conversion & curly-quote balance check (Macro 2).
  const quoteInfo = convertSmartQuotes(text, smartQuotes);
  text = quoteInfo.text;

  if (!cleanText) {
    if (role === 'h2' || role === 'h3') {
      const split = splitRunInClause(text);
      if (split) {
        return {
          text: split.lead + split.rest,
          lead: split.lead,
          rest: split.rest,
          trimmedSpaces,
          normalizedPunct,
          normalizedDates,
          replacedQuotes: quoteInfo.straightCount,
          quoteWarning: quoteInfo.unbalanced,
        };
      }
    }
    return {
      text,
      lead: null,
      rest: null,
      trimmedSpaces,
      normalizedPunct,
      normalizedDates,
      replacedQuotes: quoteInfo.straightCount,
      quoteWarning: quoteInfo.unbalanced,
    };
  }

  const afterQuoteText = text;

  switch (role) {
    case 'doc_no': {
      text = text
        .replace(/[〔\[【(（]\s*((?:19|20)\d{2})\s*[〕\]】)）]/g, '〔$1〕')
        .replace(/〕\s*(\d+)\s*号$/, '〕$1号');
      break;
    }
    case 'title':
    case 'attachment_title': {
      if (/[。.]$/.test(text)) text = text.replace(/[。.]+$/, '');
      break;
    }
    case 'salutation': {
      text = text.replace(/:$/, '：');
      break;
    }
    case 'h1': {
      const m = H1_RE.exec(text);
      if (m) text = m[1] + '、' + m[3].trimStart();
      const split = splitRunInClause(text);
      if (split) {
        if (text !== afterQuoteText) normalizedPunct = 1;
        return {
          text: split.lead + split.rest,
          lead: split.lead,
          rest: split.rest,
          trimmedSpaces,
          normalizedPunct,
          normalizedDates,
          replacedQuotes: quoteInfo.straightCount,
          quoteWarning: quoteInfo.unbalanced,
        };
      }
      if (text.endsWith('。') && text.length <= 36) text = text.slice(0, -1);
      break;
    }
    case 'h2': {
      const dec = DEC_H2_RE.exec(text);
      if (dec) {
        text = dec[1] + ' ' + dec[2].trimStart();
      } else {
        const m = H2_RE.exec(text);
        if (m) text = '（' + m[1] + '）' + m[2].trimStart();
      }
      const split = splitRunInClause(text);
      if (split) {
        if (text !== afterQuoteText) normalizedPunct = 1;
        return {
          text: split.lead + split.rest,
          lead: split.lead,
          rest: split.rest,
          trimmedSpaces,
          normalizedPunct,
          normalizedDates,
          replacedQuotes: quoteInfo.straightCount,
          quoteWarning: quoteInfo.unbalanced,
        };
      }
      if (text.endsWith('。') && text.length <= 36) text = text.slice(0, -1);
      break;
    }
    case 'h3': {
      const dec = DEC_H3_RE.exec(text);
      if (dec) {
        text = dec[1] + ' ' + dec[2].trimStart();
      } else {
        const m = H3_RE.exec(text);
        if (m) text = m[1] + '.' + m[3].trimStart();
      }
      const split = splitRunInClause(text);
      if (split) {
        if (text !== afterQuoteText) normalizedPunct = 1;
        return {
          text: split.lead + split.rest,
          lead: split.lead,
          rest: split.rest,
          trimmedSpaces,
          normalizedPunct,
          normalizedDates,
          replacedQuotes: quoteInfo.straightCount,
          quoteWarning: quoteInfo.unbalanced,
        };
      }
      // Standalone level-3 sentence headings (e.g. "1.产品问题加快闭环。") keep their trailing period.
      break;
    }
    case 'body': {
      const b = BULLET_RE.exec(text);
      if (b) text = '• ' + b[1].trimStart();
      break;
    }
    case 'h4': {
      const m = H4_RE.exec(text);
      if (m) text = '（' + m[1] + '）' + m[2].trimStart();
      break;
    }
    case 'attachment_list': {
      const m = ATTACHMENT_LIST_RE.exec(text);
      if (m) {
        let item = m[1].trim().replace(/[。；;]+$/, '');
        item = item.replace(/^(\d{1,2})\s*[、．.]\s*/, '$1.');
        text = '附件：' + item;
      }
      break;
    }
    case 'attachment_item': {
      text = text.replace(/^(\d{1,2})\s*[、．.]\s*/, '$1.').replace(/[。；;]+$/, '');
      break;
    }
    case 'attachment_marker': {
      const m = ATTACHMENT_MARKER_RE.exec(text);
      if (m) text = '附件' + (m[1] || '');
      break;
    }
    case 'date': {
      const parsed = parseOfficialDate(text);
      if (parsed && parsed.formatted !== text) {
        text = parsed.formatted;
        normalizedDates = 1;
      }
      break;
    }
    case 'note': {
      text = text.replace(/^\(\s*/, '（').replace(/\s*\)$/, '）');
      break;
    }
    case 'cc': {
      text = text.replace(/^(抄\s*送|分\s*送|发)\s*:/, '$1：');
      break;
    }
  }

  if (text !== afterQuoteText && !normalizedDates) normalizedPunct = 1;
  return {
    text,
    lead: null,
    rest: null,
    trimmedSpaces,
    normalizedPunct,
    normalizedDates,
    replacedQuotes: quoteInfo.straightCount,
    quoteWarning: quoteInfo.unbalanced,
  };
}

/**
 * Splits a string by “一是”–“十是” (and optional bullet/cell lead labels) into `[{ text, seq }]` tokens.
 */
export function tokenizeSequenceWords(text, enabled = true, { leadColon = false } = {}) {
  const source = String(text ?? '');
  if (!enabled || !source) return [{ text: source, seq: false }];
  const tokens = [];
  let startOffset = 0;

  const bulletMatch = BULLET_LEAD_RE.exec(source);
  if (bulletMatch) {
    tokens.push({ text: bulletMatch[1], seq: true });
    startOffset = bulletMatch[1].length;
  } else if (leadColon) {
    const cellLead = /^([^：:\n]{2,16}：)(?=\S)/.exec(source);
    if (cellLead) {
      tokens.push({ text: cellLead[1], seq: true });
      startOffset = cellLead[1].length;
    }
  }

  let last = startOffset;
  SEQ_WORD_RE.lastIndex = startOffset;
  let m;
  while ((m = SEQ_WORD_RE.exec(source))) {
    if (m.index > last) tokens.push({ text: source.slice(last, m.index), seq: false });
    tokens.push({ text: m[1], seq: true });
    last = m.index + m[1].length;
  }
  if (last < source.length || !tokens.length) tokens.push({ text: source.slice(last), seq: false });
  return tokens;
}

/**
 * Splits a text chunk into ASCII vs non-ASCII segments so Western text/digits use
 * `Times New Roman` while Chinese characters AND special punctuation (“ ” ‘ ’ — … ·)
 * bind `w:ascii` & `w:hAnsi` directly to the Chinese font (Macro 2).
 */
function splitByWesternScript(text, useTimes) {
  if (!useTimes || !text) return [{ text, isAscii: false }];
  const parts = [];
  let last = 0;
  ASCII_SPAN_RE.lastIndex = 0;
  let m;
  while ((m = ASCII_SPAN_RE.exec(text))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), isAscii: false });
    parts.push({ text: m[0], isAscii: true });
    last = m.index + m[0].length;
  }
  if (last < text.length || !parts.length) parts.push({ text: text.slice(last), isAscii: false });
  return parts;
}

function countProtectedPunct(text) {
  if (!text) return 0;
  const matches = text.match(PROTECTED_PUNCT_RE);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// OOXML Paragraph, Table, Story, Styles, Section & Footer Formatting
// ---------------------------------------------------------------------------

function buildRPr({ eastAsia, latin, sizeHalfPt, bold = false }) {
  const asciiFont = latin || eastAsia;
  return el('w:rPr', [], [
    el('w:rFonts', [
      ['w:ascii', asciiFont],
      ['w:hAnsi', asciiFont],
      ['w:eastAsia', eastAsia],
      ['w:cs', asciiFont],
      ['w:hint', asciiFont === eastAsia ? 'eastAsia' : 'default'],
    ]),
    el('w:b', [['w:val', bold ? '1' : '0']]),
    el('w:bCs', [['w:val', bold ? '1' : '0']]),
    el('w:i', [['w:val', '0']]),
    el('w:iCs', [['w:val', '0']]),
    el('w:color', [['w:val', '000000']]),
    el('w:kern', [['w:val', '0']]),
    el('w:sz', [['w:val', String(sizeHalfPt)]]),
    el('w:szCs', [['w:val', String(sizeHalfPt)]]),
  ]);
}

function makeSingleTextRun(text, runSpec) {
  const parts = String(text).split('\n');
  const children = [buildRPr(runSpec)];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) children.push(el('w:br'));
    const segment = parts[i];
    const attrs = /^\s|\s$|\s{2}/.test(segment) ? [['xml:space', 'preserve']] : [];
    children.push(el('w:t', attrs, [txt(segment)]));
  }
  return el('w:r', [], children);
}

/**
 * Builds one or more `<w:r>` runs for `text`, applying:
 * 1. “一是”–“十是” bolding (`boldSeq`)
 * 2. `Times New Roman` on ASCII spans while locking Chinese & “ ” ‘ ’ — … · to `eastAsia`.
 */
function buildSegmentedRuns(text, { eastAsia, useTimes, sizeHalfPt, bold = false, boldSeq = false, leadColon = false }, stats = null) {
  const seqTokens = tokenizeSequenceWords(text, boldSeq && !bold, { leadColon });
  const runs = [];
  let seqHits = 0;
  let punctProtected = 0;

  for (const token of seqTokens) {
    if (!token.text) continue;
    if (token.seq) seqHits++;
    const effectiveBold = bold || token.seq;
    const scriptParts = splitByWesternScript(token.text, useTimes);
    for (const part of scriptParts) {
      if (!part.text) continue;
      if (useTimes && !part.isAscii) punctProtected += countProtectedPunct(part.text);
      const latin = useTimes && part.isAscii ? 'Times New Roman' : eastAsia;
      runs.push(makeSingleTextRun(part.text, { eastAsia, latin, sizeHalfPt, bold: effectiveBold }));
    }
  }

  if (!runs.length) {
    runs.push(makeSingleTextRun('', { eastAsia, latin: useTimes ? 'Times New Roman' : eastAsia, sizeHalfPt, bold }));
  }
  if (stats) {
    stats.boldedSeqWords += seqHits;
    stats.protectedPunct += punctProtected;
  }
  return { runs, tokens: seqTokens };
}

function replaceParagraphTextRuns(pNode, runs) {
  const kept = [];
  for (const child of pNode.children) {
    if (child.type === 'element' && (child.name === 'w:pPr' || child.name === 'w:bookmarkStart' || child.name === 'w:bookmarkEnd')) {
      kept.push(child);
    }
  }
  pNode.children = [...kept, ...runs];
}

function isSimpleTextRun(rNode) {
  return rNode.children.every((c) => c.type !== 'element' || c.name === 'w:rPr' || c.name === 'w:t' || c.name === 'w:br');
}

function extractRunPlainText(rNode) {
  let out = '';
  for (const c of rNode.children) {
    if (c.type !== 'element') continue;
    if (c.name === 'w:t') out += c.children.map((x) => x.text || '').join('');
    else if (c.name === 'w:br' && !getAttr(c, 'w:type')) out += '\n';
  }
  return out;
}

function applyRunPropsInPlace(rNode, { eastAsia, latin, sizeHalfPt, bold = false }) {
  const asciiFont = latin || eastAsia;
  let rPr = findChild(rNode, 'w:rPr');
  if (!rPr) {
    rPr = el('w:rPr');
    rNode.children.unshift(rPr);
  }
  replaceChild(rPr, 'w:rStyle', null);
  replaceChild(rPr, 'w:rFonts', el('w:rFonts', [
    ['w:ascii', asciiFont],
    ['w:hAnsi', asciiFont],
    ['w:eastAsia', eastAsia],
    ['w:cs', asciiFont],
    ['w:hint', asciiFont === eastAsia ? 'eastAsia' : 'default'],
  ]));
  replaceChild(rPr, 'w:b', el('w:b', [['w:val', bold ? '1' : '0']]));
  replaceChild(rPr, 'w:bCs', el('w:bCs', [['w:val', bold ? '1' : '0']]));
  replaceChild(rPr, 'w:i', el('w:i', [['w:val', '0']]));
  replaceChild(rPr, 'w:iCs', el('w:iCs', [['w:val', '0']]));
  replaceChild(rPr, 'w:color', el('w:color', [['w:val', '000000']]));
  replaceChild(rPr, 'w:highlight', null);
  replaceChild(rPr, 'w:shd', null);
  replaceChild(rPr, 'w:u', null);
  replaceChild(rPr, 'w:sz', el('w:sz', [['w:val', String(sizeHalfPt)]]));
  replaceChild(rPr, 'w:szCs', el('w:szCs', [['w:val', String(sizeHalfPt)]]));
  sortSchemaChildren(rPr, RPR_ORDER);
}

function formatComplexParagraphRuns(
  pNode,
  { eastAsia, useTimes, sizeHalfPt, bold = false, boldSeq = false, preserveRunBold = false, leadColon = false },
  { trimLeading, smartQuotes },
  stats,
) {
  let trimmed = !trimLeading;
  let quoteParity = 0;
  let isFirstRun = true;

  function visit(container) {
    const nextChildren = [];
    for (const child of container.children) {
      if (child.type !== 'element') { nextChildren.push(child); continue; }
      if (child.name === 'w:r') {
        const origRPr = findChild(child, 'w:rPr');
        const origB = origRPr ? findChild(origRPr, 'w:b') : null;
        const runWasBold = Boolean(preserveRunBold && origB && getAttr(origB, 'w:val') !== '0');
        const effectiveBold = bold || runWasBold;
        if (isSimpleTextRun(child)) {
          let value = extractRunPlainText(child);
          if (!trimmed) {
            const stripped = value.replace(/^[ \t\u3000\u00a0]+/, '');
            if (stripped.length > 0) trimmed = true;
            value = stripped;
          }
          if (smartQuotes && value.includes('"')) {
            value = value.replace(/"/g, () => {
              stats.replacedQuotes++;
              return (++quoteParity % 2 === 1) ? '\u201c' : '\u201d';
            });
          }
          const allowLead = leadColon && isFirstRun;
          if (value.trim()) isFirstRun = false;
          const { runs } = buildSegmentedRuns(
            value,
            { eastAsia, useTimes, sizeHalfPt, bold: effectiveBold, boldSeq, leadColon: allowLead },
            stats,
          );
          nextChildren.push(...runs);
        } else {
          applyRunPropsInPlace(child, { eastAsia, latin: useTimes ? 'Times New Roman' : eastAsia, sizeHalfPt, bold: effectiveBold });
          nextChildren.push(child);
        }
      } else if (child.name === 'w:hyperlink' || child.name === 'w:ins') {
        visit(child);
        nextChildren.push(child);
      } else {
        nextChildren.push(child);
      }
    }
    container.children = nextChildren;
  }
  visit(pNode);
}

/**
 * Applies Macro 1 (GB2312 font normalization + “一是”–“十是” bolding) and
 * Macro 2 (straight quotes -> curly quotes with odd-count warning + Times New Roman
 * special punctuation protection) to secondary stories: headers, footers, footnotes,
 * endnotes, comments, and floating textboxes (`<w:txbxContent>`).
 */
function processSecondaryStoryContainer(container, storyLabel, { fonts, options, stats, warnings }) {
  const useTimes = options.latinFont === 'times';
  let storyStraightQuotes = 0;

  function transformRun(rNode) {
    let rPr = findChild(rNode, 'w:rPr');
    let cnFont = fonts.body;
    if (rPr) {
      const rFonts = findChild(rPr, 'w:rFonts');
      if (rFonts) {
        for (const attr of ['w:eastAsia', 'w:ascii', 'w:hAnsi', 'w:cs']) {
          const val = getAttr(rFonts, attr);
          if (val) {
            const mapped = mapFontName(val, fonts);
            if (mapped !== val) {
              setAttr(rFonts, attr, mapped);
              stats.replacedFonts++;
            }
          }
        }
        cnFont = getAttr(rFonts, 'w:eastAsia') || mapFontName(getAttr(rFonts, 'w:ascii'), fonts) || fonts.body;
      }
    }

    if (!isSimpleTextRun(rNode)) return [rNode];
    let text = extractRunPlainText(rNode);
    if (!text) return [rNode];

    if (options.smartQuotes && text.includes('"')) {
      text = text.replace(/"/g, () => {
        storyStraightQuotes++;
        stats.replacedQuotes++;
        return (storyStraightQuotes % 2 === 1) ? '\u201c' : '\u201d';
      });
    }

    const existingBold = Boolean(rPr && findChild(rPr, 'w:b') && getAttr(findChild(rPr, 'w:b'), 'w:val') !== '0');
    const seqTokens = tokenizeSequenceWords(text, options.boldSeq && !existingBold);
    const outRuns = [];

    for (const token of seqTokens) {
      if (!token.text) continue;
      if (token.seq) stats.boldedSeqWords++;
      const parts = splitByWesternScript(token.text, useTimes);
      for (const part of parts) {
        if (!part.text) continue;
        if (useTimes && !part.isAscii) stats.protectedPunct += countProtectedPunct(part.text);
        const clonedRPr = rPr ? cloneXml(rPr) : el('w:rPr');
        const targetAscii = useTimes && part.isAscii ? 'Times New Roman' : cnFont;
        replaceChild(clonedRPr, 'w:rFonts', el('w:rFonts', [
          ['w:ascii', targetAscii],
          ['w:hAnsi', targetAscii],
          ['w:eastAsia', cnFont],
          ['w:cs', targetAscii],
          ['w:hint', targetAscii === cnFont ? 'eastAsia' : 'default'],
        ]));
        if (token.seq) {
          replaceChild(clonedRPr, 'w:b', el('w:b', [['w:val', '1']]));
          replaceChild(clonedRPr, 'w:bCs', el('w:bCs', [['w:val', '1']]));
        }
        sortSchemaChildren(clonedRPr, RPR_ORDER);
        const segs = part.text.split('\n');
        const runChildren = [clonedRPr];
        for (let i = 0; i < segs.length; i++) {
          if (i > 0) runChildren.push(el('w:br'));
          const s = segs[i];
          runChildren.push(el('w:t', /^\s|\s$|\s{2}/.test(s) ? [['xml:space', 'preserve']] : [], [txt(s)]));
        }
        outRuns.push(el('w:r', rNode.attrs.map(([k, v]) => [k, v]), runChildren));
      }
    }
    return outRuns.length ? outRuns : [rNode];
  }

  function walk(node) {
    if ((node.type !== 'element' && node.type !== 'root') || node.name === 'w:del') return;
    const rebuilt = [];
    for (const child of node.children) {
      if (child.type === 'element' && child.name === 'w:r') {
        rebuilt.push(...transformRun(child));
      } else {
        walk(child);
        rebuilt.push(child);
      }
    }
    node.children = rebuilt;
  }

  walk(container);

  if (storyStraightQuotes % 2 === 1) {
    warnings.push({
      story: storyLabel,
      count: storyStraightQuotes,
      blockIds: [],
      message: `${storyLabel}：检测到 ${storyStraightQuotes} 个英文直引号（奇数），可能存在未闭合引号或顺序错误`,
    });
  }
}

/**
 * Normalizes legacy GB2312 / 小标宋 font declarations inside `word/styles.xml` (Macro 1).
 */
function normalizeStylesXml(stylesXml, fonts, stats) {
  if (!stylesXml) return null;
  let doc;
  try {
    doc = parseXml(stylesXml);
  } catch {
    return stylesXml;
  }
  function visit(node) {
    if (node.type !== 'element' && node.type !== 'root') return;
    if (node.type === 'element' && node.name === 'w:rFonts') {
      for (const attr of ['w:eastAsia', 'w:ascii', 'w:hAnsi', 'w:cs']) {
        const val = getAttr(node, attr);
        if (val) {
          const mapped = mapFontName(val, fonts);
          if (mapped !== val) {
            setAttr(node, attr, mapped);
            stats.replacedFonts++;
          }
        }
      }
    }
    for (const child of node.children) visit(child);
  }
  visit(doc);
  return serializeXml(doc);
}

function configureParagraphProps(pNode, {
  jc = 'both',
  lineTwips = 560,
  lineRule = 'exact',
  beforeTwips = 0,
  afterTwips = 0,
  firstLineChars = 0,
  firstLineTwips = 0,
  leftChars = 0,
  leftTwips = 0,
  hangingChars = 0,
  hangingTwips = 0,
  rightChars = 0,
  rightTwips = 0,
  keepNext = false,
  pageBreakBefore = false,
  outlineLvl = null,
  rPrSpec = null,
}) {
  let pPr = findChild(pNode, 'w:pPr');
  if (!pPr) {
    pPr = el('w:pPr');
    pNode.children.unshift(pPr);
  }
  replaceChild(pPr, 'w:pStyle', null);
  replaceChild(pPr, 'w:numPr', null);
  replaceChild(pPr, 'w:pBdr', null);
  replaceChild(pPr, 'w:shd', null);
  replaceChild(pPr, 'w:contextualSpacing', null);
  replaceChild(pPr, 'w:keepNext', keepNext ? el('w:keepNext') : null);
  replaceChild(pPr, 'w:keepLines', keepNext ? el('w:keepLines') : null);
  replaceChild(pPr, 'w:pageBreakBefore', pageBreakBefore ? el('w:pageBreakBefore') : null);
  replaceChild(pPr, 'w:widowControl', el('w:widowControl'));
  replaceChild(pPr, 'w:snapToGrid', el('w:snapToGrid', [['w:val', '0']]));

  replaceChild(pPr, 'w:spacing', el('w:spacing', [
    ['w:before', String(beforeTwips)],
    ['w:after', String(afterTwips)],
    ['w:line', String(lineTwips)],
    ['w:lineRule', lineRule],
  ]));

  const indAttrs = [];
  if (leftChars > 0) indAttrs.push(['w:leftChars', String(leftChars)]);
  indAttrs.push(['w:left', String(leftTwips)]);
  if (rightChars > 0) indAttrs.push(['w:rightChars', String(rightChars)]);
  indAttrs.push(['w:right', String(rightTwips)]);
  if (hangingTwips > 0) {
    if (hangingChars > 0) indAttrs.push(['w:hangingChars', String(hangingChars)]);
    indAttrs.push(['w:hanging', String(hangingTwips)]);
  } else {
    indAttrs.push(['w:firstLineChars', String(firstLineChars)]);
    indAttrs.push(['w:firstLine', String(firstLineTwips)]);
  }
  replaceChild(pPr, 'w:ind', el('w:ind', indAttrs));
  replaceChild(pPr, 'w:jc', el('w:jc', [['w:val', jc]]));
  replaceChild(pPr, 'w:outlineLvl', outlineLvl !== null ? el('w:outlineLvl', [['w:val', String(outlineLvl)]]) : null);
  if (rPrSpec) replaceChild(pPr, 'w:rPr', buildRPr(rPrSpec));
  sortSchemaChildren(pPr, PPR_ORDER);
}

function buildTableBorders(style) {
  const bdr = (name, val, sz = '4', color = '8A94A6') => (
    val === 'none'
      ? el(name, [['w:val', 'none'], ['w:sz', '0'], ['w:space', '0'], ['w:color', 'auto']])
      : el(name, [['w:val', val], ['w:sz', sz], ['w:space', '0'], ['w:color', color]])
  );
  if (style === 'three') {
    // 公文三线表：上下 1.5pt 黑线，内部行间柔和浅细线，无竖线与左右外框
    return el('w:tblBorders', [], [
      bdr('w:top', 'single', '12', '111111'),
      bdr('w:left', 'none'),
      bdr('w:bottom', 'single', '12', '111111'),
      bdr('w:right', 'none'),
      bdr('w:insideH', 'single', '4', 'DCDEE5'),
      bdr('w:insideV', 'none'),
    ]);
  }
  const innerColor = style === 'clean' ? '595F69' : '9AA3B2';
  return el('w:tblBorders', [], [
    bdr('w:top', 'single', '8', '1F2329'),
    bdr('w:left', 'single', '4', innerColor),
    bdr('w:bottom', 'single', '8', '1F2329'),
    bdr('w:right', 'single', '4', innerColor),
    bdr('w:insideH', 'single', '4', innerColor),
    bdr('w:insideV', 'single', '4', innerColor),
  ]);
}

function extractTablePreview(tblNode, { formatted = false, boldSeq = false } = {}) {
  const trs = findChildren(tblNode, 'w:tr');
  let cols = 0;
  const previewRows = [];
  for (let rIdx = 0; rIdx < trs.length; rIdx++) {
    const cells = findChildren(trs[rIdx], 'w:tc');
    let colCount = 0;
    const rowCells = [];
    for (const tc of cells) {
      const tcPr = findChild(tc, 'w:tcPr');
      const vMerge = tcPr ? findChild(tcPr, 'w:vMerge') : null;
      if (vMerge && getAttr(vMerge, 'w:val') !== 'restart') {
        colCount += Number(getAttr(findChild(tcPr, 'w:gridSpan'), 'w:val') || '1');
        continue;
      }
      const span = Number(getAttr(tcPr ? findChild(tcPr, 'w:gridSpan') : null, 'w:val') || '1');
      colCount += span;
      if (rIdx < 30) {
        const ps = findChildren(tc, 'w:p');
        const cellLines = ps.map((p) => walkParagraphSummary(p).rawText.trim()).filter(Boolean);
        const cellText = cellLines.join('\n');
        const firstJc = ps[0] ? getAttr(findChild(findChild(ps[0], 'w:pPr'), 'w:jc'), 'w:val') : null;
        const align = rIdx === 0 && formatted
          ? 'center'
          : (firstJc === 'center' || firstJc === 'right' ? firstJc : 'left');
        rowCells.push({
          text: cellText,
          tokens: rIdx > 0 ? tokenizeSequenceWords(cellText, boldSeq, { leadColon: true }) : null,
          align,
          colspan: span > 1 ? span : 1,
        });
      }
    }
    cols = Math.max(cols, colCount);
    if (rIdx < 30) previewRows.push(rowCells);
  }
  return { rows: trs.length, cols, previewRows };
}

function formatTableNode(tblNode, fonts, options, stats) {
  const style = options.tableFormat === 'tidy' ? 'elegant' : options.tableFormat;
  const useTimes = options.latinFont === 'times';
  let tableQuotes = 0;

  // 1. Clean table-level properties: remove colored tblStyle/shd, span 100% 版心, set borders & comfortable padding.
  let tblPr = findChild(tblNode, 'w:tblPr');
  if (!tblPr) {
    tblPr = el('w:tblPr');
    tblNode.children.unshift(tblPr);
  }
  replaceChild(tblPr, 'w:tblStyle', null);
  replaceChild(tblPr, 'w:shd', null);
  replaceChild(tblPr, 'w:tblInd', null);
  replaceChild(tblPr, 'w:tblW', el('w:tblW', [['w:w', '5000'], ['w:type', 'pct']]));
  replaceChild(tblPr, 'w:jc', el('w:jc', [['w:val', 'center']]));
  replaceChild(tblPr, 'w:tblBorders', buildTableBorders(style));
  replaceChild(tblPr, 'w:tblCellMar', el('w:tblCellMar', [], [
    el('w:top', [['w:w', '110'], ['w:type', 'dxa']]),
    el('w:left', [['w:w', '150'], ['w:type', 'dxa']]),
    el('w:bottom', [['w:w', '110'], ['w:type', 'dxa']]),
    el('w:right', [['w:w', '150'], ['w:type', 'dxa']]),
  ]));
  replaceChild(tblPr, 'w:tblLook', el('w:tblLook', [
    ['w:val', '04A0'],
    ['w:firstRow', '1'],
    ['w:lastRow', '0'],
    ['w:firstColumn', '0'],
    ['w:lastColumn', '0'],
    ['w:noHBand', '1'],
    ['w:noVBand', '1'],
  ]));
  sortSchemaChildren(tblPr, TBLPR_ORDER);

  // 2. Format header row and data rows cleanly.
  const trs = findChildren(tblNode, 'w:tr');
  for (let rIdx = 0; rIdx < trs.length; rIdx++) {
    const tr = trs[rIdx];
    const isHeader = rIdx === 0 && trs.length > 1;

    let trPr = findChild(tr, 'w:trPr');
    if (!trPr) {
      trPr = el('w:trPr');
      tr.children.unshift(trPr);
    }
    replaceChild(trPr, 'w:cnfStyle', null);
    replaceChild(trPr, 'w:cantSplit', el('w:cantSplit'));
    replaceChild(trPr, 'w:tblHeader', isHeader ? el('w:tblHeader') : null);
    sortSchemaChildren(trPr, TRPR_ORDER);

    for (const tc of findChildren(tr, 'w:tc')) {
      let tcPr = findChild(tc, 'w:tcPr');
      if (!tcPr) {
        tcPr = el('w:tcPr');
        tc.children.unshift(tcPr);
      }
      // Strip conditional theme styles, leftover dark fills, and white cell borders.
      replaceChild(tcPr, 'w:cnfStyle', null);
      if (isHeader && style === 'three') {
        replaceChild(tcPr, 'w:tcBorders', el('w:tcBorders', [], [
          el('w:top', [['w:val', 'single'], ['w:sz', '12'], ['w:space', '0'], ['w:color', '111111']]),
          el('w:bottom', [['w:val', 'single'], ['w:sz', '6'], ['w:space', '0'], ['w:color', '111111']]),
        ]));
      } else if (isHeader && style === 'elegant') {
        replaceChild(tcPr, 'w:tcBorders', el('w:tcBorders', [], [
          el('w:bottom', [['w:val', 'single'], ['w:sz', '6'], ['w:space', '0'], ['w:color', '595F69']]),
        ]));
      } else {
        replaceChild(tcPr, 'w:tcBorders', null);
      }

      if (isHeader && style === 'elegant') {
        replaceChild(tcPr, 'w:shd', el('w:shd', [['w:val', 'clear'], ['w:color', 'auto'], ['w:fill', 'F2F4F7']]));
      } else {
        replaceChild(tcPr, 'w:shd', el('w:shd', [['w:val', 'clear'], ['w:color', 'auto'], ['w:fill', 'auto']]));
      }
      replaceChild(tcPr, 'w:vAlign', el('w:vAlign', [['w:val', 'center']]));
      sortSchemaChildren(tcPr, TCPR_ORDER);

      const ps = findChildren(tc, 'w:p');
      for (let pIdx = 0; pIdx < ps.length; pIdx++) {
        const p = ps[pIdx];
        const info = walkParagraphSummary(p);
        if (info.hasMedia && !info.rawText.trim()) continue;
        const cellTrimmed = info.rawText.trim();
        const isShortSingle = ps.length === 1 && !cellTrimmed.includes('\n') && visualHanWidth(cellTrimmed) <= 7.5;
        const jc = isHeader
          ? 'center'
          : (info.jc === 'center' || info.jc === 'right' ? info.jc : (isShortSingle ? 'center' : 'left'));
        const cnFont = isHeader ? fonts.h1 : fonts.body;
        const headerBold = isHeader && useTimes; // 黑体 strokes are already bold; bold Latin in header
        const spec = { eastAsia: cnFont, latin: useTimes ? 'Times New Roman' : cnFont, sizeHalfPt: 24, bold: headerBold };

        configureParagraphProps(p, {
          jc,
          lineTwips: isHeader ? 276 : 300,
          lineRule: 'auto',
          beforeTwips: 40,
          afterTwips: 40,
          rPrSpec: spec,
        });
        const beforeQuotes = stats.replacedQuotes;
        formatComplexParagraphRuns(
          p,
          {
            eastAsia: cnFont,
            useTimes,
            sizeHalfPt: 24,
            bold: false,
            boldSeq: !isHeader && Boolean(options.boldSeq),
            preserveRunBold: !isHeader,
            leadColon: !isHeader && Boolean(options.boldSeq) && pIdx === 0,
          },
          { trimLeading: true, smartQuotes: options.smartQuotes },
          stats,
        );
        // Ensure Latin characters in header row are crisp semi-bold alongside 黑体.
        if (isHeader && useTimes) {
          for (const r of findChildren(p, 'w:r')) {
            const rPr = findChild(r, 'w:rPr');
            const rFonts = rPr ? findChild(rPr, 'w:rFonts') : null;
            if (rFonts && getAttr(rFonts, 'w:ascii') === 'Times New Roman') {
              replaceChild(rPr, 'w:b', el('w:b', [['w:val', '1']]));
              sortSchemaChildren(rPr, RPR_ORDER);
            }
          }
        }
        tableQuotes += stats.replacedQuotes - beforeQuotes;
      }
    }
  }

  const preview = extractTablePreview(tblNode, { formatted: true, boldSeq: Boolean(options.boldSeq) });
  return { ...preview, tableQuotes };
}

function countTableShape(tblNode, boldSeq = false) {
  const preview = extractTablePreview(tblNode, { formatted: false, boldSeq });
  return { ...preview, tableQuotes: 0 };
}

function formatSectionProps(sectPr, footerRels) {
  const pgSz = findChild(sectPr, 'w:pgSz');
  const isLandscape = pgSz && getAttr(pgSz, 'w:orient') === 'landscape';
  if (!isLandscape) {
    replaceChild(sectPr, 'w:pgSz', el('w:pgSz', [
      ['w:w', String(PAGE_SPECS.width)],
      ['w:h', String(PAGE_SPECS.height)],
    ]));
    replaceChild(sectPr, 'w:pgMar', el('w:pgMar', [
      ['w:top', String(PAGE_SPECS.marginTop)],
      ['w:right', String(PAGE_SPECS.marginRight)],
      ['w:bottom', String(PAGE_SPECS.marginBottom)],
      ['w:left', String(PAGE_SPECS.marginLeft)],
      ['w:header', String(PAGE_SPECS.header)],
      ['w:footer', String(PAGE_SPECS.footer)],
      ['w:gutter', '0'],
    ]));
    replaceChild(sectPr, 'w:docGrid', el('w:docGrid', [
      ['w:type', 'lines'],
      ['w:linePitch', '312'],
    ]));
  }

  if (footerRels) {
    sectPr.children = sectPr.children.filter((c) => !(c.type === 'element' && c.name === 'w:footerReference'));
    replaceChild(sectPr, 'w:titlePg', null);
    sectPr.children.unshift(
      el('w:footerReference', [['w:type', 'default'], ['r:id', footerRels.oddId]]),
      el('w:footerReference', [['w:type', 'even'], ['r:id', footerRels.evenId]]),
    );
  }
  sortSchemaChildren(sectPr, SECTPR_ORDER);
}

function buildFooterXml({ align = 'center', indentSide = null, pageFont = '宋体', latinFont = null }) {
  // Keep “—” bound strictly to `pageFont` (宋体) even when digits use Times New Roman.
  const dashSpec = { eastAsia: pageFont, latin: pageFont, sizeHalfPt: 28, bold: false };
  const numSpec = { eastAsia: pageFont, latin: latinFont || pageFont, sizeHalfPt: 28, bold: false };
  const indAttrs = [
    ['w:left', indentSide === 'left' ? '280' : '0'],
    ['w:right', indentSide === 'right' ? '280' : '0'],
    ['w:firstLine', '0'],
  ];
  if (indentSide === 'left') indAttrs.unshift(['w:leftChars', '100']);
  if (indentSide === 'right') indAttrs.unshift(['w:rightChars', '100']);

  const p = el('w:p', [], [
    el('w:pPr', [], [
      el('w:snapToGrid', [['w:val', '0']]),
      el('w:spacing', [['w:before', '0'], ['w:after', '0'], ['w:line', '280'], ['w:lineRule', 'exact']]),
      el('w:ind', indAttrs),
      el('w:jc', [['w:val', align]]),
      buildRPr(dashSpec),
    ]),
    el('w:r', [], [buildRPr(dashSpec), el('w:t', [], [txt('—')])]),
    el('w:r', [], [buildRPr(numSpec), el('w:t', [['xml:space', 'preserve']], [txt(' ')])]),
    el('w:r', [], [buildRPr(numSpec), el('w:fldChar', [['w:fldCharType', 'begin']])]),
    el('w:r', [], [buildRPr(numSpec), el('w:instrText', [['xml:space', 'preserve']], [txt(' PAGE ')])]),
    el('w:r', [], [buildRPr(numSpec), el('w:fldChar', [['w:fldCharType', 'separate']])]),
    el('w:r', [], [buildRPr(numSpec), el('w:t', [], [txt('1')])]),
    el('w:r', [], [buildRPr(numSpec), el('w:fldChar', [['w:fldCharType', 'end']])]),
    el('w:r', [], [buildRPr(numSpec), el('w:t', [['xml:space', 'preserve']], [txt(' ')])]),
    el('w:r', [], [buildRPr(dashSpec), el('w:t', [], [txt('—')])]),
  ]);

  const root = {
    type: 'root',
    children: [el('w:ftr', [['xmlns:w', W_NS], ['xmlns:r', R_NS]], [p])],
  };
  return serializeXml(root);
}

function buildFontTableXml(existingXml) {
  const fallbacks = [
    ['方正小标宋简体', '华文中宋', 'roman'],
    ['华文中宋', '宋体', 'roman'],
    ['仿宋_GB2312', '仿宋', 'roman'],
    ['仿宋', '宋体', 'roman'],
    ['楷体_GB2312', '楷体', 'script'],
    ['楷体', '宋体', 'script'],
    ['黑体', 'SimHei', 'swiss'],
    ['宋体', 'SimSun', 'roman'],
    ['Times New Roman', 'Times', 'roman'],
  ];
  let doc;
  try {
    doc = existingXml ? parseXml(existingXml) : null;
  } catch {
    doc = null;
  }
  let fontsEl = doc ? findChild(doc, 'w:fonts') : null;
  if (!fontsEl) {
    fontsEl = el('w:fonts', [['xmlns:w', W_NS]]);
    doc = { type: 'root', children: [fontsEl] };
  }
  for (const [name, alt, family] of fallbacks) {
    let fontEl = findChildren(fontsEl, 'w:font').find((f) => getAttr(f, 'w:name') === name);
    if (!fontEl) {
      fontEl = el('w:font', [['w:name', name]], [
        el('w:altName', [['w:val', alt]]),
        el('w:charset', [['w:val', name === 'Times New Roman' ? '00' : '86']]),
        el('w:family', [['w:val', family]]),
        el('w:pitch', [['w:val', 'variable']]),
      ]);
      fontsEl.children.push(fontEl);
    } else if (!findChild(fontEl, 'w:altName')) {
      fontEl.children.unshift(el('w:altName', [['w:val', alt]]));
    }
  }
  return serializeXml(doc);
}

function prepareSettingsXml(settingsXml, { pageNumber }) {
  const settingsDoc = settingsXml ? parseXml(settingsXml) : { type: 'root', children: [el('w:settings', [['xmlns:w', W_NS]])] };
  let settingsRoot = findChild(settingsDoc, 'w:settings');
  if (!settingsRoot) {
    settingsRoot = el('w:settings', [['xmlns:w', W_NS]]);
    settingsDoc.children.push(settingsRoot);
  }
  // Disable active trackRevisions (Macro 1: doc.TrackRevisions = False).
  replaceChild(settingsRoot, 'w:trackRevisions', null);
  if (pageNumber === 'mirror' && !findChild(settingsRoot, 'w:evenAndOddHeaders')) {
    settingsRoot.children.unshift(el('w:evenAndOddHeaders'));
  }
  return serializeXml(settingsDoc);
}

function wireFootersIntoMeta({ relsXml, contentTypesXml }) {
  const relsDoc = relsXml ? parseXml(relsXml) : { type: 'root', children: [el('Relationships', [['xmlns', PKG_REL_NS]])] };
  let relsRoot = findChild(relsDoc, 'Relationships');
  if (!relsRoot) {
    relsRoot = el('Relationships', [['xmlns', PKG_REL_NS]]);
    relsDoc.children.push(relsRoot);
  }
  const usedIds = new Set(findChildren(relsRoot, 'Relationship').map((r) => getAttr(r, 'Id')));
  const freshId = (base) => {
    let candidate = base;
    let n = 1;
    while (usedIds.has(candidate)) candidate = base + (++n);
    usedIds.add(candidate);
    return candidate;
  };
  relsRoot.children = relsRoot.children.filter((c) => !(
    c.type === 'element' && c.name === 'Relationship' &&
    ['footer_gongwen_odd.xml', 'footer_gongwen_even.xml'].includes(getAttr(c, 'Target'))
  ));
  const oddId = freshId('rIdGongwenOdd');
  const evenId = freshId('rIdGongwenEven');
  relsRoot.children.push(
    el('Relationship', [['Id', oddId], ['Type', FOOTER_REL_TYPE], ['Target', 'footer_gongwen_odd.xml']]),
    el('Relationship', [['Id', evenId], ['Type', FOOTER_REL_TYPE], ['Target', 'footer_gongwen_even.xml']]),
  );

  const ctDoc = contentTypesXml ? parseXml(contentTypesXml) : { type: 'root', children: [el('Types', [['xmlns', CT_NS]])] };
  let ctRoot = findChild(ctDoc, 'Types');
  if (!ctRoot) {
    ctRoot = el('Types', [['xmlns', CT_NS]]);
    ctDoc.children.push(ctRoot);
  }
  for (const partName of ['/word/footer_gongwen_odd.xml', '/word/footer_gongwen_even.xml']) {
    const exists = findChildren(ctRoot, 'Override').some((o) => getAttr(o, 'PartName') === partName);
    if (!exists) {
      ctRoot.children.push(el('Override', [['PartName', partName], ['ContentType', FOOTER_CONTENT_TYPE]]));
    }
  }

  return {
    oddId,
    evenId,
    relsXml: serializeXml(relsDoc),
    contentTypesXml: serializeXml(ctDoc),
  };
}

// ---------------------------------------------------------------------------
// Session-based Parser & Synchronous Formatter (Fast UI + Full .docx Export)
// ---------------------------------------------------------------------------

function storyLabelForPath(path) {
  if (/^word\/header\d*\.xml$/i.test(path)) return '页眉';
  if (/^word\/footer\d*\.xml$/i.test(path)) return '页脚';
  if (path === 'word/footnotes.xml') return '脚注';
  if (path === 'word/endnotes.xml') return '尾注';
  if (path === 'word/comments.xml') return '批注';
  return null;
}

export async function parseGongwenDocx(input, fileName = '公文.docx') {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
  const zip = await readZip(bytes);
  const documentXml = await zip.text('word/document.xml');
  if (!documentXml) throw new ToolError('文档缺少 word/document.xml，不是有效的 Word 文档');

  const docAst = parseXml(documentXml);
  const docEl = findChild(docAst, 'w:document');
  const bodyEl = findChild(docEl, 'w:body');
  if (!docEl || !bodyEl) throw new ToolError('Word 文档正文结构不完整');

  const numberingXml = await zip.text('word/numbering.xml');
  const numberingAst = numberingXml ? parseXml(numberingXml) : null;
  const relsXml = await zip.text('word/_rels/document.xml.rels');
  const contentTypesXml = await zip.text('[Content_Types].xml');
  const settingsXml = await zip.text('word/settings.xml');
  const fontTableXml = await zip.text('word/fontTable.xml');
  const stylesXml = await zip.text('word/styles.xml');

  const storyParts = [];
  for (const name of zip.names()) {
    if (name === 'word/footer_gongwen_odd.xml' || name === 'word/footer_gongwen_even.xml') continue;
    const label = storyLabelForPath(name);
    if (!label) continue;
    const xml = await zip.text(name);
    if (!xml) continue;
    try {
      storyParts.push({ path: name, label, ast: parseXml(xml) });
    } catch {
      // Leave malformed auxiliary XML untouched.
    }
  }

  const baseAst = cloneXml(docAst);
  const baseBody = findChild(findChild(baseAst, 'w:document'), 'w:body');
  const numbering = parseNumberingDefinitions(numberingAst);
  if (numbering) {
    materializeBodyNumbering(baseBody, numbering);
  }

  return {
    fileName,
    byteLength: bytes.length,
    zip,
    baseAst,
    relsXml,
    contentTypesXml,
    settingsXml,
    fontTableXml,
    stylesXml,
    storyParts,
  };
}

function materializeBodyNumbering(container, numbering) {
  for (const child of container.children) {
    if (child.type !== 'element') continue;
    if (child.name === 'w:p') {
      const pPr = findChild(child, 'w:pPr');
      const numPr = pPr ? findChild(pPr, 'w:numPr') : null;
      if (numPr) {
        const numId = getAttr(findChild(numPr, 'w:numId'), 'w:val');
        const ilvl = Number(getAttr(findChild(numPr, 'w:ilvl'), 'w:val') ?? '0');
        const prefix = numId && numId !== '0' ? numbering.nextPrefix(numId, ilvl) : '';
        replaceChild(pPr, 'w:numPr', null);
        if (prefix) {
          const summary = walkParagraphSummary(child);
          const trimmed = summary.rawText.trimStart();
          if (trimmed && !trimmed.startsWith(prefix)) {
            prependTextToParagraph(child, prefix);
          }
        }
      }
    } else if (child.name === 'w:sdt') {
      const content = findChild(child, 'w:sdtContent');
      if (content) materializeBodyNumbering(content, numbering);
    }
  }
}

function prependTextToParagraph(pNode, prefix) {
  for (const child of pNode.children) {
    if (child.type === 'element' && child.name === 'w:r') {
      const tNode = findChild(child, 'w:t');
      if (tNode) {
        const existing = tNode.children.map((c) => c.text || '').join('');
        tNode.children = [txt(prefix + existing)];
        return;
      }
    }
  }
  pNode.children.push(el('w:r', [], [el('w:t', [], [txt(prefix)])]));
}

function collectBodyItems(container, list = []) {
  for (let i = 0; i < container.children.length; i++) {
    const child = container.children[i];
    if (child.type !== 'element') continue;
    if (child.name === 'w:p') {
      list.push({ kind: 'p', node: child, parent: container });
    } else if (child.name === 'w:tbl') {
      list.push({ kind: 'tbl', node: child, parent: container });
    } else if (child.name === 'w:sdt') {
      const content = findChild(child, 'w:sdtContent');
      if (content) collectBodyItems(content, list);
    }
  }
  return list;
}

function collectTextboxNodes(rootNode, out = []) {
  if (rootNode.type !== 'element' && rootNode.type !== 'root') return out;
  if (rootNode.type === 'element' && rootNode.name === 'w:txbxContent') {
    out.push(rootNode);
    return out;
  }
  for (const child of rootNode.children) collectTextboxNodes(child, out);
  return out;
}

export function applyGongwenFormatting(session, rawOptions = {}, roleOverrides = {}) {
  const options = { ...DEFAULT_GONGWEN_OPTIONS, ...rawOptions };
  const fonts = FONT_PRESETS[options.fontPreset] || FONT_PRESETS.standard;
  const linePt = Number(options.lineSpacing) || 28;
  const lineTwips = Math.round(linePt * 20);
  const useTimes = options.latinFont === 'times';
  const latinFor = (cnFont) => (useTimes ? 'Times New Roman' : cnFont);

  const workAst = cloneXml(session.baseAst);
  const docEl = findChild(workAst, 'w:document');
  if (!getAttr(docEl, 'xmlns:r')) setAttr(docEl, 'xmlns:r', R_NS);
  const bodyEl = findChild(docEl, 'w:body');

  const stats = {
    paragraphs: 0,
    headings: 0,
    tables: 0,
    images: 0,
    trimmedSpaces: 0,
    removedBlankLines: 0,
    normalizedPunct: 0,
    normalizedDates: 0,
    boldedSeqWords: 0,
    replacedQuotes: 0,
    protectedPunct: 0,
    replacedFonts: 0,
  };
  const warnings = [];

  // Process floating textboxes (`wdTextFrameStory`) inside document.xml.
  for (const txbx of collectTextboxNodes(bodyEl)) {
    processSecondaryStoryContainer(txbx, '文本框', { fonts, options, stats, warnings });
  }

  const rawItems = collectBodyItems(bodyEl);
  const keptBlocks = [];
  const textParagraphs = [];
  let mainStoryStraightQuotes = 0;

  for (const entry of rawItems) {
    if (entry.kind === 'tbl') {
      stats.tables++;
      const shape = options.tableFormat !== 'keep'
        ? formatTableNode(entry.node, fonts, options, stats)
        : countTableShape(entry.node, Boolean(options.boldSeq));
      mainStoryStraightQuotes += shape.tableQuotes;
      keptBlocks.push({
        id: 'tbl-' + keptBlocks.length,
        kind: 'table',
        rows: shape.rows,
        cols: shape.cols,
        previewRows: shape.previewRows,
        text: `表格（${shape.rows} 行 × ${shape.cols} 列）`,
      });
      continue;
    }

    const summary = walkParagraphSummary(entry.node);
    const hasText = summary.rawText.trim().length > 0;

    if (!hasText && summary.hasMedia) {
      stats.images++;
      configureParagraphProps(entry.node, {
        jc: 'center',
        lineTwips: 240,
        lineRule: 'auto',
        beforeTwips: 120,
        afterTwips: 120,
      });
      keptBlocks.push({
        id: 'img-' + keptBlocks.length,
        kind: 'media',
        text: '内嵌图片 / 图形对象',
      });
      continue;
    }

    if (!hasText) {
      if (summary.hasSectPr || summary.hasPageBreak) continue;
      if (options.cleanText) {
        entry.parent.children = entry.parent.children.filter((c) => c !== entry.node);
        stats.removedBlankLines++;
      }
      continue;
    }

    if (summary.hasMedia) stats.images++;
    const pIndex = textParagraphs.length;
    const block = {
      id: 'p-' + pIndex,
      pIndex,
      displayNum: keptBlocks.length + 1,
      kind: 'paragraph',
      node: entry.node,
      summary,
      text: summary.rawText.trim(),
    };
    textParagraphs.push(block);
    keptBlocks.push(block);
  }

  const autoRoles = classifyParagraphs(textParagraphs.map((b) => ({
    text: b.summary.rawText,
    jc: b.summary.jc,
    pStyle: b.summary.pStyle,
    hasMedia: b.summary.hasMedia,
  })));

  for (let i = 0; i < textParagraphs.length; i++) {
    const autoRole = autoRoles[i];
    const override = roleOverrides[textParagraphs[i].id];
    textParagraphs[i].autoRole = autoRole;
    textParagraphs[i].role = override && ROLE_LABELS[override] ? override : autoRole;
  }

  const unbalancedBlocks = [];
  for (const block of textParagraphs) {
    const norm = normalizeByRole(block.summary.rawText, block.role, options);
    block.norm = norm;
    stats.paragraphs++;
    if (['h1', 'h2', 'h3', 'h4'].includes(block.role)) stats.headings++;
    stats.trimmedSpaces += norm.trimmedSpaces;
    stats.normalizedPunct += norm.normalizedPunct;
    stats.normalizedDates += norm.normalizedDates;
    stats.replacedQuotes += norm.replacedQuotes;
    mainStoryStraightQuotes += norm.replacedQuotes;
    if (norm.quoteWarning) unbalancedBlocks.push(block);
  }

  if (options.smartQuotes && (mainStoryStraightQuotes % 2 === 1 || unbalancedBlocks.length > 0)) {
    const loc = unbalancedBlocks.length
      ? '（请重点检查第 ' + unbalancedBlocks.slice(0, 4).map((b) => b.displayNum).join('、') + (unbalancedBlocks.length > 4 ? ' 等' : '') + ' 项）'
      : '';
    const detail = mainStoryStraightQuotes % 2 === 1
      ? `正文：共 ${mainStoryStraightQuotes} 个英文直引号（奇数），可能存在未闭合引号或顺序错误${loc}`
      : `正文：检测到未成对闭合的中文引号${loc}`;
    warnings.push({
      story: '正文',
      count: mainStoryStraightQuotes,
      blockIds: unbalancedBlocks.map((b) => b.id),
      message: detail,
    });
  }

  // Compute mutually centered right indents for signature + date pairs.
  for (let i = 0; i < textParagraphs.length; i++) {
    const cur = textParagraphs[i];
    if (cur.role === 'date') {
      const dateW = visualHanWidth(cur.norm.text);
      const prev = textParagraphs[i - 1];
      if (prev && prev.role === 'signature') {
        const sigW = visualHanWidth(prev.norm.text);
        let dateRight = 4;
        let sigRight = dateRight + (dateW - sigW) / 2;
        if (sigRight < 2) {
          sigRight = 2;
          dateRight = sigRight + (sigW - dateW) / 2;
        }
        prev.rightCharsNum = Math.round(sigRight * 10) / 10;
        cur.rightCharsNum = Math.round(dateRight * 10) / 10;
      } else {
        cur.rightCharsNum = 4;
      }
    } else if (cur.role === 'signature' && textParagraphs[i + 1]?.role !== 'date') {
      cur.rightCharsNum = 4;
    }
  }

  // Roles where “一是”–“十是” inline bolding applies.
  const SEQ_BOLD_ROLES = new Set(['body', 'h4', 'note', 'cc']);

  for (let i = 0; i < textParagraphs.length; i++) {
    const block = textParagraphs[i];
    const nextRole = textParagraphs[i + 1]?.role || null;
    const prevRole = textParagraphs[i - 1]?.role || null;
    const { role, norm, summary } = block;

    let eastAsia = fonts.body;
    let sizeHalfPt = 32;
    let bold = false;
    let jc = 'both';
    let pLineTwips = lineTwips;
    let pLineRule = 'exact';
    let beforeTwips = 0;
    let afterTwips = 0;
    let firstLineChars = 0;
    let firstLineTwips = 0;
    let leftChars = 0;
    let leftTwips = 0;
    let hangingChars = 0;
    let hangingTwips = 0;
    let rightChars = 0;
    let rightTwips = 0;
    let keepNext = false;
    let pageBreakBefore = summary.hasPageBreak;
    let outlineLvl = null;

    switch (role) {
      case 'secret_urgent':
        eastAsia = fonts.h1;
        jc = 'left';
        break;
      case 'doc_no':
        eastAsia = fonts.body;
        jc = 'center';
        afterTwips = lineTwips;
        keepNext = true;
        break;
      case 'title':
      case 'attachment_title':
        eastAsia = fonts.title;
        sizeHalfPt = 44;
        jc = 'center';
        pLineTwips = 700;
        afterTwips = (nextRole === role || nextRole === 'subtitle') ? 0 : lineTwips;
        keepNext = true;
        break;
      case 'subtitle':
        eastAsia = fonts.h2;
        jc = 'center';
        afterTwips = nextRole === 'subtitle' ? 0 : lineTwips;
        keepNext = true;
        break;
      case 'salutation':
        eastAsia = fonts.body;
        jc = 'both';
        keepNext = true;
        break;
      case 'h1':
        eastAsia = fonts.h1;
        firstLineChars = 200;
        firstLineTwips = 640;
        keepNext = !norm.rest;
        outlineLvl = norm.rest ? null : 0;
        break;
      case 'h2':
        eastAsia = fonts.h2;
        firstLineChars = 200;
        firstLineTwips = 640;
        keepNext = !norm.rest;
        outlineLvl = norm.rest ? null : 1;
        break;
      case 'h3':
        eastAsia = fonts.body;
        bold = Boolean(options.h3Bold);
        firstLineChars = 200;
        firstLineTwips = 640;
        keepNext = !norm.rest;
        outlineLvl = norm.rest ? null : 2;
        break;
      case 'h4':
      case 'body':
      case 'note':
        eastAsia = fonts.body;
        firstLineChars = 200;
        firstLineTwips = 640;
        break;
      case 'attachment_list':
        eastAsia = fonts.body;
        beforeTwips = prevRole === 'attachment_list' ? 0 : lineTwips;
        if (/^附件：\d+\./.test(norm.text)) {
          leftChars = 600;
          leftTwips = 1920;
          hangingChars = 400;
          hangingTwips = 1280;
        } else if (/^附件：\S/.test(norm.text)) {
          leftChars = 500;
          leftTwips = 1600;
          hangingChars = 300;
          hangingTwips = 960;
        } else {
          firstLineChars = 200;
          firstLineTwips = 640;
        }
        break;
      case 'attachment_item':
        eastAsia = fonts.body;
        leftChars = 600;
        leftTwips = 1920;
        hangingChars = 100;
        hangingTwips = 320;
        break;
      case 'signature': {
        eastAsia = fonts.body;
        jc = 'right';
        beforeTwips = prevRole === 'signature' ? 0 : lineTwips * 2;
        const rChars = block.rightCharsNum ?? 4;
        rightChars = Math.round(rChars * 100);
        rightTwips = Math.round(rChars * 320);
        keepNext = nextRole === 'date' || nextRole === 'signature';
        break;
      }
      case 'date': {
        eastAsia = fonts.body;
        jc = 'right';
        beforeTwips = prevRole === 'signature' ? 0 : lineTwips * 2;
        const rChars = block.rightCharsNum ?? 4;
        rightChars = Math.round(rChars * 100);
        rightTwips = Math.round(rChars * 320);
        break;
      }
      case 'cc':
        eastAsia = fonts.body;
        sizeHalfPt = 28;
        firstLineChars = 100;
        firstLineTwips = 280;
        beforeTwips = prevRole === 'cc' ? 0 : lineTwips;
        break;
      case 'attachment_marker':
        eastAsia = fonts.h1;
        jc = 'left';
        pageBreakBefore = i > 0;
        afterTwips = lineTwips;
        keepNext = true;
        break;
    }

    if (summary.hasMedia) {
      pLineRule = 'auto';
      pLineTwips = 240;
    }

    // Add subtle breathing room between paragraphs and adjacent tables.
    const keptIdx = keptBlocks.indexOf(block);
    if (keptIdx > 0 && keptBlocks[keptIdx - 1]?.kind === 'table') {
      beforeTwips = Math.max(beforeTwips, 160);
    }
    if (keptIdx >= 0 && keptBlocks[keptIdx + 1]?.kind === 'table') {
      afterTwips = Math.max(afterTwips, 120);
    }

    const allowBoldSeq = Boolean(options.boldSeq) && SEQ_BOLD_ROLES.has(role);
    const primaryRunSpec = { eastAsia, latin: latinFor(eastAsia), sizeHalfPt, bold };

    configureParagraphProps(block.node, {
      jc,
      lineTwips: pLineTwips,
      lineRule: pLineRule,
      beforeTwips,
      afterTwips,
      firstLineChars,
      firstLineTwips,
      leftChars,
      leftTwips,
      hangingChars,
      hangingTwips,
      rightChars,
      rightTwips,
      keepNext,
      pageBreakBefore,
      outlineLvl,
      rPrSpec: primaryRunSpec,
    });

    if (summary.hasComplexInline) {
      // Complex inline paragraphs weren't quote-converted in normalizeByRole's DOM; avoid double counting.
      stats.replacedQuotes -= norm.replacedQuotes;
      formatComplexParagraphRuns(
        block.node,
        { eastAsia, useTimes, sizeHalfPt, bold, boldSeq: allowBoldSeq },
        { trimLeading: options.cleanText, smartQuotes: options.smartQuotes },
        stats,
      );
      block.tokens = tokenizeSequenceWords(norm.text, allowBoldSeq);
    } else if (norm.lead && norm.rest) {
      const leadBuilt = buildSegmentedRuns(norm.lead, { eastAsia, useTimes, sizeHalfPt, bold, boldSeq: false }, stats);
      const restBuilt = buildSegmentedRuns(norm.rest, { eastAsia: fonts.body, useTimes, sizeHalfPt: 32, bold: false, boldSeq: Boolean(options.boldSeq) }, stats);
      replaceParagraphTextRuns(block.node, [...leadBuilt.runs, ...restBuilt.runs]);
      block.restTokens = restBuilt.tokens;
    } else {
      const built = buildSegmentedRuns(norm.text, { eastAsia, useTimes, sizeHalfPt, bold, boldSeq: allowBoldSeq }, stats);
      replaceParagraphTextRuns(block.node, built.runs);
      block.tokens = built.tokens;
    }

    block.formattedText = norm.lead && norm.rest ? norm.lead + norm.rest : norm.text;
    block.lead = norm.lead;
    block.rest = norm.rest;
    block.quoteWarning = norm.quoteWarning;
  }

  // Process styles.xml and auxiliary stories (headers, footers, footnotes, endnotes, comments).
  const formattedStylesXml = normalizeStylesXml(session.stylesXml, fonts, stats);
  const formattedStories = [];
  for (const part of session.storyParts || []) {
    if (options.pageNumber !== 'keep' && part.label === '页脚') continue;
    const partClone = cloneXml(part.ast);
    processSecondaryStoryContainer(partClone, part.label, { fonts, options, stats, warnings });
    formattedStories.push({ path: part.path, xml: serializeXml(partClone) });
  }

  let footerMeta = null;
  let footerOddXml = null;
  let footerEvenXml = null;
  if (options.pageNumber !== 'keep') {
    footerMeta = wireFootersIntoMeta({
      relsXml: session.relsXml,
      contentTypesXml: session.contentTypesXml,
    });
    const pageLatin = useTimes ? 'Times New Roman' : fonts.pageNum;
    if (options.pageNumber === 'mirror') {
      footerOddXml = buildFooterXml({ align: 'right', indentSide: 'right', pageFont: fonts.pageNum, latinFont: pageLatin });
      footerEvenXml = buildFooterXml({ align: 'left', indentSide: 'left', pageFont: fonts.pageNum, latinFont: pageLatin });
    } else {
      footerOddXml = buildFooterXml({ align: 'center', indentSide: null, pageFont: fonts.pageNum, latinFont: pageLatin });
      footerEvenXml = footerOddXml;
    }
  }
  const finalSettingsXml = prepareSettingsXml(session.settingsXml, options);

  for (const child of bodyEl.children) {
    if (child.type === 'element' && child.name === 'w:p') {
      const pPr = findChild(child, 'w:pPr');
      const pSect = pPr ? findChild(pPr, 'w:sectPr') : null;
      if (pSect) formatSectionProps(pSect, footerMeta);
    }
  }
  let bodySectPr = findChild(bodyEl, 'w:sectPr');
  if (!bodySectPr) {
    bodySectPr = el('w:sectPr');
    bodyEl.children.push(bodySectPr);
  }
  formatSectionProps(bodySectPr, footerMeta);

  const previewBlocks = keptBlocks.map((b) => {
    if (b.kind !== 'paragraph') {
      return { id: b.id, kind: b.kind, text: b.text, rows: b.rows, cols: b.cols, previewRows: b.previewRows || [] };
    }
    return {
      id: b.id,
      kind: 'paragraph',
      role: b.role,
      autoRole: b.autoRole,
      overridden: b.role !== b.autoRole,
      quoteWarning: Boolean(b.quoteWarning),
      rawText: b.summary.rawText.trim(),
      text: b.formattedText,
      lead: b.lead,
      rest: b.rest,
      tokens: b.tokens || null,
      restTokens: b.restTokens || null,
      rightChars: b.rightCharsNum ?? 0,
    };
  });

  return {
    options,
    fonts,
    stats,
    warnings,
    blocks: previewBlocks,
    files: {
      documentXml: serializeXml(workAst),
      fontTableXml: buildFontTableXml(session.fontTableXml),
      stylesXml: formattedStylesXml,
      relsXml: footerMeta ? footerMeta.relsXml : session.relsXml,
      contentTypesXml: footerMeta ? footerMeta.contentTypesXml : session.contentTypesXml,
      settingsXml: finalSettingsXml,
      footerOddXml,
      footerEvenXml,
      stories: formattedStories,
    },
  };
}

export async function exportGongwenDocx(session, formatted) {
  const clonedEntries = new Map();
  for (const [name, entry] of session.zip.entries) {
    clonedEntries.set(name, { ...entry });
  }
  const outZip = createZipHandle(clonedEntries);
  const { files } = formatted;
  outZip.setText('word/document.xml', files.documentXml);
  outZip.setText('word/fontTable.xml', files.fontTableXml);
  if (files.stylesXml) outZip.setText('word/styles.xml', files.stylesXml);
  for (const story of files.stories || []) {
    outZip.setText(story.path, story.xml);
  }

  let ctXml = files.contentTypesXml || serializeXml({ type: 'root', children: [el('Types', [['xmlns', CT_NS]])] });
  const ctDoc = parseXml(ctXml);
  const ctRoot = findChild(ctDoc, 'Types');
  if (ctRoot && !findChildren(ctRoot, 'Override').some((o) => getAttr(o, 'PartName') === '/word/fontTable.xml')) {
    ctRoot.children.push(el('Override', [
      ['PartName', '/word/fontTable.xml'],
      ['ContentType', 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml'],
    ]));
    ctXml = serializeXml(ctDoc);
  }
  outZip.setText('[Content_Types].xml', ctXml);

  let relsXml = files.relsXml || serializeXml({ type: 'root', children: [el('Relationships', [['xmlns', PKG_REL_NS]])] });
  const relsDoc = parseXml(relsXml);
  const relsRoot = findChild(relsDoc, 'Relationships');
  const fontRelType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable';
  if (relsRoot && !findChildren(relsRoot, 'Relationship').some((r) => getAttr(r, 'Type') === fontRelType)) {
    const used = new Set(findChildren(relsRoot, 'Relationship').map((r) => getAttr(r, 'Id')));
    let fid = 'rIdGongwenFonts';
    let n = 1;
    while (used.has(fid)) fid = 'rIdGongwenFonts' + (++n);
    relsRoot.children.push(el('Relationship', [['Id', fid], ['Type', fontRelType], ['Target', 'fontTable.xml']]));
    relsXml = serializeXml(relsDoc);
  }
  outZip.setText('word/_rels/document.xml.rels', relsXml);

  if (files.settingsXml) {
    const settingsCt = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml';
    const settingsRelType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings';
    outZip.setText('word/settings.xml', files.settingsXml);
    const ctDoc2 = parseXml(ctXml);
    const ctRoot2 = findChild(ctDoc2, 'Types');
    if (ctRoot2 && !findChildren(ctRoot2, 'Override').some((o) => getAttr(o, 'PartName') === '/word/settings.xml')) {
      ctRoot2.children.push(el('Override', [['PartName', '/word/settings.xml'], ['ContentType', settingsCt]]));
      outZip.setText('[Content_Types].xml', serializeXml(ctDoc2));
    }
    const relsDoc2 = parseXml(relsXml);
    const relsRoot2 = findChild(relsDoc2, 'Relationships');
    if (relsRoot2 && !findChildren(relsRoot2, 'Relationship').some((r) => getAttr(r, 'Type') === settingsRelType)) {
      const used = new Set(findChildren(relsRoot2, 'Relationship').map((r) => getAttr(r, 'Id')));
      let sid = 'rIdGongwenSettings';
      let n = 1;
      while (used.has(sid)) sid = 'rIdGongwenSettings' + (++n);
      relsRoot2.children.push(el('Relationship', [['Id', sid], ['Type', settingsRelType], ['Target', 'settings.xml']]));
      outZip.setText('word/_rels/document.xml.rels', serializeXml(relsDoc2));
    }
  }

  if (files.footerOddXml) outZip.setText('word/footer_gongwen_odd.xml', files.footerOddXml);
  if (files.footerEvenXml) outZip.setText('word/footer_gongwen_even.xml', files.footerEvenXml);

  return outZip.toUint8Array();
}

const PIPE_ROW_RE = /^\s*\|(.+)\|\s*$/;
const PIPE_SEP_RE = /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/;

function buildPipeTableElement(tableLines) {
  const parsedRows = [];
  let maxCols = 0;
  for (const raw of tableLines) {
    if (PIPE_SEP_RE.test(raw)) continue;
    const inner = PIPE_ROW_RE.exec(raw)?.[1] ?? '';
    const cells = inner.split('|').map((c) => c.trim());
    maxCols = Math.max(maxCols, cells.length);
    parsedRows.push(cells);
  }
  if (!parsedRows.length || !maxCols) return null;
  const trNodes = parsedRows.map((cells) => {
    const padded = [...cells];
    while (padded.length < maxCols) padded.push('');
    return el('w:tr', [], padded.map((cell) => el('w:tc', [], [
      el('w:p', [], cell ? [el('w:r', [], [el('w:t', /^\s|\s$|\s{2}/.test(cell) ? [['xml:space', 'preserve']] : [], [txt(cell)])])] : []),
    ])));
  });
  return el('w:tbl', [], [el('w:tblPr'), ...trNodes]);
}

export async function buildSessionFromText(sourceText, fileName = '公文文稿.docx') {
  const lines = String(sourceText ?? '').replace(/\r\n?/g, '\n').split('\n');
  const bodyChildren = [];
  for (let i = 0; i < lines.length; i++) {
    if (PIPE_ROW_RE.test(lines[i]) && lines[i + 1] && PIPE_ROW_RE.test(lines[i + 1])) {
      const tableBatch = [lines[i]];
      while (i + 1 < lines.length && PIPE_ROW_RE.test(lines[i + 1])) {
        tableBatch.push(lines[++i]);
      }
      const tbl = buildPipeTableElement(tableBatch);
      if (tbl) {
        bodyChildren.push(tbl);
        continue;
      }
    }
    const line = lines[i];
    bodyChildren.push(
      el('w:p', [], line ? [el('w:r', [], [el('w:t', /^\s|\s$|\s{2}/.test(line) ? [['xml:space', 'preserve']] : [], [txt(line)])])] : []),
    );
  }
  bodyChildren.push(el('w:sectPr'));

  const documentXml = serializeXml({
    type: 'root',
    children: [el('w:document', [['xmlns:w', W_NS], ['xmlns:r', R_NS]], [el('w:body', [], bodyChildren)])],
  });

  const stylesXml = serializeXml({
    type: 'root',
    children: [el('w:styles', [['xmlns:w', W_NS]], [
      el('w:style', [['w:type', 'paragraph'], ['w:default', '1'], ['w:styleId', 'Normal']], [
        el('w:name', [['w:val', 'Normal']]),
      ]),
    ])],
  });

  const rootRelsXml = serializeXml({
    type: 'root',
    children: [el('Relationships', [['xmlns', PKG_REL_NS]], [
      el('Relationship', [
        ['Id', 'rId1'],
        ['Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'],
        ['Target', 'word/document.xml'],
      ]),
    ])],
  });

  const docRelsXml = serializeXml({
    type: 'root',
    children: [el('Relationships', [['xmlns', PKG_REL_NS]], [
      el('Relationship', [
        ['Id', 'rIdStyles'],
        ['Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles'],
        ['Target', 'styles.xml'],
      ]),
    ])],
  });

  const contentTypesXml = serializeXml({
    type: 'root',
    children: [el('Types', [['xmlns', CT_NS]], [
      el('Default', [['Extension', 'rels'], ['ContentType', 'application/vnd.openxmlformats-package.relationships+xml']]),
      el('Default', [['Extension', 'xml'], ['ContentType', 'application/xml']]),
      el('Override', [['PartName', '/word/document.xml'], ['ContentType', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']]),
      el('Override', [['PartName', '/word/styles.xml'], ['ContentType', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml']]),
    ])],
  });

  const zip = createZipHandle();
  zip.setText('[Content_Types].xml', contentTypesXml);
  zip.setText('_rels/.rels', rootRelsXml);
  zip.setText('word/document.xml', documentXml);
  zip.setText('word/_rels/document.xml.rels', docRelsXml);
  zip.setText('word/styles.xml', stylesXml);

  const bytes = await zip.toUint8Array();
  return parseGongwenDocx(bytes, fileName);
}

export async function formatGongwenDocx(docxBytes, options = {}, roleOverrides = {}) {
  const session = await parseGongwenDocx(docxBytes);
  const formatted = applyGongwenFormatting(session, options, roleOverrides);
  const bytes = await exportGongwenDocx(session, formatted);
  return {
    bytes,
    blocks: formatted.blocks,
    stats: formatted.stats,
    warnings: formatted.warnings,
    files: formatted.files,
  };
}

export function outputFileName(originalName) {
  const base = String(originalName || '公文').replace(/\.docx$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || '公文';
  return base.endsWith('-公文排版') ? base + '.docx' : base + '-公文排版.docx';
}
