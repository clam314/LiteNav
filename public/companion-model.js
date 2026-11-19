// Keep the stored keys to preserve existing browser preferences after rebranding.
import { isExcludedCharacter } from './companion-exclusions.js';
import { DEFAULT_GAMES, selectedGames } from './companion-games.js';
export const PREFERENCES_KEY = 'guihang.companion.preferences';
export const LEGACY_KEY = 'guihang.companion.enabled';

// Minutes between random people while the page stays open; 0 changes only on reload.
export const ROTATION_CHOICES = [1, 3, 5, 10, 0];
export const DEFAULT_ROTATION = 3;
export const DISPLAY_MODES = ['portrait', 'skill', 'both'];

export function normalizePreferences(value, legacyEnabled = false) {
  const data = value && typeof value === 'object' ? value : {};
  const boolean = (key, fallback) => typeof data[key] === 'boolean' ? data[key] : fallback;
  return {
    random: boolean('random', true),
    portraits: boolean('portraits', legacyEnabled),
    skills: boolean('skills', false),
    rotation: ROTATION_CHOICES.includes(data.rotation) ? data.rotation : DEFAULT_ROTATION,
    // The display to restore when the master switch turns the companion back on.
    resume: DISPLAY_MODES.includes(data.resume) ? data.resume : 'portrait',
    games: normalizeGames(data),
    // Games the viewer has been offered; a newly added game starts selected once.
    knownGames: [...DEFAULT_GAMES],
    characterId: typeof data.characterId === 'string' ? data.characterId : '',
    costumeKey: typeof data.costumeKey === 'string' ? data.costumeKey : '',
    skillAction: typeof data.skillAction === 'string' ? data.skillAction : '',
  };
}

function normalizeGames(data) {
  if (!Array.isArray(data.games)) return [...DEFAULT_GAMES];
  const known = Array.isArray(data.knownGames) ? data.knownGames : ['bd2'];
  const games = [...data.games, ...DEFAULT_GAMES.filter(id => !known.includes(id))];
  return selectedGames(games).map(game => game.id);
}

export const gameOf = character => character?.game || 'bd2';

export function displayOf(preferences) {
  if (preferences.portraits && preferences.skills) return 'both';
  if (preferences.portraits) return 'portrait';
  return preferences.skills ? 'skill' : 'off';
}

// Switching the display keeps the person; turning it off remembers what to restore.
export function withDisplay(preferences, display) {
  if (display === 'off') {
    const current = displayOf(preferences);
    return { ...preferences, portraits: false, skills: false, resume: current === 'off' ? preferences.resume : current };
  }
  const mode = display === 'on' ? preferences.resume : display;
  return { ...preferences, portraits: mode !== 'skill', skills: mode !== 'portrait', resume: mode };
}

// Spine parts name a skeleton; Azur Lane's Live2D parts name a model.
export const costumeKey = costume => costume.idle?.skeleton || costume.idle?.model ||
  costume.cutscene?.skeleton || costume.cutscene?.model || '';

export function availableCharacters(catalog, preferences) {
  const games = preferences.games || DEFAULT_GAMES;
  return catalog.characters.filter(character => !isExcludedCharacter(character) && games.includes(gameOf(character))).map(character => ({
    ...character,
    costumes: character.costumes.filter(costume =>
      (!preferences.portraits || costume.idle) && (!preferences.skills || costume.cutscene) &&
      (costume.idle || costume.cutscene)),
  })).filter(character => character.costumes.length);
}

// Draw a game, then a person, so neither a large roster nor a character with
// many costumes is more likely. A redraw avoids repeating the current person.
export function chooseCharacter(catalog, preferences, redraw = false, random = Math.random) {
  const characters = availableCharacters(catalog, preferences);
  if (!characters.length) throw new Error('没有符合展示选项的角色');
  const current = characters.find(character => character.id === preferences.characterId);
  let character = current;
  if (redraw) {
    const others = characters.length > 1 ? characters.filter(item => item.id !== current?.id) : characters;
    const games = DEFAULT_GAMES.filter(id => others.some(item => gameOf(item) === id));
    const game = games[Math.floor(random() * games.length)];
    const pool = others.filter(item => gameOf(item) === game);
    character = pool[Math.floor(random() * pool.length)];
  }
  character ||= characters[0];
  const costume = (!redraw && character.costumes.find(item => costumeKey(item) === preferences.costumeKey)) ||
    character.costumes[Math.floor(random() * character.costumes.length)];
  return { character, costume };
}

// Atlas regions can also be named *.png; only page headers follow a blank line.
export function atlasPages(text) {
  const pages = [];
  let pageStart = true;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { pageStart = true; continue; }
    if (pageStart) { pages.push(line); pageStart = false; }
  }
  if (!pages.length) throw new Error('角色纹理配置不完整');
  return pages;
}

export function presentationForCostume(presets, costume) {
  const id = costumeKey(costume).match(/(?:^|\/)(?:cutscene_)?(char\d+)\.skel$/i)?.[1]?.toLowerCase();
  return presets?.costumes?.[id];
}

export function playableAnimations(animations, mode, presentation) {
  const visible = animations.filter(animation => !animation.name.startsWith('_'));
  if (mode === 'portrait') {
    const preferred = presentation?.portrait?.animation;
    const idle = visible.find(animation => animation.name === preferred) ||
      visible.find(animation => /^idle$/i.test(animation.name)) ||
      visible.find(animation => /idle/i.test(animation.name));
    return idle ? [idle] : visible.slice(0, 1);
  }
  // The reference viewer's persistent skill poses are usually loop / loop_2.
  // cut_* animations are transitions or separate shots, not a full performance.
  const configured = (presentation?.skills || []).map(action =>
    visible.find(animation => animation.name === action.animation)).filter(Boolean);
  if (configured.length) return configured;
  const loops = visible.filter(animation =>
    /^(?:loop\w*|cut_[A-Za-z0-9]+_(?:idle|loop)\w*)$/i.test(animation.name));
  if (loops.length) return loops;
  const idle = visible.filter(animation => /^idle\w*$/i.test(animation.name));
  if (idle.length) return idle;
  const main = visible.filter(animation => /^(cut_[A-Za-z0-9]+|[A-Za-z]_cut\d*)$/.test(animation.name));
  if (main.length) return main;
  return visible.filter(animation => !/_fx$|_ef$|_effect|smile/i.test(animation.name)).slice(0, 1);
}

export function isLoopingSkill(animation, presentation) {
  return (presentation?.skills || []).some(action => !action.animation || action.animation === animation.name) ||
    /loop|idle/i.test(animation.name);
}

export function selectSkillAnimation(animations, savedName, presentation) {
  // Older menus exposed individual prop layers as selectable skills.
  const owner = presentation?.skills?.find(action => action.attachmentLayers?.includes(savedName));
  const name = owner?.animation || savedName;
  return animations.find(animation => animation.name === name) || animations[0];
}

// Extent drawn by visible regions and meshes while the animations play.
// Skeleton bounds also count transparent attachments, and reference viewports
// often reserve floor space for a backdrop this page does not draw.
export function visibleArtBounds(skeleton, animations, steps = 60) {
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity };
  let vertices = new Float32Array(1024);
  for (const animation of animations) {
    if (!animation) continue;
    skeleton.setToSetupPose();
    const stepTime = animation.duration > 0 ? animation.duration / steps : 0;
    for (let i = 0; i <= (stepTime ? steps : 0); i++) {
      const time = i * stepTime;
      animation.apply(skeleton, time, time, false, [], 1, 0 /* setup */, 0 /* mixIn */);
      skeleton.updateWorldTransform();
      for (const slot of skeleton.drawOrder) {
        const attachment = slot.bone.active ? slot.getAttachment() : null;
        // Only regions and meshes carry texture; clipping and bounding boxes do not draw.
        if (!attachment?.region) continue;
        const alpha = skeleton.color.a * slot.color.a * (attachment.color?.a ?? 1);
        if (alpha < 0.02) continue;
        let count = 8;
        if (attachment.triangles) {
          count = attachment.worldVerticesLength;
          if (vertices.length < count) vertices = new Float32Array(count);
          attachment.computeWorldVertices(slot, 0, count, vertices, 0, 2);
        } else {
          // Spine 4.1 regions take the slot (and carry a sequence); 4.0 regions take the bone.
          attachment.computeWorldVertices('sequence' in attachment ? slot : slot.bone, vertices, 0, 2);
        }
        for (let v = 0; v < count; v += 2) {
          bounds.minX = Math.min(bounds.minX, vertices[v]);
          bounds.maxX = Math.max(bounds.maxX, vertices[v]);
          bounds.minY = Math.min(bounds.minY, vertices[v + 1]);
        }
      }
    }
  }
  skeleton.setToSetupPose();
  return bounds;
}

// Drop empty floor and side margins so the figure meets the rail's bottom
// edge and keeps its size when the view must fit a narrower rail. Edges that
// already cut through the artwork, and the top headroom, keep the preset crop.
export function trimViewportToArt(box, art) {
  const left = Number.isFinite(art?.minX) ? Math.max(box.x, art.minX) : box.x;
  const right = Number.isFinite(art?.maxX) ? Math.min(box.x + box.width, art.maxX) : box.x + box.width;
  const bottom = Number.isFinite(art?.minY) ? Math.max(box.y, art.minY) : box.y;
  const top = box.y + box.height;
  // A nearly empty view is not shrunk around a stray detail.
  const width = right - left >= box.width * .3 ? right - left : box.width;
  const height = top - bottom >= box.height * .3 ? top - bottom : box.height;
  if (width === box.width && height === box.height) return box;
  return { ...box, x: width === box.width ? box.x : left, y: height === box.height ? box.y : bottom, width, height };
}

// extra animations (a firing loop around an aim pose) share the view's floor.
export function configureViewports(player, animations, mode, presentation, extra = []) {
  const definitions = mode === 'portrait' ? [presentation?.portrait] : presentation?.skills || [];
  // The portrait viewer also plays its "motion" reaction inside the same view.
  const motion = mode === 'portrait' ? player.skeleton.data.findAnimation('motion') : null;
  for (const animation of animations) {
    const action = definitions.find(action => action && (!action.animation || action.animation === animation.name));
    // localViewport is this project's correction of a reference camera that cuts off the figure.
    const configured = action?.framing === 'full' ? undefined : action?.localViewport || action?.viewport;
    let box;
    if (configured && [configured.x, configured.y, configured.width, configured.height].every(Number.isFinite) &&
        configured.width > 0 && configured.height > 0) {
      box = { ...configured };
    } else {
      // Keep the complete bounds of this one selected action. A median taken
      // across unrelated cuts changes its intended scale and camera position.
      box = {};
      player.calculateAnimationViewport(animation, box);
    }
    box = trimViewportToArt(box, visibleArtBounds(player.skeleton, [animation, motion, ...extra]));
    // The floor is now the artwork (or cuts through it); padding would lift it off the edge.
    box.padBottom = 0;
    if (mode === 'portrait') Object.assign(player.config.viewport, box);
    else player.config.viewport.animations[animation.name] = { ...box };
  }
  player.skeleton.setToSetupPose();
}

// The camera box Spine fits to the canvas, padding included.
export function paddedView(viewport) {
  return {
    x: viewport.x - viewport.padLeft, y: viewport.y - viewport.padBottom,
    width: viewport.width + viewport.padLeft + viewport.padRight,
    height: viewport.height + viewport.padBottom + viewport.padTop,
  };
}

// Fit the view inside the rail, stand it on the bottom edge and center it in
// the space left by the navigation without passing the right edge. Returns the
// camera covering the whole rail canvas at that scale.
export function placeView(view, rail, space, maxWidth = rail.width) {
  const scale = Math.min(maxWidth / view.width, rail.height / view.height);
  const width = view.width * scale;
  const right = Math.max(0, space / 2 - width / 2);
  const left = rail.width - right - width;
  return {
    x: view.x - left / scale, y: view.y,
    width: rail.width / scale, height: rail.height / scale,
    padLeft: 0, padRight: 0, padTop: 0, padBottom: 0,
  };
}

// Some NIKKE outfits split their body across extra skins (part_0, part_1, …)
// and leave the default skin without the head or arms. Merge every other skin
// that supplies a setup attachment the current skins lack. Returns the names
// of the merged skins, or an empty list when nothing was missing.
export function completeSkin(spine, skeleton) {
  const data = skeleton.data;
  const missing = data.slots.filter(slot => slot.attachmentName && !skeleton.getAttachment(slot.index, slot.attachmentName));
  if (!missing.length) return [];
  const extras = data.skins.filter(skin => skin !== data.defaultSkin && skin !== skeleton.skin &&
    missing.some(slot => skin.getAttachment(slot.index, slot.attachmentName)));
  if (!extras.length) return [];
  const complete = new spine.Skin('companion-complete');
  if (skeleton.skin) complete.addSkin(skeleton.skin);
  extras.forEach(skin => complete.addSkin(skin));
  skeleton.setSkin(complete);
  skeleton.setSlotsToSetupPose();
  return extras.map(skin => skin.name);
}
