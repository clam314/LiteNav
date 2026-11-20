import { placeView } from './companion-model.js';

// The free width the navigation leaves beside the rail, as the layout publishes it.
export const railSpace = (layer, width = layer.clientWidth) =>
  parseFloat(getComputedStyle(layer).getPropertyValue('--companion-space')) || width / 2;

// Spine fits its whole canvas to the camera. The canvas fills the rail, and the
// camera is widened around the preset view so that view stands on the bottom
// edge while artwork beyond it keeps drawing toward the faded rail edges.
// The cover and aim skeletons place the figure at different spots, so a
// shared camera made her jump sideways on every switch. Give both views the
// same size (and so the same scale), each centred on its own figure and
// standing on its own floor, so a switch changes the pose but not the place.
export const alignedViews = (a, b) => {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const frame = view => ({ x: view.x + view.width / 2 - width / 2, y: view.y, width, height });
  return [frame(a), frame(b)];
};

// A second player for NIKKE's cover skeleton, sharing the layer and camera.
export function spawnPartner(spine, layer, assets, part, record) {
  return new Promise((resolve, reject) => {
    record.partner = new spine.SpinePlayer(layer, {
      binaryUrl: assets.skelUrl, atlasUrl: assets.atlasUrl, rawDataURIs: assets.rawDataURIs,
      viewport: { padLeft: '5%', padRight: '5%', padTop: '5%', padBottom: '5%', transitionTime: 0 },
      premultipliedAlpha: assets.premultipliedAlpha,
      alpha: true, backgroundColor: '#00000000', showControls: false, showLoading: false,
      preserveDrawingBuffer: false, defaultMix: 0,
      ...(part.skin ? { skin: part.skin } : {}),
      success: resolve,
      error: () => reject(new Error('角色动画暂时无法播放')),
      frame(player) { if (record.view) layoutCamera(record, player); },
    });
  });
}

export function layoutCamera(record, player) {
  const width = player.canvas.clientWidth;
  const height = player.canvas.clientHeight;
  const key = width + 'x' + height;
  if (!width || !height || key === player.companionRailKey) return;
  player.companionRailKey = key;
  const space = railSpace(record.layer, width);
  // Wide full shots stay out of the strongest left fade.
  const maxWidth = record.layer.classList.contains('fit-artwork') ? Math.max(width * .75, space) : width;
  Object.assign(player.currentViewport, placeView(player.companionView || record.view, { width, height }, space, maxWidth));
}
