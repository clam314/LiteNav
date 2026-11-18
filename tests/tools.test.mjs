import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolError, parseJson, stringifyJson, parseYaml, formatYaml, stringifyYaml, jsonToYaml, yamlToJson,
  formatSql, convertTime, detectTimestamp, parseDateInput, encodeUrl, decodeUrl, parseQuery, cleanLines,
} from '../public/tools-core.js';

const errorOf = (fn) => { try { fn(); } catch (error) { return error; } assert.fail('expected an error'); };

test('JSON formatting keeps key order, number text and 64-bit integers', () => {
  const { value } = parseJson('{"b":1,"a":[9007199254740993,1.50,-0.0,1e3],"c":{"d":null,"e":"中文"}}');
  assert.equal(stringifyJson(value, ''), '{"b":1,"a":[9007199254740993,1.50,-0.0,1e3],"c":{"d":null,"e":"中文"}}');
  assert.equal(stringifyJson(value, '  ').split('\n')[1], '  "b": 1,');
});

test('JSON errors report line and column', () => {
  const missing = errorOf(() => parseJson('{\n  "a": [1, 2]\n  "b": 2\n}'));
  assert.ok(missing instanceof ToolError);
  assert.deepEqual([missing.line, missing.column, missing.message], [2, 14, '这一行末尾缺少逗号']);
  assert.equal(errorOf(() => parseJson('[1, 2,]')).message, '数组末尾多了一个逗号');
  assert.equal(errorOf(() => parseJson("{'a': 1}")).message, '键名必须使用双引号');
  assert.equal(errorOf(() => parseJson('{"a": 01}')).line, 1);
  assert.equal(errorOf(() => parseJson('{"a": 1} x')).message, 'JSON 已经结束，后面还有多余内容');
});

test('JSON duplicate keys are reported with their line', () => {
  const { duplicates } = parseJson('{\n"a": 1,\n"a": 2\n}');
  assert.deepEqual(duplicates.map(({ key, line }) => [key, line]), [['a', 3]]);
});

const compose = `# 服务
services:
    web:
        image: nginx:1.27   # 前端
        ports:
        - "8080:80"
        command:
          - sh
          - |
            echo hi
            exec nginx
    db: {image: postgres, ports: [5432]}
---
kind: Second
`;

test('YAML formatting re-indents but keeps comments and values as written', () => {
  const { text, documents } = formatYaml(compose);
  assert.equal(documents.length, 2);
  assert.equal(text, `# 服务
services:
  web:
    image: nginx:1.27   # 前端
    ports:
      - "8080:80"
    command:
      - sh
      - |
        echo hi
        exec nginx
  db: {image: postgres, ports: [5432]}
---
kind: Second`);
  const four = formatYaml(compose, { indent: 4 }).text;
  assert.deepEqual(parseYaml(four).documents, parseYaml(compose).documents);
});

test('YAML errors point at the offending line', () => {
  assert.equal(errorOf(() => parseYaml('a: 1\n  b: 2')).line, 2);
  assert.equal(errorOf(() => parseYaml('a: 1\na: 2')).message, '重复的键「a」');
  assert.equal(errorOf(() => parseYaml('a:\n\t- x')).message, '缩进不能使用 Tab，请改用空格');
  assert.match(errorOf(() => parseYaml('a: b: c')).message, /引号/);
});

test('YAML scalars follow the core schema', () => {
  const json = yamlToJson('a: 0x1F\nb: "007"\nc: yes\nd: ~\ne: >-\n  one\n  two\nf: 12345678901234567890\n').text;
  assert.deepEqual(JSON.parse(json), { a: 31, b: '007', c: 'yes', d: null, e: 'one two', f: 12345678901234567890 });
  assert.match(json, /"f": 12345678901234567890/);
});

test('JSON and YAML convert both ways without loss', () => {
  const source = '{"name":"web","on":true,"port":"8080","empty":"","list":[{"a":1,"b":[]}],"text":"line1\\nline2\\n","colon":"a: b","nested":[[1,2]]}';
  const yaml = jsonToYaml(source);
  assert.match(yaml, /port: '8080'/);
  assert.match(yaml, /text: \|\n {2}line1\n {2}line2/);
  assert.equal(yamlToJson(yaml, { indent: '' }).text, source);
  assert.equal(yamlToJson('a: 1\n---\nb: 2').documents, 2);
});

test('SQL is laid out with uppercase keywords and nested subqueries', () => {
  const sql = "select a.id, count(*) cnt from users a left join orders o on o.uid = a.id and o.paid = 1 where a.age between 18 and 30 and a.id in (select uid from vip) group by a.id order by cnt desc";
  assert.equal(formatSql(sql), `SELECT
  a.id,
  COUNT(*) cnt
FROM
  users a
  LEFT JOIN orders o ON o.uid = a.id
    AND o.paid = 1
WHERE
  a.age BETWEEN 18 AND 30
  AND a.id IN (
    SELECT
      uid
    FROM
      vip
  )
GROUP BY
  a.id
ORDER BY
  cnt DESC`);
  assert.equal(formatSql("select 'from where' -- note\n, x from t", { minify: true }), "SELECT 'from where' /* note */, x FROM t");
  assert.equal(formatSql('select a from t', { uppercase: false }).split('\n')[0], 'select');
});

test('timestamps are detected by length and converted in a time zone', () => {
  assert.equal(detectTimestamp('1773028800').unit, 'seconds');
  assert.equal(detectTimestamp('1773028800123').unit, 'milliseconds');
  assert.equal(detectTimestamp('1773028800123456').ms, 1773028800123);
  const result = convertTime('1773028800', 'Asia/Shanghai', 1773028800000);
  assert.equal(result.zoned, '2026-03-09 12:00:00');
  assert.equal(result.offset, '+08:00');
  assert.equal(result.relative, '就是现在');
  assert.equal(parseDateInput('2026-03-09 12:00:00', 'Asia/Shanghai'), 1773028800000);
  assert.equal(parseDateInput('2026年3月9日 12:00', 'Asia/Shanghai'), 1773028800000);
  assert.equal(parseDateInput('2026-03-09T04:00:00Z', 'Asia/Tokyo'), 1773028800000);
  assert.throws(() => parseDateInput('2026-02-30', 'UTC'), ToolError);
});

test('URL encoding, lenient decoding and query parsing', () => {
  assert.equal(encodeUrl('a b&中'), 'a%20b%26%E4%B8%AD');
  assert.equal(encodeUrl('https://x.com/?q=中 文', { scope: 'uri' }), 'https://x.com/?q=%E4%B8%AD%20%E6%96%87');
  assert.deepEqual(decodeUrl('%E4%B8%AD+%ZZ'), { text: '中+%ZZ', invalid: false });
  assert.equal(decodeUrl('%E4%B8%AD+a', { plusAsSpace: true }).text, '中 a');
  assert.equal(decodeUrl('%E4%B8').invalid, true);
  assert.equal(decodeUrl('%D6%D0%CE%C4', { charset: 'gbk' }).text, '中文');
  assert.deepEqual(parseQuery('https://a.com/s?wd=%E4%B8%AD+1&flag#top'), [['wd', '中 1'], ['flag', '']]);
  assert.deepEqual(parseQuery('https://a.com/path'), []);
});

test('line cleanup trims, drops blanks, dedupes and sorts naturally', () => {
  const { text, stats } = cleanLines(' 10.0.0.2\n\n10.0.0.10 \n10.0.0.2\nA\na', { sort: 'asc', ignoreCase: true });
  assert.equal(text, '10.0.0.2\n10.0.0.10\nA');
  assert.deepEqual(stats, { total: 6, kept: 3, empty: 1, duplicates: 2 });
  assert.equal(cleanLines('a, b;c  a', { split: 'smart' }).text, 'a\nb\nc');
  assert.equal(cleanLines('b\na\nb', { dedupe: false, sort: 'desc' }).text, 'b\nb\na');
});

test('stringifyYaml quotes strings that would change type', () => {
  assert.equal(stringifyYaml(new Map([['a', 'true'], ['b', '1.0'], ['c', '- x'], ['d', '#tag'], ['e', 'plain text']])), "a: 'true'\nb: '1.0'\nc: '- x'\nd: '#tag'\ne: plain text");
});
