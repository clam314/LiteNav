// Azur Lane dynamic paintings: Spine 3.8 skeletons in layers (a figure, a
// background, sometimes props), listed top first. These helpers are the
// parts of the painting player that need no browser.

// The 3.8 binary reader turns each byte of a UTF-8 name into a character of
// its own, read as a signed byte: 0xE5 becomes U+FFE5. Region names in
// Chinese then miss the atlas. Undo that: map such characters back to bytes
// and decode them. Names that were read correctly come back unchanged.
const decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }) : null;

export function recoverUtf8(name) {
  if (!decoder || typeof name !== 'string' || ![...name].some(char => char.charCodeAt(0) >= 0xFF80)) return name;
  const bytes = [];
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code >= 0xFF80) bytes.push(code - 0xFF00);
    else if (code < 0x80) bytes.push(code);
    else return name;
  }
  try { return decoder.decode(new Uint8Array(bytes)); } catch { return name; }
}

// The names to try in the atlas for a region the skeleton asks for: as
// read, repaired, and without the stray spaces some exports leave in them.
export function regionCandidates(name) {
  const repaired = recoverUtf8(name);
  return [...new Set([name, repaired, name.trim(), repaired.trim()])];
}

// The loop a painting plays, as the reference player chooses it.
export function paintingAnimation(names) {
  if (names.includes('normal')) return 'normal';
  if (names.includes('idle')) return 'idle';
  return names.at(-1) ?? null;
}

// The camera for a view (world units, y up) on a canvas of the rail's size
// in pixels: the view fills the height, stands on the bottom edge and is
// centred in the space the navigation leaves free. zoom is world units per
// pixel; x and y are the world point at the canvas centre.
export function placePainting(view, rail, space) {
  const zoom = view.height / rail.height;
  const centre = rail.width - Math.min(space, rail.width) / 2;
  return {
    zoom,
    x: view.x + view.width / 2 - (centre - rail.width / 2) * zoom,
    y: view.y + rail.height / 2 * zoom,
  };
}
