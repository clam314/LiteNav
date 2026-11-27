import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, countText, diffSequences, diffText, foldUnchanged, diffReport, tokenize, CLEAN_DEFAULTS } from '../public/text-tools.js';

const only = (rule) => Object.fromEntries(Object.keys(CLEAN_DEFAULTS).map((key) => [key, key === rule]));

test('cleaning AI answers strips Markdown and keeps tables as tab-separated rows', () => {
  const source = '## 一、总体目标\n\n**重点**推进*试点*，详见[通知](https://example.gov/a)。\n\n- 第一项\n- [x] 第二项\n> 引用一句\n\n| 项目 | 数量 |\n|---|---:|\n| 平台 | 3 |\n\n```js\nconst snake_case = 1;\n```\n---\n用`代码`和 ~~删除线~~，snake_case_name 不变';
  const { text, counts } = cleanText(source, only('markdown'));
  assert.equal(text, '一、总体目标\n\n重点推进试点，详见通知（https://example.gov/a）。\n\n第一项\n第二项\n引用一句\n\n项目\t数量\n平台\t3\n\nconst snake_case = 1;\n用代码和 删除线，snake_case_name 不变');
  assert.ok(counts.markdown >= 10);
});

test('Chinese text loses stray spaces and gets full-width punctuation, and no spaces are added', () => {
  const source = '今年要 完成 30 个项目,覆盖 5 个城市;重点推进 AI 应用落地.\n(注:具体安排以"正式通知"为准)\n建设 统一平台 ,实现数据共享。。\n版本 1.0 发布于 10:30，费用 1,000 元，见 https://a.com/b?x=1,2';
  const { text } = cleanText(source);
  assert.equal(text, '今年要完成30个项目，覆盖5个城市；重点推进AI应用落地。\n（注：具体安排以“正式通知”为准）\n建设统一平台，实现数据共享。\n版本1.0发布于10:30，费用1,000元，见https://a.com/b?x=1,2');
  // English stays English, and nothing gains a space.
  assert.equal(cleanText('Hello, world. It works!').text, 'Hello, world. It works!');
  assert.equal(cleanText('中文English混排').text, '中文English混排');
  // With the space rules off, existing spaces stay.
  assert.equal(cleanText('完成 30 个', { mixedSpaces: false }).text, '完成 30 个');
});

test('invisible characters, full-width letters and blank lines are cleaned', () => {
  const { text, counts } = cleanText('﻿第一​行 内容  \n\n\n\nＡＢＣ１２３\n\n', { markdown: false });
  assert.equal(text, '第一行内容\n\nABC123');
  assert.ok(counts.invisible >= 3 && counts.fullwidthAlnum === 6 && counts.blankLines >= 2);
  // A paragraph's full-width indent stays.
  assert.equal(cleanText('　　正文第一段。').text, '　　正文第一段。');
});

test('lines broken at a PDF page edge join back into paragraphs', () => {
  const source = [
    '为进一步提升政务服务质量，推动各项工作落实落',
    '细，现就有关事项通知如下。',
    '一、总体要求',
    '坚持问题导向，聚焦企业和群众办事中的堵点难点，',
    '持续优化办事流程。',
    '',
    'The quick brown fox jumps over the lazy dog and keeps run-',
    'ning across the wide green field until it is tired.',
  ].join('\n');
  const { text, counts } = cleanText(source, only('mergeLines'));
  assert.equal(text, '为进一步提升政务服务质量，推动各项工作落实落细，现就有关事项通知如下。\n一、总体要求\n坚持问题导向，聚焦企业和群众办事中的堵点难点，持续优化办事流程。\n\nThe quick brown fox jumps over the lazy dog and keeps running across the wide green field until it is tired.');
  assert.equal(counts.mergeLines, 3);
});

test("word counts follow Word's 字数 and give reading time", () => {
  const stats = countText('轻航 LiteNav 是一个导航页，2026 年发布了 v1.5 版本。\n\n第二段：Hello world!');
  assert.equal(stats.han, 17);
  assert.equal(stats.cjkPunct, 3);
  // LiteNav, 2026, v1.5, Hello, world! — each one word, as in Word.
  assert.equal(stats.latin, 5);
  assert.equal(stats.words, 17 + 3 + 5);
  assert.equal(stats.paragraphs, 2);
  assert.equal(stats.lines, 3);
  assert.equal(stats.nonSpace, [...'轻航LiteNav是一个导航页，2026年发布了v1.5版本。第二段：Helloworld!'].length);
  assert.ok(stats.readMinutes > 0 && stats.speakMinutes > stats.readMinutes);
  assert.deepEqual(countText(''), { ...countText(''), words: 0, lines: 0, paragraphs: 0, chars: 0 });
});

// The longest common subsequence by brute force, for checking the diff.
function lcsLength(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) {
    table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
  }
  return table[a.length][b.length];
}

test('the diff is a shortest edit script that rebuilds the new text', () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 400; round += 1) {
    const a = Array.from({ length: Math.floor(random() * 14) }, () => 'abcd'[Math.floor(random() * 4)]);
    const b = Array.from({ length: Math.floor(random() * 14) }, () => 'abcd'[Math.floor(random() * 4)]);
    const ops = diffSequences(a, b);
    const rebuilt = [];
    let fromA = 0;
    for (const op of ops) {
      if (op[0] === '=') { assert.equal(a[op[1]], b[op[2]]); rebuilt.push(b[op[2]]); fromA += 1; }
      else if (op[0] === '+') rebuilt.push(b[op[1]]);
      else fromA += 1;
    }
    assert.deepEqual(rebuilt, b, a.join('') + ' → ' + b.join(''));
    assert.equal(fromA, a.length);
    assert.equal(ops.filter((op) => op[0] === '=').length, lcsLength(a, b), 'as few edits as possible');
  }
  assert.equal(diffSequences([...'abc'], [...'xyz'], 1), null, 'too many edits gives up');
});

test('text comparison marks Chinese by character and English by word', () => {
  const before = '各单位要高度重视，认真组织实施。\n第二段保持不变。\n请于11月30日前报送材料。';
  const after = '各单位要高度重视，精心组织实施。\n第二段保持不变。\n请于12月5日前报送书面材料。';
  const { merged, left, right, stats } = diffText(before, after);
  // A date changed as a whole reads as one change, not three.
  assert.equal(diffReport(merged), '各单位要高度重视，【删：认真】【增：精心】组织实施。\n第二段保持不变。\n请于【删：11月30】【增：12月5】日前报送【增：书面】材料。');
  assert.deepEqual(stats, { inserted: 8, deleted: 7, changes: 3, same: false });
  assert.equal(left.filter((segment) => segment.type === 'del').map((segment) => segment.text).join('|'), '认真|11月30');
  assert.equal(right.filter((segment) => segment.type === 'ins').map((segment) => segment.text).join('|'), '精心|12月5|书面');
  assert.equal(diffReport(diffText('确保各项任务落到实处。', '确保各项任务按期落实。').merged), '确保各项任务【删：落到实处】【增：按期落实】。');
  assert.deepEqual(tokenize('Hello 世界2026'), ['Hello', ' ', '世', '界', '2026']);
  assert.equal(diffReport(diffText('the quick fox', 'the slow fox').merged), 'the 【删：quick】【增：slow】 fox');
  assert.equal(diffReport(diffText('the quick brown fox', 'the slow red fox').merged), 'the 【删：quick brown】【增：slow red】 fox');
  // Line breaks never join changes on separate lines.
  assert.equal(diffReport(diffText('甲\n乙', '丙\n丁').merged), '【删：甲】【增：丙】\n【删：乙】【增：丁】');
});

test('spaces, punctuation and case can be ignored, and unchanged stretches fold', () => {
  assert.equal(diffText('完成 30 个项目,覆盖全市', '完成30个项目，覆盖全市').stats.same, false);
  assert.equal(diffText('完成 30 个项目,覆盖全市', '完成30个项目，覆盖全市', { ignoreWhitespace: true, ignorePunct: true }).stats.same, true);
  assert.equal(diffText('Hello World', 'hello world', { ignoreCase: true }).stats.same, true);
  const before = Array.from({ length: 20 }, (_, i) => '第' + (i + 1) + '行').join('\n');
  const after = before.replace('第10行', '第十行');
  const folded = foldUnchanged(diffText(before, after).merged);
  assert.deepEqual(folded.filter((segment) => segment.type === 'gap').map((segment) => segment.lines), [7, 8]);
  assert.match(diffReport(folded), /（7 行未改动）[\s\S]*第8行\n第9行\n第【删：10】【增：十】行\n第11行\n第12行[\s\S]*（8 行未改动）/);
});
