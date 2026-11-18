// Games the companion can draw characters from. Each entry owns its catalog,
// camera presets and asset origin; the menu lists them as sources, and the
// selected ones form the pool for random rotation. Add a game by appending an
// entry whose catalog follows the same character/costume shape.
export const GAMES = [
  {
    id: 'bd2',
    name: '棕色尘埃 2',
    catalogUrl: '/companion/catalog.json',
    presentationsUrl: '/companion/gamekee-presets.json',
    assetBase: 'https://raw.githubusercontent.com/myssal/Brown-Dust-2-Asset/',
  },
];

export const DEFAULT_GAMES = GAMES.map(game => game.id);

// Keep known games in registry order; an empty or unknown choice falls back to all.
export function selectedGames(ids) {
  const chosen = GAMES.filter(game => Array.isArray(ids) && ids.includes(game.id));
  return chosen.length ? chosen : GAMES;
}
