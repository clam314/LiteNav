import test from 'node:test';
import assert from 'node:assert/strict';
import { recordOpen, decayedScore, recentIds, byUse, createUsageStore, HALF_LIFE_MS, USAGE_KEY } from '../public/usage.js';
import { searchableLinks, omniboxSuggestions, omniboxTarget } from '../public/omnibox.js';

const DAY = 24 * 60 * 60 * 1000;

test('opens fade with a two-week half-life, so frequent means lately', () => {
  let usage = {};
  const start = Date.parse('2026-11-01T00:00:00Z');
  for (let i = 0; i < 4; i += 1) usage = recordOpen(usage, 'old', start + i);
  usage = recordOpen(usage, 'new', start + 28 * DAY);
  usage = recordOpen(usage, 'new', start + 28 * DAY + 1);
  const now = start + 28 * DAY + 2;
  assert.ok(Math.abs(decayedScore(usage.old, now) - 1) < 0.01, 'four opens a month ago weigh one');
  assert.ok(decayedScore(usage.new, now) > 1.99);
  assert.equal(usage.old.count, 4);
  assert.deepEqual(recentIds(usage), ['new', 'old']);
  const links = [{ id: 'old' }, { id: 'never' }, { id: 'new' }];
  assert.deepEqual(byUse(links, usage, now).map((link) => link.id), ['new', 'old', 'never']);
  assert.equal(decayedScore(undefined), 0);
  assert.equal(HALF_LIFE_MS, 14 * DAY);
});

test('the usage store counts quick opens one after another and can be cleared', async () => {
  const data = {};
  const area = { async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; }, async set(items) { Object.assign(data, structuredClone(items)); } };
  let time = 1000;
  const store = createUsageStore(area, () => time++);
  await Promise.all([store.record('a'), store.record('a'), store.record('b')]);
  const usage = await store.load();
  assert.equal(usage.a.count, 2);
  assert.equal(usage.b.count, 1);
  assert.deepEqual(await store.clear(), {});
  assert.deepEqual(data[USAGE_KEY], {});
});

test('the address bar suggests 轻航 sites, escaped, and opens the best match', () => {
  const state = {
    categories: [{ id: 'dev', name: '开发' }, { id: 'shelf', name: '杂', area: 'archive' }],
    links: [
      { id: 'gh', name: 'GitHub <Code> & more', url: 'https://github.com/', kind: 'website', categoryId: 'dev', order: 0 },
      { id: 'gl', name: 'GitLab', url: 'https://gitlab.com/', kind: 'website', categoryId: 'shelf', order: 1 },
      { id: 'nas', name: '群晖', url: 'http://nas.lan:5000/', kind: 'service', categoryId: null, order: 2 },
    ],
  };
  const links = searchableLinks(state);
  assert.equal(links.find((link) => link.id === 'gl').archived, true);
  const suggestions = omniboxSuggestions(links, 'git');
  assert.deepEqual(suggestions.map((item) => item.content), ['https://github.com/', 'https://gitlab.com/']);
  assert.equal(suggestions[0].description, '<match>GitHub &lt;Code&gt; &amp; more</match> <dim>github.com</dim>');
  assert.match(omniboxSuggestions(links, 'qh')[0].description, /· 服务/, 'pinyin initials find 群晖');
  assert.equal(omniboxTarget(links, 'https://gitlab.com/').id, 'gl');
  assert.equal(omniboxTarget(links, 'hub').id, 'gh');
  assert.equal(omniboxTarget(links, 'nothing-like-this'), null);
});
