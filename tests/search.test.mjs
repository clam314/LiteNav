import test from 'node:test';
import assert from 'node:assert/strict';
import { initials, searchLinks, googleSearchUrl } from '../public/search.js';

const links = [
  { id: 'a', name: '百度', url: 'https://www.baidu.com', kind: 'website', order: 0 },
  { id: 'b', name: '哔哩哔哩', url: 'https://www.bilibili.com', kind: 'website', order: 1 },
  { id: 'c', name: 'GitHub', url: 'https://github.com', kind: 'website', order: 2, pinned: true },
  { id: 'd', name: 'NAS', url: 'http://192.168.1.2:5000', kind: 'service', order: 0, description: '群晖管理' },
];
const names = (query) => searchLinks(query, links).map((link) => link.name);

test('initials cover pinyin, words and camel case', () => {
  assert.equal(initials('哔哩哔哩'), 'blbl');
  assert.equal(initials('Google 翻译'), 'gfy');
  assert.equal(initials('GitHub'), 'gh');
});

test('matches names, pinyin initials, domains and service notes', () => {
  assert.deepEqual(names('bd'), ['百度']);
  assert.deepEqual(names('gh'), ['GitHub']);
  assert.deepEqual(names('bili'), ['哔哩哔哩']);
  assert.deepEqual(names('群晖'), ['NAS']);
  assert.deepEqual(names('git hub'), ['GitHub']);
  assert.deepEqual(names('nothing-here'), []);
  assert.deepEqual(names('  '), []);
});

test('single letters prefer word starts over letters inside names', () => {
  assert.deepEqual(names('b'), ['百度', '哔哩哔哩', 'GitHub']);
});

test('Google is the only search engine', () => {
  assert.equal(googleSearchUrl(' a&b c '), 'https://www.google.com/search?q=a%26b%20c');
});

test('sites shelved in 杂物库 are found, after everyday ones that match as well', () => {
  const shelf = [
    { id: 'old', name: 'Gitee', url: 'https://gitee.com', kind: 'website', order: 0, archived: true },
    { id: 'new', name: 'Gitea', url: 'https://gitea.com', kind: 'website', order: 1 },
  ];
  assert.deepEqual(searchLinks('git', shelf).map((link) => link.id), ['new', 'old']);
  assert.deepEqual(searchLinks('gitee', shelf).map((link) => link.id), ['old'], 'a better match still comes first');
});
