export const PREFERENCES_KEY = 'guihang.companion.preferences';
export const LEGACY_KEY = 'guihang.companion.enabled';

export function normalizePreferences(value, legacyEnabled = false) {
  const data = value && typeof value === 'object' ? value : {};
  const boolean = (key, fallback) => typeof data[key] === 'boolean' ? data[key] : fallback;
  return {
    random: boolean('random', true),
    portraits: boolean('portraits', legacyEnabled),
    skills: boolean('skills', false),
    info: boolean('info', true),
    characterId: typeof data.characterId === 'string' ? data.characterId : '',
    costumeKey: typeof data.costumeKey === 'string' ? data.costumeKey : '',
    skillAction: typeof data.skillAction === 'string' ? data.skillAction : '',
  };
}

export const costumeKey = costume => costume.idle?.skeleton || costume.cutscene?.skeleton || '';

export function availableCharacters(catalog, preferences) {
  return catalog.characters.map(character => ({
    ...character,
    costumes: character.costumes.filter(costume =>
      (!preferences.portraits || costume.idle) && (!preferences.skills || costume.cutscene) &&
      (costume.idle || costume.cutscene)),
  })).filter(character => character.costumes.length);
}

// Draw people first so a character with many costumes is not more likely.
// An explicit redraw avoids repeating the current person when possible.
export function chooseCharacter(catalog, preferences, redraw = false, random = Math.random) {
  const characters = availableCharacters(catalog, preferences);
  if (!characters.length) throw new Error('没有符合展示选项的角色');
  const current = characters.find(character => character.id === preferences.characterId);
  let character = current;
  if (redraw) {
    const pool = characters.length > 1 ? characters.filter(item => item.id !== current?.id) : characters;
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

export function configureViewports(player, animations, mode, presentation) {
  const definitions = mode === 'portrait' ? [presentation?.portrait] : presentation?.skills || [];
  for (const animation of animations) {
    const configured = definitions.find(action => action && (!action.animation || action.animation === animation.name))?.viewport;
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
    if (mode === 'portrait') Object.assign(player.config.viewport, box);
    else player.config.viewport.animations[animation.name] = { ...box };
  }
  player.skeleton.setToSetupPose();
}
