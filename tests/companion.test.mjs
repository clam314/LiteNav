import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizePreferences,
  costumeKey,
  availableCharacters,
  chooseCharacter,
  atlasPages,
  presentationForCostume,
  playableAnimations,
  isLoopingSkill,
  configureViewports,
} from '../public/companion-model.js';

const idle = skeleton => ({ skeleton });
const outfit = (name, portrait = true, skill = true) => ({
  name,
  idle: portrait ? idle(`${name}/idle`) : null,
  cutscene: skill ? idle(`${name}/skill`) : null,
});
const catalog = {
  characters: [
    { id: 'one', name: '人物一', costumes: [outfit('one-a'), outfit('one-b', true, false), outfit('one-c', false, true)] },
    { id: 'two', name: '人物二', costumes: [outfit('two-a')] },
    { id: 'three', name: '人物三', costumes: [outfit('three-a'), outfit('three-b'), outfit('three-c'), outfit('three-d')] },
    { id: 'empty', name: '缺少资源', costumes: [outfit('empty', false, false)] },
  ],
};
const preferences = overrides => normalizePreferences({ portraits: true, ...overrides });

test('new preferences default to random people with display off; legacy enabled migrates only portrait visibility', () => {
  assert.deepEqual(normalizePreferences(null), {
    random: true, portraits: false, skills: false, info: true, characterId: '', costumeKey: '', skillAction: '',
  });
  assert.deepEqual(normalizePreferences(undefined, true), {
    random: true, portraits: true, skills: false, info: true, characterId: '', costumeKey: '', skillAction: '',
  });
  assert.equal(normalizePreferences({ portraits: false }, true).portraits, false);
});

test('preferences reject truthy strings, numbers, and non-string selection IDs', () => {
  assert.deepEqual(normalizePreferences({
    random: 'false', portraits: 'true', skills: 1, info: 0,
    characterId: 42, costumeKey: { skeleton: 'bad' }, skillAction: 2,
  }), normalizePreferences(null));
  assert.deepEqual(normalizePreferences({
    random: false, portraits: true, skills: true, info: false,
    characterId: 'two', costumeKey: 'two-a/idle', skillAction: 'loop_2',
  }), {
    random: false, portraits: true, skills: true, info: false,
    characterId: 'two', costumeKey: 'two-a/idle', skillAction: 'loop_2',
  });
});

test('eligibility checks actual portrait and skill resources, including null entries and both displays off', () => {
  const names = prefs => availableCharacters(catalog, prefs)
    .map(person => [person.id, person.costumes.map(costume => costume.name)]);
  assert.deepEqual(names(preferences({ portraits: true, skills: true })), [
    ['one', ['one-a']], ['two', ['two-a']], ['three', ['three-a', 'three-b', 'three-c', 'three-d']],
  ]);
  assert.deepEqual(names(preferences({ portraits: true, skills: false }))[0], ['one', ['one-a', 'one-b']]);
  assert.deepEqual(names(preferences({ portraits: false, skills: true }))[0], ['one', ['one-a', 'one-c']]);
  assert.deepEqual(names(preferences({ portraits: false, skills: false })), [
    ['one', ['one-a', 'one-b', 'one-c']], ['two', ['two-a']],
    ['three', ['three-a', 'three-b', 'three-c', 'three-d']],
  ]);
  assert.equal(catalog.characters[0].costumes.length, 3, 'filtering must not remove costumes from the catalog');
});

test('random redraw samples people equally regardless of wardrobe size', () => {
  const picked = [0, .2, .34, .5, .67, .99].map(value =>
    chooseCharacter(catalog, preferences(), true, () => value).character.id);
  assert.deepEqual(picked, ['one', 'one', 'two', 'two', 'three', 'three']);
});

test('redraw excludes the current person when an alternative exists', () => {
  const prefs = preferences({ characterId: 'two', costumeKey: 'two-a/idle' });
  assert.equal(chooseCharacter(catalog, prefs, true, () => 0).character.id, 'one');
  assert.equal(chooseCharacter(catalog, prefs, true, () => .99).character.id, 'three');
  const single = { characters: [catalog.characters[1]] };
  assert.equal(chooseCharacter(single, prefs, true, () => 0).character.id, 'two');
});

test('fixed selection preserves the exact outfit without consuming randomness', () => {
  const prefs = preferences({ random: false, characterId: 'one', costumeKey: 'one-b/idle' });
  const selected = chooseCharacter(catalog, prefs, false, () => assert.fail('fixed selection must not redraw'));
  assert.equal(selected.character.id, 'one');
  assert.equal(selected.costume.name, 'one-b');
});

test('a mode change keeps the same person and falls back to their compatible outfit', () => {
  const prefs = preferences({ random: false, skills: true, characterId: 'one', costumeKey: 'one-b/idle' });
  const selected = chooseCharacter(catalog, prefs, false, () => .99);
  assert.equal(selected.character.id, 'one');
  assert.equal(selected.costume.name, 'one-a');
  assert.equal(costumeKey(outfit('skill-only', false, true)), 'skill-only/skill');
});

test('missing saved people fall back to an eligible person; an empty pool reports a useful error', () => {
  assert.equal(chooseCharacter(catalog, preferences({ characterId: 'removed' }), false, () => 0).character.id, 'one');
  assert.throws(() => chooseCharacter({ characters: [catalog.characters[3]] }, preferences()), /没有符合展示选项/);
});

test('atlas page parsing supports BOM, CRLF, multiple pages and region names ending in .png', () => {
  const atlas = '\uFEFFfirst.png\r\nsize: 1024,1024\r\nfilter: Linear,Linear\r\nportrait.png\r\n  bounds: 0,0,100,100\r\nsecond-region\r\n  bounds: 100,0,80,80\r\n \r\nsecond.png\r\nsize: 512,512\r\nfilter: Linear,Linear\r\nsecond-region.png\r\n  bounds: 0,0,80,80\r\n';
  assert.deepEqual(atlasPages(atlas), ['first.png', 'second.png']);
  assert.throws(() => atlasPages('\r\n  \r\n'), /纹理配置不完整/);
});

const animations = names => names.map(name => ({ name, duration: 2 }));
const animationNames = (names, mode, presentation) => playableAnimations(animations(names), mode, presentation)
  .map(animation => animation.name);

// The reported reference page, 阿奇拉·被封印的欲望 (char067902), exposes these
// independent poses in this order, rather than the cut_A/cut_B transitions.
const gamekeePresentation = {
  portrait: { animation: 'idle', viewport: { x: -80, y: -200, width: 160, height: 400 } },
  skills: [
    { animation: 'loop_2', viewport: { x: -729.0915898106048, y: -1566.0148388283296, width: 1700, height: 2400 } },
    { animation: 'loop', viewport: { x: -403.38524885026754, y: -1379.2721238174113, width: 1220, height: 1920 } },
  ],
};

test('costume presentation resolves asset IDs for portraits and skill-only case variants', () => {
  const presets = { costumes: { char067902: gamekeePresentation } };
  assert.equal(presentationForCostume(presets, {
    idle: { skeleton: 'spine/char/char067902/char067902.skel' },
  }), gamekeePresentation);
  assert.equal(presentationForCostume(presets, {
    cutscene: { skeleton: 'spine/cutscenes/cutscene_char067902/CutScene_Char067902.skel' },
  }), gamekeePresentation);
  assert.equal(presentationForCostume(presets, {
    idle: { skeleton: 'spine/char/char999999/char999999.skel' },
  }), undefined);
});

test('portrait playback prioritizes idle and ignores private animations', () => {
  assert.deepEqual(animationNames(['_idle', 'motion', 'Idle', 'idle_fx'], 'portrait'), ['Idle']);
  assert.deepEqual(animationNames(['_private', 'motion', 'other'], 'portrait'), ['motion']);
  assert.deepEqual(animationNames(['_private'], 'portrait'), []);
  assert.deepEqual(animationNames(['idle_fx', 'Idle', 'motion'], 'portrait', { portrait: { animation: 'motion' } }), ['motion']);
});

test('skill actions follow the reference loop_2/loop order without including transition cuts', () => {
  const source = animations(['cut_A', 'cut_B', 'cut_charm', 'loop', 'loop_2']);
  const selected = playableAnimations(source, 'skill', gamekeePresentation);
  assert.deepEqual(selected.map(animation => animation.name), ['loop_2', 'loop']);
  assert.equal(selected[0], source[4], 'each option is one original animation, not a concatenated sequence');
  assert.equal(selected[1], source[3]);
});

test('without a reference, skill loops take priority over cuts and effect animations', () => {
  assert.deepEqual(animationNames(['_hidden', 'cut_A', 'cut_B', 'loop', 'loop_2', 'cut_A_fx'], 'skill'), ['loop', 'loop_2']);
  assert.deepEqual(animationNames(['cut_1', 'cut_1_idle', 'cut_1_fx'], 'skill'), ['cut_1_idle']);
  assert.deepEqual(animationNames(['_hidden', 'cut_1_fx', 'cut_1', 'A_cut2', 'cut_2'], 'skill'), ['cut_1', 'A_cut2', 'cut_2']);
  assert.deepEqual(animationNames(['_hidden', 'skill_fx', 'skill_ef', 'skill_effect', 'smile', 'attack'], 'skill'), ['attack']);
  assert.deepEqual(animationNames(['_private'], 'skill'), []);
  assert.deepEqual(animationNames(['idle', 'loop'], 'skill'), ['loop']);
  assert.deepEqual(animationNames(['_private', 'idle'], 'skill'), ['idle']);
  assert.deepEqual(animationNames(['cut_A', 'loop'], 'skill', { skills: [{ animation: 'missing' }] }), ['loop'],
    'an unavailable configured action must not hide a playable fallback');
});

test('persistent skills loop while one-shot transition cuts do not', () => {
  assert.equal(isLoopingSkill({ name: 'loop_2' }), true);
  assert.equal(isLoopingSkill({ name: 'cut_1_idle' }), true);
  assert.equal(isLoopingSkill({ name: 'cut_A' }), false);
  assert.equal(isLoopingSkill({ name: 'cut_1' }, { skills: [{ animation: 'cut_1' }] }), true,
    'a reference-configured persistent action can use a cut name');
});

test('portrait framing uses the runtime animation bounds', () => {
  const viewport = { padLeft: 0 };
  const animation = { name: 'idle', duration: 4 };
  const player = {
    config: { viewport },
    skeleton: { setToSetupPose() {} },
    calculateAnimationViewport(received, output) {
      assert.equal(received, animation);
      Object.assign(output, { x: -80, y: -200, width: 160, height: 400 });
    },
  };
  configureViewports(player, [animation], 'portrait');
  assert.deepEqual(viewport, { padLeft: 0, x: -80, y: -200, width: 160, height: 400 });
});

test('reference skill viewports keep their exact per-action camera coordinates', () => {
  let resets = 0;
  const viewport = { animations: {}, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 };
  const player = {
    config: { viewport },
    skeleton: { setToSetupPose() { resets += 1; } },
    calculateAnimationViewport() { assert.fail('an exact reference camera must not be replaced with sampled bounds'); },
  };
  configureViewports(player, animations(['loop_2', 'loop']), 'skill', gamekeePresentation);
  assert.deepEqual(viewport.animations.loop_2, gamekeePresentation.skills[0].viewport);
  assert.deepEqual(viewport.animations.loop, gamekeePresentation.skills[1].viewport);
  assert.notEqual(viewport.animations.loop_2.width, viewport.animations.loop.width,
    'reference actions intentionally use distinct scales, not a shared median');
  viewport.animations.loop_2.x = 0;
  assert.equal(gamekeePresentation.skills[0].viewport.x, -729.0915898106048, 'player state must not mutate saved reference data');
  assert.equal(resets, 1);
});

test('unconfigured skills use complete per-animation bounds without pooling unrelated cuts', () => {
  const bounds = {
    cut_A: { x: -1000, y: -1500, width: 2000, height: 3000 },
    cut_B: { x: 200, y: -400, width: 500, height: 800 },
  };
  const calls = [];
  const player = {
    config: { viewport: { animations: {} } },
    skeleton: { setToSetupPose() {} },
    calculateAnimationViewport(animation, output) {
      calls.push(animation.name);
      Object.assign(output, bounds[animation.name]);
    },
  };
  configureViewports(player, animations(['cut_A', 'cut_B']), 'skill');
  assert.deepEqual(calls, ['cut_A', 'cut_B']);
  assert.deepEqual(player.config.viewport.animations, bounds);
});

test('invalid reference bounds fall back to the selected animation bounds', () => {
  const fallback = { x: -20, y: -30, width: 40, height: 60 };
  let calculated = false;
  const player = {
    config: { viewport: { animations: {} } },
    skeleton: { setToSetupPose() {} },
    calculateAnimationViewport(animation, output) {
      assert.equal(animation.name, 'loop_2');
      calculated = true;
      Object.assign(output, fallback);
    },
  };
  configureViewports(player, animations(['loop_2']), 'skill', {
    skills: [{ animation: 'loop_2', viewport: { x: 0, y: 0, width: 0, height: Infinity } }],
  });
  assert.equal(calculated, true);
  assert.deepEqual(player.config.viewport.animations.loop_2, fallback);
});

test('bundled GameKee profile retains the reported costume actions and exact cameras', () => {
  const presets = JSON.parse(readFileSync(new URL('../public/companion/gamekee-presets.json', import.meta.url), 'utf8'));
  const profile = presentationForCostume(presets, {
    idle: { skeleton: 'spine/char/char067902/char067902.skel' },
  });
  assert.equal(profile.name, '阿奇拉');
  assert.equal(profile.label, '被封印的欲望');
  assert.deepEqual(profile.skills.map(action => action.animation), ['loop_2', 'loop']);
  assert.deepEqual(profile.skills.map(action => action.viewport), gamekeePresentation.skills.map(action => action.viewport));
  assert.deepEqual(playableAnimations(animations(['cut_A', 'cut_B', 'cut_charm', 'loop', 'loop_2']), 'skill', profile)
    .map(animation => animation.name), ['loop_2', 'loop']);
});
