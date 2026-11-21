import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isExcludedCharacter } from '../public/companion-exclusions.js';
import { LOCAL_FALLBACK_CHARACTER } from '../public/companion-fallback.js';
import {
  normalizePreferences,
  completeSkin,
  gameOf,
  displayOf,
  withDisplay,
  costumeKey,
  availableCharacters,
  chooseCharacter,
  atlasPages,
  presentationForCostume,
  playableAnimations,
  selectSkillAnimation,
  isLoopingSkill,
  configureViewports,
  visibleArtBounds,
  trimViewportToArt,
  paddedView,
  placeView,
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

const ALL_GAMES = ['bd2', 'nikke', 'azurlane'];
const DEFAULTS = { voice: false, voiceVolume: 0.6, rotation: 3, resume: 'portrait', games: ALL_GAMES, knownGames: ALL_GAMES };

test('new preferences default to random people with display off; legacy enabled migrates only portrait visibility', () => {
  assert.deepEqual(normalizePreferences(null), {
    random: true, portraits: false, skills: false, ...DEFAULTS, characterId: '', costumeKey: '', skillAction: '',
  });
  assert.deepEqual(normalizePreferences(undefined, true), {
    random: true, portraits: true, skills: false, ...DEFAULTS, characterId: '', costumeKey: '', skillAction: '',
  });
  assert.equal(normalizePreferences({ portraits: false }, true).portraits, false);
});

test('preferences reject truthy strings, numbers, and non-string selection IDs', () => {
  assert.deepEqual(normalizePreferences({
    random: 'false', portraits: 'true', skills: 1, rotation: 7, resume: 'off', games: 'bd2',
    characterId: 42, costumeKey: { skeleton: 'bad' }, skillAction: 2,
  }), normalizePreferences(null));
  assert.deepEqual(normalizePreferences({
    random: false, portraits: true, skills: true, rotation: 0, resume: 'both', games: ['bd2'], knownGames: ALL_GAMES, info: false,
    characterId: 'two', costumeKey: 'two-a/idle', skillAction: 'loop_2',
  }), {
    random: false, portraits: true, skills: true, voice: false, voiceVolume: 0.6, rotation: 0, resume: 'both', games: ['bd2'], knownGames: ALL_GAMES,
    characterId: 'two', costumeKey: 'two-a/idle', skillAction: 'loop_2',
  }, 'the retired info option is dropped');
  assert.deepEqual([true, 0].map(volume => normalizePreferences({ voice: true, voiceVolume: volume })).map(p => [p.voice, p.voiceVolume]),
    [[true, 0.6], [true, 0]], 'voice turns on only with true; the volume is a share from 0 to 1');
  for (const bad of ['true', 1, null]) assert.equal(normalizePreferences({ voice: bad }).voice, false);
  for (const bad of [-0.1, 1.5, '0.5', NaN]) assert.equal(normalizePreferences({ voiceVolume: bad }).voiceVolume, 0.6);
  assert.deepEqual(normalizePreferences({ games: ['unknown'], knownGames: ALL_GAMES }).games, ALL_GAMES,
    'unknown games fall back to all known ones');
  assert.deepEqual(normalizePreferences({ games: ['bd2'] }).games, ALL_GAMES,
    'a game added after the choice was saved starts selected');
  assert.deepEqual(normalizePreferences({ games: ['bd2'], knownGames: ['bd2', 'nikke'] }).games, ['bd2', 'azurlane'],
    'Azur Lane joins a choice saved before it was offered');
  assert.deepEqual(normalizePreferences({ games: ['nikke'], knownGames: ALL_GAMES }).games, ['nikke'],
    'a game the viewer turned off stays off');
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
  const model = { model: 'Live2D/z23/z23.model3.json', runtime: 'live2d' };
  assert.equal(costumeKey({ idle: model, cutscene: model }), model.model, 'Live2D costumes are keyed by their model');
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

const animations = names => names.map(name => ({ name, duration: 2, apply() {} }));
// Configured views stand on the rail's bottom edge without extra padding.
const floored = box => ({ ...box, padBottom: 0 });
// A skeleton without drawn attachments leaves every viewport floor unchanged.
const stillSkeleton = (overrides = {}) => ({
  data: { findAnimation() { return null; } }, drawOrder: [], color: { a: 1 },
  setToSetupPose() {}, updateWorldTransform() {}, ...overrides,
});
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
  const animation = { name: 'idle', duration: 4, apply() {} };
  const player = {
    config: { viewport },
    skeleton: stillSkeleton(),
    calculateAnimationViewport(received, output) {
      assert.equal(received, animation);
      Object.assign(output, { x: -80, y: -200, width: 160, height: 400 });
    },
  };
  configureViewports(player, [animation], 'portrait');
  assert.deepEqual(viewport, { padLeft: 0, x: -80, y: -200, width: 160, height: 400, padBottom: 0 });
});

test('reference skill viewports keep their exact per-action camera coordinates', () => {
  let resets = 0;
  const viewport = { animations: {}, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 };
  const player = {
    config: { viewport },
    skeleton: stillSkeleton({ setToSetupPose() { resets += 1; }, updateWorldTransform() { resets = 0; } }),
    calculateAnimationViewport() { assert.fail('an exact reference camera must not be replaced with sampled bounds'); },
  };
  configureViewports(player, animations(['loop_2', 'loop']), 'skill', gamekeePresentation);
  assert.deepEqual(viewport.animations.loop_2, floored(gamekeePresentation.skills[0].viewport));
  assert.deepEqual(viewport.animations.loop, floored(gamekeePresentation.skills[1].viewport));
  assert.notEqual(viewport.animations.loop_2.width, viewport.animations.loop.width,
    'reference actions intentionally use distinct scales, not a shared median');
  viewport.animations.loop_2.x = 0;
  assert.equal(gamekeePresentation.skills[0].viewport.x, -729.0915898106048, 'player state must not mutate saved reference data');
  assert.ok(resets > 0, 'the skeleton is left in its setup pose');
});

test('unconfigured skills use complete per-animation bounds without pooling unrelated cuts', () => {
  const bounds = {
    cut_A: { x: -1000, y: -1500, width: 2000, height: 3000 },
    cut_B: { x: 200, y: -400, width: 500, height: 800 },
  };
  const calls = [];
  const player = {
    config: { viewport: { animations: {} } },
    skeleton: stillSkeleton(),
    calculateAnimationViewport(animation, output) {
      calls.push(animation.name);
      Object.assign(output, bounds[animation.name]);
    },
  };
  configureViewports(player, animations(['cut_A', 'cut_B']), 'skill');
  assert.deepEqual(calls, ['cut_A', 'cut_B']);
  assert.deepEqual(player.config.viewport.animations, { cut_A: floored(bounds.cut_A), cut_B: floored(bounds.cut_B) });
});

test('invalid reference bounds fall back to the selected animation bounds', () => {
  const fallback = { x: -20, y: -30, width: 40, height: 60 };
  let calculated = false;
  const player = {
    config: { viewport: { animations: {} } },
    skeleton: stillSkeleton(),
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
  assert.deepEqual(player.config.viewport.animations.loop_2, floored(fallback));
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

test('all numbered prestige costumes have their own portrait camera and compatible skill presets', () => {
  const presets = JSON.parse(readFileSync(new URL('../public/companion/gamekee-presets.json', import.meta.url)));
  const roster = JSON.parse(readFileSync(new URL('../public/companion/catalog.json', import.meta.url)));
  const variants = roster.characters.flatMap(character => character.costumes).filter(costume => /^服装 9\d$/.test(costume.label));
  assert.equal(variants.length, 17);
  for (const costume of variants) {
    const preset = presentationForCostume(presets, costume);
    assert.ok(preset.label.includes(costume.label));
    assert.equal(preset.portrait.animation, 'idle');
    assert.ok(preset.portrait.viewport.height > 0);
    if (preset.skills) assert.ok(costume.cutscene);
  }
  const sylvia = presets.costumes.char001092;
  assert.deepEqual(sylvia.portrait.viewport, { x: -176.08555043116257, y: -702.323629925471, width: 420, height: 1120 });
  assert.notDeepEqual(sylvia.portrait.viewport, presets.costumes.char001002.portrait.viewport);
  assert.deepEqual(sylvia.skills.map(action => action.animation), ['loop_1', 'loop_2']);
});

test('Liatris 97 restores a saved prop selection to the complete shot and frames its combined bounds', () => {
  const presets = JSON.parse(readFileSync(new URL('../public/companion/gamekee-presets.json', import.meta.url)));
  const liatris = presets.costumes.char001297;
  const options = playableAnimations(animations(['cut_A', 'cut_A_bowl', 'cut_B', 'loop', 'loop_2', 'loop_bowl']), 'skill', liatris);
  assert.deepEqual(options.map(action => action.name), ['loop_2', 'loop']);
  for (const saved of ['loop', 'loop_bowl']) assert.equal(selectSkillAnimation(options, saved, liatris), options[1]);
  for (const saved of ['', 'loop_2', 'missing']) assert.equal(selectSkillAnimation(options, saved, liatris), options[0]);
  const viewport = { animations: {} };
  const full = { x: -776, y: -1209, width: 2216, height: 1842 };
  configureViewports({ config: { viewport }, skeleton: stillSkeleton(),
    calculateAnimationViewport(animation, box) { assert.equal(animation, options[1]); Object.assign(box, full); },
  }, options, 'skill', liatris);
  assert.deepEqual(viewport.animations.loop, floored(full));
  assert.deepEqual(viewport.animations.loop_2, floored(liatris.skills[0].viewport));
});


const readCatalog = () => JSON.parse(readFileSync(new URL('../public/companion/catalog.json', import.meta.url), 'utf8'));
const expectedMaleIds = ['0001', '0004', '0006', '0206', '0603', '0620', '0658', '1001', '1002', '1004', '1005', '1012', '1015', '1032'];

test('the supplied male roster is excluded from every display mode', () => {
  const real = readCatalog();
  const retained = real.characters.filter(character => !expectedMaleIds.includes(character.id));
  assert.equal(retained.length, 75);
  assert.equal(retained.reduce((count, character) => count + character.costumes.length, 0), 181);
  for (const modes of [{ portraits: true, skills: false }, { portraits: false, skills: true }, { portraits: true, skills: true }, { portraits: false, skills: false }]) {
    const allowed = availableCharacters(real, preferences(modes));
    assert.ok(allowed.length > 0);
    assert.equal(allowed.some(character => expectedMaleIds.includes(character.id) || isExcludedCharacter(character)), false);
  }
    assert.equal(real.characters.length, 89);
});

test('male IDs and provided multilingual names stay excluded after a rename', () => {
    for (const character of [{ id: '0001', name: '新名称' }, { id: 603, name: '匿名' }, { id: 'unknown-a', name: '拉德爾' }, { id: 'unknown-b', name: 'LATHEL' }, { id: 'unknown-c', name: 'ラテル' }, { id: 'unknown-d', aka: '라텔' }, { id: 'unknown-e', name: 'Gisgray  Blair' }, { id: 'unknown-f', name: '鐵面具166' }, { id: 'unknown-g', name: 'The Captain' }]) {
        assert.equal(isExcludedCharacter(character), true);
    }
    assert.equal(isExcludedCharacter({ id: '0002', name: '悠丝缇亚', aka: 'Justia' }), false);
    assert.equal(isExcludedCharacter({ id: 'unlisted', name: '未收录角色' }), false);
});

test('saved male selections and random redraws cannot select excluded characters', () => {
    const real = readCatalog();
    const saved = preferences({ random: false, characterId: '0001', costumeKey: 'spine/char/char000101/char000101.skel' });
    for (const value of [0, .5, .99]) {
        assert.equal(isExcludedCharacter(chooseCharacter(real, saved, false, () => value).character), false);
    }
    for (let index = 0; index < 100; index += 1) {
        assert.equal(isExcludedCharacter(chooseCharacter(real, saved, true, () => index / 100).character), false);
    }
});

test('the offline fallback and its manifest identify the same allowed character', () => {
    const metadata = JSON.parse(readFileSync(new URL('../public/companion/character.json', import.meta.url), 'utf8'));
    assert.equal(isExcludedCharacter(LOCAL_FALLBACK_CHARACTER), false);
    assert.equal(metadata.catalogId, LOCAL_FALLBACK_CHARACTER.id);
    assert.equal(metadata.costumeKey, costumeKey(LOCAL_FALLBACK_CHARACTER.costumes[0]));
    assert.equal(metadata.characterId, 'char000201');
});

// A region whose lowest vertex follows the animation clock.
function drawnSlot(bottom, { alpha = 1, mesh = false, region = true } = {}) {
  const attachment = {
    region: region ? {} : undefined, color: { a: 1 },
    ...(mesh ? {
      triangles: [0, 1, 2], worldVerticesLength: 6,
      computeWorldVertices(slot, start, count, out) { out.set([0, bottom.value + 50, 10, bottom.value, 20, bottom.value + 80]); },
    } : {
      computeWorldVertices(slot, out) { out.set([0, bottom.value, 10, bottom.value, 10, bottom.value + 100, 0, bottom.value + 100]); },
    }),
  };
  return { bone: { active: true }, color: { a: alpha }, getAttachment: () => attachment };
}

test('visible artwork bounds ignore transparent and non-drawing attachments across the whole animation', () => {
  const clock = { value: 0 };
  const skeleton = stillSkeleton({
    drawOrder: [
      drawnSlot(clock),
      drawnSlot({ get value() { return clock.value - 40; } }, { mesh: true }),
      drawnSlot({ value: -900 }, { alpha: 0 }),
      drawnSlot({ value: -800 }, { region: false }),
    ],
  });
  const animation = { duration: 2, apply(target, time) { clock.value = -100 - time * 50; } };
  assert.deepEqual(visibleArtBounds(skeleton, [animation, null]), { minX: 0, maxX: 20, minY: -240, floor: -160 });
});

test('a skill loop stands on the floor its swinging hem keeps most of the time; a portrait on its lowest pose', () => {
  const clock = { value: 0 };
  const skeleton = stillSkeleton({ drawOrder: [drawnSlot(clock)] });
  // The hem dips to -400 for a fifth of the loop and stays near -200 otherwise.
  const swing = { name: 'loop', duration: 1, apply(target, time) { clock.value = time < .2 ? -400 : -200; } };
  const viewport = { padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, animations: {} };
  const player = { skeleton, config: { viewport }, calculateAnimationViewport(animation, box) { Object.assign(box, { x: 0, y: -1000, width: 10, height: 1200 }); } };
  configureViewports(player, [swing], 'skill');
  assert.equal(viewport.animations.loop.y, -200);
  configureViewports(player, [swing], 'portrait');
  assert.equal(viewport.y, -400);
});

test('empty floor and side margins shrink to the artwork while the top keeps its headroom', () => {
  const box = { x: -100, y: -1000, width: 400, height: 1200, padTop: '5%' };
  const art = (minX, maxX, minY) => ({ minX, maxX, minY });
  assert.deepEqual(trimViewportToArt(box, art(-500, 500, -600)), { x: -100, y: -600, width: 400, height: 800, padTop: '5%' },
    'artwork wider than the view keeps the reference side crop');
  assert.deepEqual(trimViewportToArt(box, art(-50, 250, -1100)), { x: -50, y: -1000, width: 300, height: 1200, padTop: '5%' },
    'artwork cropped by the floor keeps the reference floor');
  assert.deepEqual(trimViewportToArt(box, art(0, 500, -2000)), { x: 0, y: -1000, width: 300, height: 1200, padTop: '5%' });
  assert.equal(trimViewportToArt(box, art(Infinity, -Infinity, Infinity)), box);
  assert.equal(trimViewportToArt(box, art(-100, 300, 150)), box, 'a nearly empty view is not shrunk around a stray detail');
  assert.equal(trimViewportToArt(box, art(0, 20, -1000)), box);
});

test('portrait framing includes the motion reaction before raising the floor', () => {
  const clock = { value: 0 };
  const idle = { name: 'idle', duration: 1, apply() { clock.value = -100; } };
  const motion = { name: 'motion', duration: 1, apply() { clock.value = -150; } };
  const viewport = {};
  const player = {
    config: { viewport },
    skeleton: stillSkeleton({ drawOrder: [drawnSlot(clock)], data: { findAnimation: name => name === 'motion' ? motion : null } }),
  };
  configureViewports(player, [idle], 'portrait', { portrait: { animation: 'idle', viewport: { x: -80, y: -400, width: 160, height: 500 } } });
  assert.deepEqual(viewport, { x: -80, y: -150, width: 160, height: 250, padBottom: 0 });
});

test('the rail camera stands the padded view on the bottom edge beside the navigation', () => {
  const view = paddedView({ x: 0, y: 100, width: 180, height: 400, padLeft: 10, padRight: 10, padTop: 0, padBottom: 0 });
  assert.deepEqual(view, { x: -10, y: 100, width: 200, height: 400 });
  const rail = { width: 800, height: 800 };
  // Height binds: 2 px per unit, the 400 px wide view is centered 300 px from the right edge.
  let camera = placeView(view, rail, 600);
  assert.equal(camera.width / rail.width, camera.height / rail.height, 'the camera keeps the canvas ratio');
  assert.deepEqual([camera.x, camera.y, camera.width, camera.height], [-160, 100, 400, 400]);
  // A narrower space than the view keeps it against the right edge instead of past it.
  camera = placeView(view, rail, 300);
  assert.equal(camera.x + camera.width, view.x + view.width);
  // Width binds in a narrow rail: the whole view still fits and stays on the floor.
  camera = placeView(view, { width: 300, height: 900 }, 300);
  assert.deepEqual([camera.x, camera.y, camera.width, camera.height], [-10, 100, 200, 600]);
  // A capped width shrinks the view instead of spanning the whole rail.
  camera = placeView(view, rail, 600, 200);
  assert.equal(rail.width / camera.width, 1);
});

test('a local viewport correction takes precedence over the reference camera', () => {
  const viewport = { animations: {} };
  const player = {
    config: { viewport },
    skeleton: stillSkeleton(),
    calculateAnimationViewport() { assert.fail('a configured camera must not fall back to bounds'); },
  };
  const local = { x: -400, y: -700, width: 860, height: 1270 };
  configureViewports(player, animations(['loop']), 'skill', {
    skills: [{ animation: 'loop', localViewport: local, viewport: { x: -550, y: -700, width: 570, height: 1270 } }],
  });
  assert.deepEqual(viewport.animations.loop, floored(local));
});

test('one display choice maps to both switches and the master switch restores the last one', () => {
  const base = normalizePreferences({ portraits: true });
  assert.equal(displayOf(base), 'portrait');
  const both = withDisplay(base, 'both');
  assert.deepEqual([both.portraits, both.skills, displayOf(both)], [true, true, 'both']);
  const skill = withDisplay(both, 'skill');
  assert.deepEqual([skill.portraits, skill.skills], [false, true]);
  const off = withDisplay(skill, 'off');
  assert.deepEqual([off.portraits, off.skills, off.resume, displayOf(off)], [false, false, 'skill', 'off']);
  assert.equal(withDisplay(off, 'off').resume, 'skill', 'turning off twice keeps what to restore');
  const on = withDisplay(off, 'on');
  assert.deepEqual([on.portraits, on.skills, displayOf(on)], [false, true, 'skill']);
  assert.equal(on.characterId, base.characterId, 'display changes keep the person');
});

test('the pool follows the selected games and a redraw picks a game before a person', () => {
  const mixed = {
    characters: [
      ...Array.from({ length: 9 }, (_, index) => ({ id: `nikke:c0${index}0`, name: `N${index}`, game: 'nikke', costumes: [outfit(`n${index}`)] })),
      { id: 'one', name: '人物一', costumes: [outfit('one-a')] },
    ],
  };
  assert.equal(gameOf(mixed.characters.at(-1)), 'bd2', 'catalog entries without a game are Brown Dust 2');
  const only = games => availableCharacters(mixed, preferences({ games, knownGames: ['bd2', 'nikke'] })).map(person => person.id);
  assert.deepEqual(only(['bd2']), ['one']);
  assert.equal(only(['nikke']).length, 9);
  // Two games: half of the redraws land on the single Brown Dust 2 person.
  const prefs = preferences({ games: ['bd2', 'nikke'], characterId: 'nikke:c000' });
  assert.equal(chooseCharacter(mixed, prefs, true, () => 0).character.id, 'one');
  assert.equal(chooseCharacter(mixed, prefs, true, () => 0.99).character.game, 'nikke');
});

test('Spine 4.0 regions are measured from their bone and 4.1 regions from their slot', () => {
  const seen = [];
  const region = sequence => ({
    region: {}, color: { a: 1 }, ...(sequence ? { sequence: null } : {}),
    computeWorldVertices(target, out) { seen.push(target.kind); out.set([0, -10, 1, -10, 1, 0, 0, 0]); },
  });
  const slot = attachment => ({ kind: 'slot', bone: { kind: 'bone', active: true }, color: { a: 1 }, getAttachment: () => attachment });
  const skeleton = stillSkeleton({ drawOrder: [slot(region(false)), slot(region(true))] });
  assert.equal(visibleArtBounds(skeleton, [{ duration: 0, apply() {} }]).minY, -10);
  assert.deepEqual(seen, ['bone', 'slot']);
});

test('outfits that split their body across part skins get one complete skin', () => {
  class Skin {
    constructor(name, entries = {}) { this.name = name; this.entries = { ...entries }; }
    getAttachment(slot, name) { return this.entries[slot + '/' + name] || null; }
    addSkin(skin) { Object.assign(this.entries, skin.entries); }
  }
  const make = () => {
    const defaultSkin = new Skin('default', { '0/body': 'body' });
    const skins = [defaultSkin, new Skin('part_0', { '1/head': 'head' }), new Skin('part_1', { '2/arm': 'arm' }), new Skin('bg', { '3/sea': 'sea' })];
    const slots = [{ index: 0, attachmentName: 'body' }, { index: 1, attachmentName: 'head' }, { index: 2, attachmentName: 'arm' }, { index: 4, attachmentName: null }];
    return {
      data: { defaultSkin, skins, slots }, skin: null, poses: 0,
      getAttachment(slot, name) { return (this.skin && this.skin.getAttachment(slot, name)) || defaultSkin.getAttachment(slot, name); },
      setSkin(skin) { this.skin = skin; },
      setSlotsToSetupPose() { this.poses += 1; },
    };
  };
  const skeleton = make();
  assert.deepEqual(completeSkin({ Skin }, skeleton), ['part_0', 'part_1'], 'skins that fill nothing (bg) stay out');
  assert.ok(skeleton.data.slots.every(slot => !slot.attachmentName || skeleton.getAttachment(slot.index, slot.attachmentName)));
  assert.equal(skeleton.poses, 1);
  assert.deepEqual(completeSkin({ Skin }, skeleton), [], 'a complete skeleton is left alone');
  const whole = make();
  whole.data.slots = whole.data.slots.slice(0, 1);
  assert.deepEqual(completeSkin({ Skin }, whole), []);
  assert.equal(whole.skin, null);
});
