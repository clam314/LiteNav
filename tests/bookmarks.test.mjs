import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBookmarks, decodeEntities } from '../public/bookmarks.js';

const chrome = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>
    <DL><p>
        <DT><A HREF="https://github.com/" ADD_DATE="1" ICON="data:image/png;base64,AAAA">GitHub</A>
        <DT><H3 ADD_DATE="1">开发</H3>
        <DL><p>
            <DT><A HREF="https://developer.mozilla.org/">MDN &amp; Docs</A>
            <DT><H3>前端</H3>
            <DL><p>
                <DT><A HREF="https://vuejs.org/">Vue</A>
            </DL><p>
        </DL><p>
        <DT><A HREF="javascript:void(0)">Bookmarklet</A>
    </DL><p>
    <DT><H3>其他书签</H3>
    <DL><p>
        <DT><A HREF="https://www.bilibili.com/">哔哩哔哩</A>
    </DL><p>
    <DT><A HREF="http://192.168.1.2:5000/">NAS</A>
</DL><p>`;

test('groups bookmarks by top-level folder and merges sub-folders', () => {
  const { groups, skipped } = parseBookmarks(chrome);
  assert.equal(skipped, 1);
  assert.deepEqual(groups.map((group) => [group.name, group.links.map((link) => link.name)]), [
    ['书签栏', ['GitHub']],
    ['开发', ['MDN & Docs', 'Vue']],
    ['其他书签', ['哔哩哔哩']],
    ['未分类', ['NAS']],
  ]);
  assert.equal(groups[1].links[1].url, 'https://vuejs.org/');
});

test('Firefox roots: menu links are unsorted, toolbar and unfiled folders are containers', () => {
  const firefox = `<H1>Bookmarks Menu</H1><DL><p>
    <DT><A HREF="https://www.mozilla.org/">Mozilla</A>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Toolbar</H3>
    <DL><p><DT><H3>Tools</H3><DL><p><DT><A HREF="https://example.com/?a=1&amp;b=2">Example</A></DL><p></DL><p>
    <DT><H3 UNFILED_BOOKMARKS_FOLDER="true">Other Bookmarks</H3>
    <DL><p><DT><A HREF="https://news.ycombinator.com/">HN</A></DL><p>
  </DL>`;
  const { groups } = parseBookmarks(firefox);
  assert.deepEqual(groups.map((group) => group.name), ['未分类', 'Tools', 'Other Bookmarks']);
  assert.equal(groups[1].links[0].url, 'https://example.com/?a=1&b=2');
});

test('returns nothing for files without links', () => {
  assert.deepEqual(parseBookmarks('<html><body>hello</body></html>'), { groups: [], skipped: 0 });
  assert.equal(decodeEntities('&#x4e2d;&#25991;&lt;'), '中文<');
});
