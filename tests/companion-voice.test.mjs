import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceUrl } from '../public/companion-voice.js';

test('a voice line is fetched from the pinned commit, and only for a well-formed path', () => {
  const base = 'https://raw.githubusercontent.com/Fernando2603/AzurLane/';
  assert.equal(voiceUrl(base, 'abc123', '306071/login'), base + 'abc123/audio/voiceline/306071/login.ogg');
  for (const path of [undefined, '', '306071', '../x/login', '306071/login.ogg', '306071/log in', 7]) {
    assert.equal(voiceUrl(base, 'abc123', path), null, String(path));
  }
  assert.equal(voiceUrl(base, undefined, '306071/login'), null, 'a catalog without voices plays none');
  assert.equal(voiceUrl(undefined, 'abc123', '306071/login'), null);
});

test('a refused line stops further downloads until the viewer clicks or presses a key', async t => {
  const plays = [];
  let refuse = true;
  globalThis.Audio = class {
    constructor() { this.paused = true; }
    async play() {
      if (refuse) { const error = new Error('not allowed'); error.name = 'NotAllowedError'; throw error; }
      this.paused = false;
      plays.push(this.src);
    }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; }
    load() {}
  };
  t.after(() => { delete globalThis.Audio; });
  const fetched = [];
  const fetchAsset = async url => { fetched.push(url); return new Response(new Blob(['ogg'])); };
  const page = new EventTarget();
  const { createVoice } = await import('../public/companion-voice.js');
  const voice = createVoice({ fetchAsset, target: page });
  const first = {};
  const second = {};
  await voice.play('a.ogg', 0.5, first);
  await voice.play('b.ogg', 0.5, first);
  assert.deepEqual(fetched, ['a.ogg'], 'after a refusal the next line is not even downloaded');
  page.dispatchEvent(new Event('pointerdown'));
  refuse = false;
  await voice.play('c.ogg', 0.5, first);
  assert.deepEqual(fetched, ['a.ogg', 'c.ogg']);
  assert.equal(plays.length, 1);
  assert.equal(voice.owner, first);
  voice.stop(second);
  assert.equal(voice.owner, first, 'another display leaving does not cut this line');
  await voice.play('d.ogg', 0.5, second);
  assert.equal(voice.owner, second, 'a new line replaces the one before');
  voice.stop(second);
  assert.equal(voice.owner, null);
  voice.dispose();
  refuse = true;
  await voice.play('e.ogg', 0.5, first);
  page.dispatchEvent(new Event('keydown'));
  await voice.play('f.ogg', 0.5, first);
  assert.equal(fetched.at(-1), 'e.ogg');
  assert.ok(!fetched.includes('f.ogg'), 'once disposed, key presses no longer re-enable it');
});
