import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolError } from '../public/tools-core.js';
import {
  SAMPLE_GONGWEN_TEXT,
  parseOfficialDate,
  toChineseCount,
  classifyParagraphs,
  parseXml,
  serializeXml,
  el,
  txt,
  findChild,
  findChildren,
  getAttr,
  readZip,
  buildSessionFromText,
  parseGongwenDocx,
  applyGongwenFormatting,
  formatGongwenDocx,
  outputFileName,
} from '../public/gongwen-core.js';
import { TOOLS, resolveTool, toolsMarkup } from '../public/tools.js';

const rejectOf = async (fn) => {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected rejection');
};

test('Chinese official dates normalize Chinese numerals and zero-padded months/days', () => {
  assert.equal(parseOfficialDate('二〇二六年十一月二十六日')?.formatted, '2026年11月26日');
  assert.equal(parseOfficialDate('二○二六年三月九日')?.formatted, '2026年3月9日');
  assert.equal(parseOfficialDate('2026年03月09日')?.formatted, '2026年3月9日');
  assert.equal(parseOfficialDate('2026-11-05')?.formatted, '2026年11月5日');
  assert.equal(parseOfficialDate('2026年13月1日'), null);
  assert.equal(parseOfficialDate('2026年11月'), null);
  assert.equal(toChineseCount(1), '一');
  assert.equal(toChineseCount(10), '十');
  assert.equal(toChineseCount(14), '十四');
  assert.equal(toChineseCount(23), '二十三');
});

test('structure classifier distinguishes headings from prose and handles split titles and inline attachments', () => {
  const lines = [
    '秘密★一年',
    '市政办发[2026]18号',
    'XX市人民政府办公室关于加快推进',
    '数字政府建设工作的通知',
    '——工作实施方案',
    '各区人民政府，市政府各部门：',
    '一是坚持统筹推进，避免把“一是”误判为一级标题。',
    '1.5亿元专项补助资金按季度拨付，避免把小数误判为三级标题。',
    '一、总体目标',
    '（一）完善基础底座。加快政务云平台集约化改造。',
    '1.强化数据共享。依托市级平台推进目录挂接。',
    '（1）建立常态化对账机制；',
    '附件：1.数字政府重点任务清单',
    '2.部门责任分工表',
    'XX市人民政府办公室',
    '二〇二六年十一月二十六日',
    '（此件公开发布）',
    '抄送：市委各部门，市人大常委会办公室。',
    '附件1',
    '数字政府重点任务清单',
    '一、基础能力建设',
  ].map((text) => ({ text }));

  assert.deepEqual(classifyParagraphs(lines), [
    'secret_urgent',
    'doc_no',
    'title',
    'title',
    'subtitle',
    'salutation',
    'body',
    'body',
    'h1',
    'h2',
    'h3',
    'h4',
    'attachment_list',
    'attachment_item',
    'signature',
    'date',
    'note',
    'cc',
    'attachment_marker',
    'attachment_title',
    'h1',
  ]);
});

test('rejects legacy binary .doc, RTF, encrypted ZIP and non-ZIP files with clear messages', async () => {
  const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(30).fill(0)]);
  const docErr = await rejectOf(() => readZip(ole2));
  assert.ok(docErr instanceof ToolError);
  assert.match(docErr.message, /\.doc.*\.docx/);

  const rtf = new TextEncoder().encode('{\\rtf1\\ansi\\deff0 hello world padding padding}');
  const rtfErr = await rejectOf(() => readZip(rtf));
  assert.match(rtfErr.message, /RTF/);

  const garbageErr = await rejectOf(() => readZip(new Uint8Array(64)));
  assert.ok(garbageErr instanceof ToolError);

  // Craft a minimal ZIP central directory with the encryption bit (bit 0) set.
  const session = await buildSessionFromText('关于测试的通知\n正文内容');
  const validDocx = await session.zip.toUint8Array();
  const encrypted = validDocx.slice();
  const view = new DataView(encrypted.buffer);
  for (let i = 0; i < encrypted.length - 4; i++) {
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint16(i + 8, view.getUint16(i + 8, true) | 1, true);
      break;
    }
  }
  const encErr = await rejectOf(() => readZip(encrypted));
  assert.match(encErr.message, /密码/);
});

test('sample document formats to valid GB/T 9704 OOXML with exact margins, fonts, run-in splits and footers', async () => {
  const session = await buildSessionFromText(SAMPLE_GONGWEN_TEXT, '通知草稿.docx');
  const initialBytes = await session.zip.toUint8Array();
  const { bytes, blocks, stats } = await formatGongwenDocx(initialBytes, {
    fontPreset: 'gb2312',
    latinFont: 'times',
    lineSpacing: '28',
    pageNumber: 'mirror',
    h3Bold: true,
    cleanText: true,
  });

  assert.ok(stats.removedBlankLines > 0);
  assert.ok(stats.trimmedSpaces > 0);
  assert.ok(stats.normalizedPunct > 0);
  assert.equal(stats.normalizedDates, 1);

  const byRole = (role) => blocks.find((b) => b.role === role);
  assert.equal(byRole('doc_no').text, '市政办发〔2026〕18号');
  assert.equal(byRole('title').text, '关于进一步提升政务服务标准化规范化便利化水平的通知');
  assert.equal(byRole('salutation').text, '各区、县人民政府，市政府各部门、各直属单位：');
  assert.equal(byRole('h1').text, '一、总体要求');
  assert.equal(byRole('h2').text, '（一）健全事项管理机制');
  assert.equal(byRole('date').text, '2026年11月26日');
  assert.equal(byRole('note').text, '（此件公开发布）');

  const outZip = await readZip(bytes);
  const docAst = parseXml(await outZip.text('word/document.xml'));
  const body = findChild(findChild(docAst, 'w:document'), 'w:body');
  const paragraphs = findChildren(body, 'w:p');

  // Title paragraph: 2号 (sz=44) 方正小标宋简体, centered, non-bold, after=560 (1 blank line)
  const titleP = paragraphs[1];
  const titlePPr = findChild(titleP, 'w:pPr');
  assert.equal(getAttr(findChild(titlePPr, 'w:jc'), 'w:val'), 'center');
  assert.equal(getAttr(findChild(titlePPr, 'w:spacing'), 'w:after'), '560');
  const titleRPr = findChild(findChild(titleP, 'w:r'), 'w:rPr');
  assert.equal(getAttr(findChild(titleRPr, 'w:rFonts'), 'w:eastAsia'), '方正小标宋简体');
  assert.equal(getAttr(findChild(titleRPr, 'w:sz'), 'w:val'), '44');
  assert.equal(getAttr(findChild(titleRPr, 'w:b'), 'w:val'), '0');

  // Run-in h3 paragraph: "1." (Times bold) + "统一事项要素。" (仿宋 bold) + "各部门要…" (仿宋 regular)
  const h3P = paragraphs.find((p) => serializeXml(p).includes('统一事项要素。'));
  assert.ok(h3P, 'expected split runs on run-in level-3 heading');
  const h3Runs = findChildren(h3P, 'w:r');
  assert.ok(h3Runs.length >= 3);
  assert.equal(getAttr(findChild(findChild(h3Runs[0], 'w:rPr'), 'w:b'), 'w:val'), '1');
  assert.equal(getAttr(findChild(findChild(h3Runs[0], 'w:rPr'), 'w:rFonts'), 'w:ascii'), 'Times New Roman');
  assert.equal(getAttr(findChild(findChild(h3Runs[1], 'w:rPr'), 'w:b'), 'w:val'), '1');
  assert.equal(getAttr(findChild(findChild(h3Runs[1], 'w:rPr'), 'w:rFonts'), 'w:eastAsia'), '仿宋_GB2312');
  const h3BodyRun = h3Runs[h3Runs.length - 1];
  assert.equal(getAttr(findChild(findChild(h3BodyRun, 'w:rPr'), 'w:b'), 'w:val'), '0');
  assert.equal(getAttr(findChild(findChild(h3BodyRun, 'w:rPr'), 'w:rFonts'), 'w:eastAsia'), '仿宋_GB2312');

  // Run-in h2 paragraph: lead clause in 楷体_GB2312, body clause in 仿宋_GB2312 (with “一窗综合受理” converted & protected)
  const h2RunIn = paragraphs.find((p) => serializeXml(p).includes('（二）优化线下窗口服务。'));
  assert.ok(h2RunIn, 'expected split runs on run-in level-2 heading');
  const h2Runs = findChildren(h2RunIn, 'w:r');
  assert.equal(getAttr(findChild(findChild(h2Runs[0], 'w:rPr'), 'w:rFonts'), 'w:eastAsia'), '楷体_GB2312');
  assert.equal(getAttr(findChild(findChild(h2Runs[1], 'w:rPr'), 'w:rFonts'), 'w:eastAsia'), '仿宋_GB2312');
  assert.equal(getAttr(findChild(findChild(h2Runs[1], 'w:rPr'), 'w:rFonts'), 'w:hAnsi'), '仿宋_GB2312');

  // Section properties: footerReference comes first, A4 210x297mm, margins 37/26/35/28mm
  const sectPr = findChild(body, 'w:sectPr');
  assert.equal(sectPr.children[0].name, 'w:footerReference');
  const pgSz = findChild(sectPr, 'w:pgSz');
  assert.deepEqual([getAttr(pgSz, 'w:w'), getAttr(pgSz, 'w:h')], ['11906', '16838']);
  const pgMar = findChild(sectPr, 'w:pgMar');
  assert.deepEqual(
    [getAttr(pgMar, 'w:top'), getAttr(pgMar, 'w:left'), getAttr(pgMar, 'w:bottom'), getAttr(pgMar, 'w:right')],
    ['2098', '1587', '1984', '1474'],
  );

  // Mirror page numbers create odd (right-aligned) and even (left-aligned) footers + evenAndOddHeaders
  const oddFooter = await outZip.text('word/footer_gongwen_odd.xml');
  const evenFooter = await outZip.text('word/footer_gongwen_even.xml');
  const settingsXml = await outZip.text('word/settings.xml');
  const fontTableXml = await outZip.text('word/fontTable.xml');
  assert.match(oddFooter, /w:jc w:val="right"/);
  assert.match(evenFooter, /w:jc w:val="left"/);
  assert.match(oddFooter, /PAGE/);
  assert.match(settingsXml, /evenAndOddHeaders/);
  assert.match(fontTableXml, /w:altName w:val="仿宋"/);
});

test('materializes Word automatic numbering, protects images/tables/media bytes and honors role overrides', async () => {
  const baseSession = await buildSessionFromText('占位', '带图表公文.docx');
  const zip = baseSession.zip;

  // Inject binary image entry, numbering.xml, and rich document.xml with numPr + drawing + table
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 99, 250]);
  zip.setBytes('word/media/chart1.png', fakePng);

  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  zip.setText('word/numbering.xml', serializeXml({
    type: 'root',
    children: [el('w:numbering', [['xmlns:w', W]], [
      el('w:abstractNum', [['w:abstractNumId', '1']], [
        el('w:lvl', [['w:ilvl', '0']], [
          el('w:start', [['w:val', '1']]),
          el('w:numFmt', [['w:val', 'chineseCountingThousand']]),
          el('w:lvlText', [['w:val', '%1、']]),
        ]),
        el('w:lvl', [['w:ilvl', '1']], [
          el('w:start', [['w:val', '1']]),
          el('w:numFmt', [['w:val', 'decimal']]),
          el('w:lvlText', [['w:val', '%1.']]),
        ]),
      ]),
      el('w:num', [['w:numId', '5']], [el('w:abstractNumId', [['w:val', '1']])]),
    ])],
  }));

  zip.setText('word/document.xml', serializeXml({
    type: 'root',
    children: [el('w:document', [['xmlns:w', W]], [
      el('w:body', [], [
        el('w:p', [], [el('w:r', [], [el('w:t', [], [txt('关于测试编号与图表的通知')])])]),
        el('w:p', [], [el('w:r', [], [el('w:t', [], [txt('2026年11月26日会议讨论稿')])])]),
        el('w:p', [], [
          el('w:pPr', [], [el('w:numPr', [], [el('w:ilvl', [['w:val', '0']]), el('w:numId', [['w:val', '5']])])]),
          el('w:r', [], [el('w:t', [], [txt('工作目标')])]),
        ]),
        el('w:p', [], [
          el('w:pPr', [], [el('w:numPr', [], [el('w:ilvl', [['w:val', '1']]), el('w:numId', [['w:val', '5']])])]),
          el('w:r', [], [el('w:t', [], [txt('细化落实举措')])]),
        ]),
        el('w:p', [], [el('w:r', [], [el('w:drawing', [], [el('wp:inline', [['distT', '0']])])])]),
        el('w:tbl', [], [
          el('w:tr', [], [
            el('w:tc', [], [el('w:p', [], [el('w:r', [], [el('w:t', [], [txt('序号')])])])]),
            el('w:tc', [], [el('w:p', [], [el('w:r', [], [el('w:t', [], [txt('事项')])])])]),
          ]),
        ]),
        el('w:sectPr', [], [el('w:pgSz', [['w:w', '16838'], ['w:h', '11906'], ['w:orient', 'landscape']])]),
      ]),
    ])],
  }));

  const inputBytes = await zip.toUint8Array();
  const parsed = await parseGongwenDocx(inputBytes, '带图表公文.docx');
  const formatted = applyGongwenFormatting(parsed, { fontPreset: 'universal', pageNumber: 'keep' }, { 'p-1': 'subtitle' });

  assert.equal(formatted.blocks[0].role, 'title');
  assert.equal(formatted.blocks[1].role, 'subtitle');
  assert.equal(formatted.blocks[1].overridden, true);
  assert.equal(formatted.blocks[2].role, 'h1');
  assert.equal(formatted.blocks[2].text, '一、工作目标');
  assert.equal(formatted.blocks[3].role, 'h3');
  assert.equal(formatted.blocks[3].text, '1.细化落实举措');
  assert.equal(formatted.blocks[4].kind, 'media');
  assert.equal(formatted.blocks[5].kind, 'table');
  assert.equal(formatted.stats.images, 1);
  assert.equal(formatted.stats.tables, 1);

  const { bytes: outBytes } = await formatGongwenDocx(inputBytes, { fontPreset: 'universal', pageNumber: 'keep' }, { 'p-1': 'subtitle' });
  const outZip = await readZip(outBytes);

  // Embedded image binary stays byte-identical
  assert.deepEqual(await outZip.bytes('word/media/chart1.png'), fakePng);

  const outDoc = parseXml(await outZip.text('word/document.xml'));
  const outBody = findChild(findChild(outDoc, 'w:document'), 'w:body');
  const outParas = findChildren(outBody, 'w:p');

  // Image paragraph uses auto single line spacing instead of exact 560 twips so image is not clipped
  const mediaP = outParas[4];
  assert.equal(getAttr(findChild(findChild(mediaP, 'w:pPr'), 'w:spacing'), 'w:lineRule'), 'auto');
  assert.ok(serializeXml(mediaP).includes('<w:drawing>'));

  // Landscape section orientation is preserved
  const sectPr = findChild(outBody, 'w:sectPr');
  assert.equal(getAttr(findChild(sectPr, 'w:pgSz'), 'w:orient'), 'landscape');

  assert.equal(outputFileName('通知草稿.docx'), '通知草稿-公文排版.docx');
  assert.equal(outputFileName('通知草稿-公文排版.docx'), '通知草稿-公文排版.docx');
});

test('toolbox registers gongwen tool and renders controls, upload input and export button', () => {
  assert.ok(TOOLS.some((item) => item.id === 'gongwen' && item.group === 'text'));
  assert.equal(resolveTool('gongwen'), 'gongwen');
  const html = toolsMarkup('gongwen');
  assert.match(html, /href="#tools\/gongwen" class="tool-tab active" aria-current="page"/);
  assert.match(html, /data-gw-file/);
  assert.match(html, /data-opt="fontPreset"/);
  assert.match(html, /data-opt="pageNumber"/);
  assert.match(html, /data-opt="boldSeq"/);
  assert.match(html, /data-opt="smartQuotes"/);
  assert.match(html, /data-cmd="gw-download"/);
});

test('macro 1 & 2: normalizes GB2312 fonts across styles/stories, bolds 一是–十是, protects “”—…· under Times and warns on odd quotes', async () => {
  const session = await buildSessionFromText('占位', '双宏测试.docx');
  const zip = session.zip;
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

  // styles.xml with legacy 仿宋_GB2312, 楷体_GB2312 and 小标宋
  zip.setText('word/styles.xml', serializeXml({
    type: 'root',
    children: [el('w:styles', [['xmlns:w', W]], [
      el('w:style', [['w:type', 'paragraph'], ['w:styleId', 'BodyOld']], [
        el('w:rPr', [], [el('w:rFonts', [['w:eastAsia', '仿宋_GB2312'], ['w:ascii', '仿宋_GB2312']])]),
      ]),
      el('w:style', [['w:type', 'paragraph'], ['w:styleId', 'TitleOld']], [
        el('w:rPr', [], [el('w:rFonts', [['w:eastAsia', '小标宋']])]),
      ]),
      el('w:style', [['w:type', 'character'], ['w:styleId', 'KaiOld']], [
        el('w:rPr', [], [el('w:rFonts', [['w:eastAsia', '楷体_GB2312']])]),
      ]),
    ])],
  }));

  // settings.xml with active trackRevisions
  zip.setText('word/settings.xml', serializeXml({
    type: 'root',
    children: [el('w:settings', [['xmlns:w', W]], [el('w:trackRevisions')])],
  }));

  // header1.xml with legacy font + odd straight quote + sequence word
  zip.setText('word/header1.xml', serializeXml({
    type: 'root',
    children: [el('w:hdr', [['xmlns:w', W]], [
      el('w:p', [], [
        el('w:r', [], [
          el('w:rPr', [], [el('w:rFonts', [['w:eastAsia', '仿宋_GB2312']])]),
          el('w:t', [], [txt('内部资料"未闭合引号 一是保密')]),
        ]),
      ]),
    ])],
  }));

  // document.xml with:
  // - p0: title
  // - p1: body with 一是 / 二是 / 九是 / 十是, false-positive guard "唯一是", paired quotes "高效办成一件事",
  //       ASCII "2026" & "100%", and protected punctuation — … · ‘单引’
  // - p2: body with a single unclosed straight quote "漏掉右引号
  // - p3: body after p2 with paired quotes "后续正常配对" + floating textbox (<w:txbxContent>)
  zip.setText('word/document.xml', serializeXml({
    type: 'root',
    children: [el('w:document', [['xmlns:w', W]], [
      el('w:body', [], [
        el('w:p', [], [el('w:r', [], [el('w:t', [], [txt('关于推进政务数字化改革的通知')])])]),
        el('w:p', [], [el('w:r', [], [el('w:t', [], [
          txt('工作重点（唯一是坚持底线）：一是推进"高效办成一件事"——在2026年底实现100%网办……二是强化协同·压实‘首问负责’；九是健全督导；十是严格考核。'),
        ])])]),
        el('w:p', [], [el('w:r', [], [el('w:t', [], [txt('此处存在"未闭合的英文引号测试。')])])]),
        el('w:p', [], [
          el('w:r', [], [el('w:t', [], [txt('下一段"后续正常配对"不受上一段奇数引号翻转影响。')])]),
          el('w:r', [], [
            el('w:drawing', [], [
              el('w:txbxContent', [], [
                el('w:p', [], [el('w:r', [], [
                  el('w:rPr', [], [el('w:rFonts', [['w:eastAsia', '楷体_GB2312']])]),
                  el('w:t', [], [txt('文本框"配对引号"与三是落实')]),
                ])]),
              ]),
            ]),
          ]),
        ]),
        el('w:sectPr'),
      ]),
    ])],
  }));

  const inputBytes = await zip.toUint8Array();
  const { bytes, blocks, stats, warnings } = await formatGongwenDocx(inputBytes, {
    fontPreset: 'standard',
    latinFont: 'times',
    pageNumber: 'center',
    boldSeq: true,
    smartQuotes: true,
  });

  // 1. Sequence words bolded: 一是, 二是, 九是, 十是 in body + 一是 in header + 三是 in textbox = 6 ("唯一是" excluded!)
  assert.equal(stats.boldedSeqWords, 6);
  assert.ok(stats.protectedPunct >= 7);
  assert.ok(stats.replacedFonts >= 4);

  // 2. Odd straight quotes in 正文 (5 total, p-2 unclosed) and 页眉 (1 total) both reported
  const storiesWarned = warnings.map((w) => w.story);
  assert.ok(storiesWarned.includes('正文'));
  assert.ok(storiesWarned.includes('页眉'));
  const mainWarn = warnings.find((w) => w.story === '正文');
  assert.deepEqual(mainWarn.blockIds, ['p-2']);

  // Paragraph after unclosed quote still converts its own pair cleanly without inversion
  assert.equal(blocks[3].quoteWarning, false);
  const outZip = await readZip(bytes);
  const outDocXml = await outZip.text('word/document.xml');
  assert.match(outDocXml, /“后续正常配对”/);

  // 3. Verify styles.xml replaced GB2312 & 小标宋 -> 仿宋 / 方正小标宋简体 / 楷体, and trackRevisions was cleared
  const outStyles = await outZip.text('word/styles.xml');
  assert.doesNotMatch(outStyles, /仿宋_GB2312|楷体_GB2312|"小标宋"/);
  assert.match(outStyles, /方正小标宋简体/);
  const outSettings = await outZip.text('word/settings.xml');
  assert.doesNotMatch(outSettings, /trackRevisions/);

  // 4. Verify header1.xml and textbox normalized fonts and bolded sequence words
  const outHeader = await outZip.text('word/header1.xml');
  assert.doesNotMatch(outHeader, /仿宋_GB2312/);
  assert.match(outHeader, /“未闭合引号/);

  // 5. Verify Times New Roman vs Chinese special punctuation (“ ” ‘ ’ — … ·) run isolation in p1
  const outAst = parseXml(outDocXml);
  const outBody = findChild(findChild(outAst, 'w:document'), 'w:body');
  const p1 = findChildren(outBody, 'w:p')[1];
  const p1Runs = findChildren(p1, 'w:r').map((r) => {
    const rPr = findChild(r, 'w:rPr');
    const rFonts = findChild(rPr, 'w:rFonts');
    const text = findChild(r, 'w:t')?.children.map((c) => c.text).join('') || '';
    return {
      text,
      ascii: getAttr(rFonts, 'w:ascii'),
      hAnsi: getAttr(rFonts, 'w:hAnsi'),
      eastAsia: getAttr(rFonts, 'w:eastAsia'),
      bold: getAttr(findChild(rPr, 'w:b'), 'w:val'),
    };
  });

  // Every “一是/二是/九是/十是” run is bold, while "唯一是" stays unbolded
  for (const word of ['一是', '二是', '九是', '十是']) {
    const hit = p1Runs.find((r) => r.text === word);
    assert.ok(hit, `expected dedicated run for ${word}`);
    assert.equal(hit.bold, '1');
  }
  const falsePositiveRun = p1Runs.find((r) => r.text.includes('唯一是'));
  assert.equal(falsePositiveRun.bold, '0');

  // Every ASCII number ("2026", "100%") uses Times New Roman
  for (const asciiToken of ['2026', '100%']) {
    const hit = p1Runs.find((r) => r.text === asciiToken);
    assert.ok(hit, `expected dedicated ASCII run for ${asciiToken}`);
    assert.equal(hit.ascii, 'Times New Roman');
    assert.equal(hit.hAnsi, 'Times New Roman');
  }

  // Every protected punctuation mark (“ ” ‘ ’ — … ·) sits in a run whose hAnsi & ascii are 仿宋 (NEVER Times New Roman!)
  for (const mark of ['“', '”', '‘', '’', '—', '…', '·']) {
    const matchingRuns = p1Runs.filter((r) => r.text.includes(mark));
    assert.ok(matchingRuns.length > 0, `expected run containing ${mark}`);
    for (const r of matchingRuns) {
      assert.equal(r.ascii, '仿宋', `expected ${mark} ascii font to stay 仿宋`);
      assert.equal(r.hAnsi, '仿宋', `expected ${mark} hAnsi font to stay 仿宋`);
    }
  }

  // Footer page-number dashes “—” stay 宋体 even when page digits use Times New Roman
  const footerAst = parseXml(await outZip.text('word/footer_gongwen_odd.xml'));
  const footerRuns = findChildren(findChild(findChild(footerAst, 'w:ftr'), 'w:p'), 'w:r');
  const firstDashFonts = findChild(findChild(footerRuns[0], 'w:rPr'), 'w:rFonts');
  assert.equal(getAttr(firstDashFonts, 'w:hAnsi'), '宋体');
});

test('replaces dark colored table headers with elegant/three-line styles, parses pipe tables, and handles report headings/bullets', async () => {
  // 1. Plain-text report with "事项" title, pipe table, standalone "1.xxx。" h3, decimal headings and bullets
  const reportText = [
    '新通话、来电管家属地重点需求及支撑事项',
    '结合近期业务推广情况，拟重点协调以下方面给予支持。',
    '一、前期重点需求及支撑情况',
    '2.1能开签约平台：在线订购与“余额/余量”主阵地',
    '• 源表与关联主表：能开签约企业表直连计费中心。',
    '| 时间 | 需求事项 | 互联网公司支撑情况 |',
    '| 2026年1月 | AI秘书计费及功能优化：围绕计费点落地提出优化需求 | 已评估反馈 |',
    '| 2026年2月 | AI速记计费模式优化：增加单次付费模式 | 纳入试点 |',
    '二、建议重点协调事项',
    '1.产品问题加快闭环。',
    '加快端到端测试问题整改。',
  ].join('\n');

  const reportSession = await buildSessionFromText(reportText, '属地重点需求.docx');
  const reportFormatted = applyGongwenFormatting(reportSession, { tableFormat: 'elegant', boldSeq: true });

  assert.equal(reportFormatted.blocks[0].role, 'title');
  assert.equal(reportFormatted.blocks[2].role, 'h1');
  assert.equal(reportFormatted.blocks[3].role, 'h2');
  assert.equal(reportFormatted.blocks[3].text, '2.1 能开签约平台：在线订购与“余额/余量”主阵地');
  // Bullet lead "• 源表与关联主表：" is tokenized as bold sequence lead
  assert.equal(reportFormatted.blocks[4].tokens[0].text, '• 源表与关联主表：');
  assert.equal(reportFormatted.blocks[4].tokens[0].seq, true);
  // Pipe table converted to real 3x3 table with previewRows
  const tblBlock = reportFormatted.blocks[5];
  assert.equal(tblBlock.kind, 'table');
  assert.equal(tblBlock.rows, 3);
  assert.equal(tblBlock.cols, 3);
  assert.equal(tblBlock.previewRows[0][0].text, '时间');
  assert.equal(tblBlock.previewRows[1][1].tokens[0].text, 'AI秘书计费及功能优化：');
  assert.equal(tblBlock.previewRows[1][1].tokens[0].seq, true);
  // Standalone h3 "1.产品问题加快闭环。" preserves its trailing period
  assert.equal(reportFormatted.blocks[7].role, 'h3');
  assert.equal(reportFormatted.blocks[7].text, '1.产品问题加快闭环。');

  // 2. Uploaded .docx with ugly dark blue (#1F4E79) header shading and white borders is cleaned
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const darkZip = reportSession.zip;
  darkZip.setText('word/document.xml', serializeXml({
    type: 'root',
    children: [el('w:document', [['xmlns:w', W]], [
      el('w:body', [], [
        el('w:p', [], [el('w:r', [], [el('w:t', [], [txt('字段口径说明事项')])])]),
        el('w:tbl', [], [
          el('w:tblPr', [], [el('w:tblStyle', [['w:val', 'GridTable4-Accent1']])]),
          el('w:tr', [], [
            el('w:tc', [], [
              el('w:tcPr', [], [
                el('w:tcBorders', [], [el('w:right', [['w:val', 'single'], ['w:color', 'FFFFFF']])]),
                el('w:shd', [['w:val', 'clear'], ['w:fill', '1F4E79']]),
              ]),
              el('w:p', [], [el('w:r', [], [
                el('w:rPr', [], [el('w:color', [['w:val', 'FFFFFF']]), el('w:b')]),
                el('w:t', [], [txt('字段英文名')]),
              ])]),
            ]),
            el('w:tc', [], [
              el('w:tcPr', [], [el('w:shd', [['w:val', 'clear'], ['w:fill', '1F4E79']])]),
              el('w:p', [], [el('w:r', [], [el('w:t', [], [txt('取值口径')])])]),
            ]),
          ]),
          el('w:tr', [], [
            el('w:tc', [], [
              el('w:tcPr', [], [el('w:shd', [['w:val', 'clear'], ['w:fill', 'D9E2F3']])]),
              el('w:p', [], [el('w:r', [], [el('w:t', [], [txt('app_id')])])]),
            ]),
            el('w:tc', [], [
              el('w:p', [], [
                el('w:r', [], [el('w:rPr', [], [el('w:b')]), el('w:t', [], [txt('一期口径')])]),
                el('w:r', [], [el('w:t', [], [txt('：关联计费主表')])]),
              ]),
            ]),
          ]),
        ]),
        el('w:sectPr'),
      ]),
    ])],
  }));

  const rawDark = await darkZip.toUint8Array();
  const { bytes: elegantBytes } = await formatGongwenDocx(rawDark, { tableFormat: 'elegant' });
  const elegantDocXml = await (await readZip(elegantBytes)).text('word/document.xml');
  assert.doesNotMatch(elegantDocXml, /1F4E79|D9E2F3|GridTable4-Accent1|"FFFFFF"/);
  assert.match(elegantDocXml, /w:fill="F2F4F7"/);
  assert.match(elegantDocXml, /<w:tblHeader\/>/);

  const { bytes: threeBytes } = await formatGongwenDocx(rawDark, { tableFormat: 'three' });
  const threeDocXml = await (await readZip(threeBytes)).text('word/document.xml');
  assert.doesNotMatch(threeDocXml, /w:fill="F2F4F7"|1F4E79/);
  assert.match(threeDocXml, /w:insideV w:val="none"/);
});



