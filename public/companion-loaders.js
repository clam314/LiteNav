// Downloads a costume's assets through the asset cache, for every runtime:
// Spine (Brown Dust 2, NIKKE), Live2D and Spine 3.8 paintings (Azur Lane).
import { gameOf, atlasPages } from './companion-model.js';
import { LOCAL_FALLBACK_CHARACTER } from './companion-fallback.js';
import { createAssetFetcher } from './companion-assets.js';
import { GAMES, gameById } from './companion-games.js';
import { live2dMotionPlan, live2dFiles, orderMotionCurves } from './companion-live2d.js';
import { performanceId, performanceSources } from './companion-performance-player.js';

export async function fetchResource(url, signal, cache = 'default') {
  const response = await fetch(url, { signal, credentials: 'same-origin', cache });
  if (!response.ok) throw new Error('角色素材未能载入，请重试');
  return response;
}

export const fetchAsset = createAssetFetcher({ base: GAMES.flatMap(game => [game.assetBase, game.lfsBase, game.paintingBase, game.voiceBase].filter(Boolean)), fetchResource });

function readDataURI(blob, signal) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => {
      reader.abort();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const finish = callback => {
      signal.removeEventListener('abort', abort);
      callback();
    };
    reader.onload = () => finish(() => resolve(reader.result));
    reader.onerror = () => finish(() => reject(new Error('角色素材无法读取')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else reader.readAsDataURL(blob);
  });
}

export function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

// 'dating' is Brown Dust 2's 有缘之客 scene, shown in the skill display.
export const partFor = (selection, mode) => mode === 'skill' ? selection.costume.cutscene :
  mode === 'cover' ? selection.costume.cover : mode === 'dating' ? selection.costume.dating : selection.costume.idle;

// A Live2D model's settings, moc, textures, physics and the motions it plays,
// fetched through the asset cache. Each player makes its own blob URLs from
// these blobs: PixiJS caches textures by URL, and a shared URL let one player
// destroy the textures of the next (the same ship in its other display).
// A motion file with its curves in the order the framework reads (see
// orderMotionCurves); one that cannot be read is passed on unchanged.
async function inOrder(blob) {
  try {
    const motion = JSON.parse(await blob.text());
    const ordered = orderMotionCurves(motion);
    return ordered === motion ? blob : new Blob([JSON.stringify(ordered)], { type: 'application/json' });
  } catch {
    return blob;
  }
}

async function loadLive2D(catalog, selection, part, signal) {
  const id = gameOf(selection.character);
  const source = catalog.games[id];
  const folder = part.model.slice(0, part.model.lastIndexOf('/') + 1);
  const raw = source.assetBase + source.commit + '/';
  const lfs = gameById(id).lfsBase + source.commit + '/';
  const settings = await (await fetchAsset(raw + part.model, signal)).json();
  const plan = live2dMotionPlan(settings.FileReferences?.Motions);
  if (!plan.idle) throw new Error('这套服装暂无可播放动画');
  const blobs = Object.fromEntries(await Promise.all(live2dFiles(settings, plan).map(async file => {
    const blob = await (await fetchAsset((file.lfs ? lfs : raw) + folder + file.path, signal)).blob();
    return [file.path, file.path.endsWith('.motion3.json') ? await inOrder(blob) : blob];
  })));
  return { live2d: true, settings: { ...settings, url: raw + part.model }, plan, blobs, objectUrls: [] };
}

// An Azur Lane dynamic painting: every layer's binary skeleton, atlas text
// and decoded pages (straight alpha), top layer first.
async function loadPainting(catalog, selection, part, signal) {
  const id = gameOf(selection.character);
  const folder = gameById(id).paintingBase + catalog.games[id].paintingCommit + '/' + part.painting + '/';
  const layers = await Promise.all(part.layers.map(async layer => {
    const [skeleton, atlas] = await Promise.all([
      fetchAsset(folder + layer.skeleton, signal).then(response => response.arrayBuffer()),
      fetchAsset(folder + layer.atlas, signal).then(response => response.text()),
    ]);
    const images = Object.fromEntries(await Promise.all(atlasPages(atlas).map(async page =>
      [page, await createImageBitmap(await (await fetchAsset(folder + page, signal)).blob(), { premultiplyAlpha: 'none' })])));
    return { skeleton: new Uint8Array(skeleton), atlas, images };
  }));
  return { painting: true, layers, objectUrls: [] };
}

export async function loadCharacter(catalog, selection, mode, signal) {
  const part = partFor(selection, mode);
  if (!part) throw new Error('这套服装没有对应的动画');
  if (part.runtime === 'live2d') return loadLive2D(catalog, selection, part, signal);
  if (part.runtime === '3.8') return loadPainting(catalog, selection, part, signal);
  const local = mode === 'portrait' && part.skeleton === LOCAL_FALLBACK_CHARACTER.costumes[0].idle.skeleton;
  const source = catalog.games[gameOf(selection.character)];
  const remote = source.assetBase + source.commit + '/';
  const skelUrl = local ? '/companion/assets/' + part.skeleton.split('/').pop() : remote + part.skeleton;
  const atlasUrl = local ? '/companion/assets/' + part.atlas.split('/').pop() : remote + part.atlas;
  const [skeleton, atlas] = await Promise.all([
    fetchAsset(skelUrl, signal).then(response => response.blob()),
    fetchAsset(atlasUrl, signal).then(response => response.text()),
  ]);
  const baseUrl = new URL(atlasUrl, location.href);
  const textureUrls = atlasPages(atlas).map(page => new URL(page, baseUrl).href);
  // A few Brown Dust 2 cutscenes are stored as CutScene_Char…png while their
  // atlas asks for cutscene_char…png; raw GitHub paths are case-sensitive.
  const stem = part.skeleton.split('/').pop().replace(/\.skel$/i, '');
  const stored = url => {
    const page = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    return page.toLowerCase().startsWith(stem.toLowerCase()) && !page.startsWith(stem) ?
      url.slice(0, url.lastIndexOf('/') + 1) + encodeURIComponent(stem + page.slice(stem.length)) : url;
  };
  const [textures, skeletonData] = await Promise.all([
    Promise.all(textureUrls.map(async url => [url, await (await fetchAsset(stored(url), signal)).blob()])),
    readDataURI(skeleton, signal),
  ]);
  // Spine reads the skeleton and atlas only from data URIs, but textures load
  // through <img>. Blob URLs skip base64 for the largest files; the owner of
  // these assets revokes them once no new player can use them. Spine decodes
  // base64 text with atob, which garbles UTF-8 region names (NIKKE atlases use
  // Korean ones), while a plain data URI hands back the text after the comma.
  const rawDataURIs = { [skelUrl]: skeletonData, [atlasUrl]: 'data:text/plain;charset=utf-8,' + atlas };
  const objectUrls = textures.map(([url, blob]) => (rawDataURIs[url] = URL.createObjectURL(blob)));
  // Runtime joins relative local atlas paths without expanding them to location.origin.
  if (local) {
    for (const url of textureUrls) rawDataURIs[new URL(url).pathname] = rawDataURIs[url];
  }
  // Brown Dust 2 skills also bring their full performances and the few
  // skeletons those borrow layers from.
  const performances = mode === 'skill' ? source.performances?.[performanceId(part)] : undefined;
  const externals = performances ? await Promise.all(performanceSources(performances)
    .map(path => loadExternalSkeleton(remote, path, signal).catch(error => {
      if (error?.name === 'AbortError') throw error;
      return null; // Only the performances that borrow from it are dropped.
    }))) : [];
  return { skelUrl, atlasUrl, rawDataURIs, objectUrls, premultipliedAlpha: /^pma:\s*true\s*$/m.test(atlas),
    performances, externals: externals.filter(Boolean) };
}

// A borrowed skeleton's binary, atlas and decoded pages (straight alpha, as
// the player's own textures are uploaded).
async function loadExternalSkeleton(remote, path, signal) {
  const [skeleton, atlas] = await Promise.all([
    fetchAsset(remote + path + '.skel', signal).then(response => response.arrayBuffer()),
    fetchAsset(remote + path + '.atlas', signal).then(response => response.text()),
  ]);
  const folder = remote + path.slice(0, path.lastIndexOf('/') + 1);
  const images = Object.fromEntries(await Promise.all(atlasPages(atlas).map(async page =>
    [page, await createImageBitmap(await (await fetchAsset(folder + page, signal)).blob(), { premultiplyAlpha: 'none' })])));
  return { source: path, skeleton: new Uint8Array(skeleton), atlas, images, premultipliedAlpha: /^pma:\s*true\s*$/m.test(atlas) };
}
