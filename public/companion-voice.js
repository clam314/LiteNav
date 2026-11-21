// Azur Lane voice lines (the Japanese cast) said with a reaction, one at a
// time. Browsers may refuse sound until the viewer interacts with the page
// (Chrome allows it at once on sites it often plays media for); a refused
// line is skipped, and no further line is fetched until a click or key press.

// Ogg Vorbis, as the lines are extracted from the game.
export function voiceSupported() {
  try { return Boolean(document.createElement('audio').canPlayType?.('audio/ogg; codecs=vorbis')); }
  catch { return false; }
}

// The URL of a costume's line for a motion, or null. path is "skin/key" as
// the catalog lists it under costume.voices.
export function voiceUrl(base, commit, path) {
  return base && commit && typeof path === 'string' && /^\d+\/\w+$/.test(path)
    ? `${base}${commit}/audio/voiceline/${path}.ogg` : null;
}

// fetchAsset(url) answers with a Response from the companion's asset cache.
export function createVoice({ fetchAsset, target = window }) {
  const audio = new Audio();
  let turn = 0;
  let objectUrl = '';
  let owner = null;
  let refused = false;
  const allow = () => { refused = false; };
  target.addEventListener('pointerdown', allow, { capture: true });
  target.addEventListener('keydown', allow, { capture: true });
  const release = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = '';
  };
  const silence = () => {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    release();
  };
  return {
    get owner() { return owner; },
    // Says the line at url for owner (a stage record), cutting off any line before.
    async play(url, volume, by) {
      const mine = ++turn;
      silence();
      owner = by;
      // Sound was refused and nothing has changed since: skip the download too.
      if (!url || refused) return;
      try {
        const blob = await (await fetchAsset(url)).blob();
        if (mine !== turn) return;
        objectUrl = URL.createObjectURL(blob);
        audio.src = objectUrl;
        audio.volume = Math.min(1, Math.max(0, volume));
        await audio.play();
      } catch (error) {
        // Offline or undecodable lines are skipped; the reaction carries on silently.
        if (error?.name === 'NotAllowedError') refused = true;
      }
    },
    setVolume(volume) { audio.volume = Math.min(1, Math.max(0, volume)); },
    // Stops the current line; with by, only if it belongs to that record.
    stop(by) {
      if (by && by !== owner) return;
      turn += 1;
      owner = null;
      silence();
    },
    dispose() {
      this.stop();
      target.removeEventListener('pointerdown', allow, { capture: true });
      target.removeEventListener('keydown', allow, { capture: true });
    },
  };
}
