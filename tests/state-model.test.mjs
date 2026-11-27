import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateState, normalizeUrl, localHostname, siteMetadata, StateError } from '../public/state-model.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/state-cases.json', import.meta.url), 'utf8'));
const knownSites = JSON.parse(await readFile(new URL('../public/known-sites.json', import.meta.url), 'utf8'));

test('validateState gives server.py\'s answer for every shared case', () => {
  for (const item of fixture.cases) {
    if (item.error) {
      assert.throws(() => validateState(item.input), (error) => error instanceof StateError && error.message === item.error, item.name);
    } else {
      assert.deepEqual(validateState(item.input), item.expect, item.name);
    }
  }
});

test('normalizeUrl keeps paths as typed and adds the scheme by host', () => {
  assert.equal(normalizeUrl('nas.home:5000'), 'http://nas.home:5000');
  assert.equal(normalizeUrl('github.com/clam314'), 'https://github.com/clam314');
  assert.equal(normalizeUrl('https://EXAMPLE.com/A?B=C'), 'https://example.com/A?B=C');
  assert.throws(() => normalizeUrl('javascript:alert(1)'), /仅支持/);
});

test('localHostname recognizes LAN names and private addresses', () => {
  for (const host of ['localhost', 'nas.lan', 'tv.local', 'box.home', '10.1.2.3', '172.16.0.1', '192.168.50.1', '127.0.0.1', '169.254.1.1', '[::1]', 'fd00::1', 'fe80::1']) assert.equal(localHostname(host), true, host);
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '[2001:db8::1]', 'locallan.com']) assert.equal(localHostname(host), false, host);
});

test('siteMetadata answers from the shared table like server.py', () => {
  const categories = [{ id: 'dev', name: '开发工具' }, { id: 'work', name: '效率办公' }, { id: 'shelf', name: '开发工具', area: 'archive' }];
  assert.deepEqual(siteMetadata('www.github.com/x', categories, knownSites), { url: 'https://www.github.com/x', name: 'GitHub', icon: 'github', categoryId: 'dev', kind: 'website' });
  // 办公 falls back through its aliases to 效率办公.
  assert.equal(siteMetadata('docs.qq.com', categories, knownSites).categoryId, 'work');
  assert.deepEqual(siteMetadata('192.168.1.2:8096', categories, knownSites), { url: 'http://192.168.1.2:8096', name: '192.168.1.2', icon: '', categoryId: null, kind: 'service' });
});
