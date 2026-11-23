// Games the companion can draw characters from. Each entry owns its catalog,
// optional camera presets and asset origin; the menu lists them as sources,
// and the selected ones form the pool for random rotation. Catalogs share one
// character/costume shape and are refreshed by scripts/update_companion.py.
// action names the second display: BD2 skill cut-ins, NIKKE's firing loop,
// Azur Lane's Live2D reactions, Destiny Child's battle moves and banner pose.
export const GAMES = [
  {
    id: 'bd2',
    name: '棕色尘埃 2',
    action: '技能',
    catalogUrl: '/companion/catalog.json',
    presentationsUrl: '/companion/gamekee-presets.json',
    // Full skill performances choreographed by BD2-L2D-Viewer.
    performancesUrl: '/companion/bd2-performances.json',
    assetBase: 'https://raw.githubusercontent.com/myssal/Brown-Dust-2-Asset/',
  },
  {
    id: 'nikke',
    name: 'NIKKE',
    action: '开火循环',
    catalogUrl: '/companion/nikke/catalog.json',
    assetBase: 'https://raw.githubusercontent.com/Nikke-db/Nikke-db.github.io/',
  },
  {
    id: 'azurlane',
    name: '碧蓝航线',
    action: '互动',
    catalogUrl: '/companion/azurlane/catalog.json',
    assetBase: 'https://raw.githubusercontent.com/bungaku-moe/AzurLaneLive2D/',
    // The moc and textures are Git LFS objects; raw only serves their pointers.
    lfsBase: 'https://media.githubusercontent.com/media/bungaku-moe/AzurLaneLive2D/',
    // Dynamic paintings (Spine 3.8 layers) come from another repository.
    paintingBase: 'https://raw.githubusercontent.com/ww-rm/azurlane_spinepainting/',
    // Japanese voice lines, extracted from the English client.
    voiceBase: 'https://raw.githubusercontent.com/Fernando2603/AzurLane/',
  },
  {
    id: 'destinychild',
    name: '天命之子',
    action: '动作',
    catalogUrl: '/companion/destinychild/catalog.json',
    // Live2D (Cubism 2) models of the children; the game ended service in 2023.
    assetBase: 'https://raw.githubusercontent.com/Pelom777/DestinyChildLive2D/',
  },
];

export const DEFAULT_GAMES = GAMES.map(game => game.id);

export function gameById(id) {
  return GAMES.find(game => game.id === (id || 'bd2')) || GAMES[0];
}

// Keep known games in registry order; an empty or unknown choice falls back to all.
export function selectedGames(ids) {
  const chosen = GAMES.filter(game => Array.isArray(ids) && ids.includes(game.id));
  return chosen.length ? chosen : GAMES;
}
