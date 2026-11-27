// Keeps this browser's configuration and companion preferences in step with
// the copy on a sync channel: Chrome account sync or a self-hosted server. Each run reads the
// channel, merges it with the local copy against the copy both had after the
// previous run (the base), stores the result here and sends it back when the
// channel lacks any of it. Extension pages and the background worker both run
// it; one Web Lock keeps runs from overlapping.
import { documentOf, memoryLock, webLock } from './local-store.js';
import { mergeDocuments, sameDocument } from './sync-merge.js';
import { validateState } from './state-model.js';

export const SYNC_KEY = 'litenav.sync';

const latest = (...stamps) => stamps.filter(Boolean).sort().pop() || null;
const later = (a, b) => Boolean(a) && (!b || a > b);

const summary = (document) => ({ links: document?.links?.length || 0, categories: document?.categories?.length || 0 });

// channel is a fixed channel (tests); channelFor(provider) picks one by the
// provider sync was turned on with ('chrome' or 'server').
export function createSyncEngine({ store, channel, channelFor, area, withLock = globalThis.navigator?.locks ? webLock('litenav-sync') : memoryLock(), now = () => new Date() }) {
  const readMeta = async () => ({ enabled: false, base: null, deviceId: null, ...((await area.get(SYNC_KEY))[SYNC_KEY] || {}) });
  const writeMeta = async (meta) => { await area.set({ [SYNC_KEY]: meta }); return meta; };
  const newDeviceId = () => globalThis.crypto?.randomUUID?.() || 'device-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const channelOf = async (provider) => channelFor ? channelFor(provider) : channel;

  // remote says who wrote the synced copy last (this device or another) and
  // when, so the page can tell whether another device's data has arrived.
  const status = (meta) => ({
    enabled: Boolean(meta.enabled), provider: meta.provider || 'chrome', server: meta.server || null, state: meta.state || (meta.enabled ? 'idle' : 'off'),
    lastSyncedAt: meta.lastSyncedAt || null, lastError: meta.lastError || null, conflicts: meta.conflicts || 0,
    bytes: meta.bytes || 0, deviceId: meta.deviceId, remote: meta.remote || null,
  });

  // configEditedAt is when someone last changed the sites, categories or
  // settings here: whether this copy holds data of its own. The companion
  // writes its preferences on its own at startup, so they do not count.
  async function localDocument(record) {
    const prefs = await store.prefs();
    return { document: { ...documentOf(record), prefs: prefs?.value ?? null }, editedAt: latest(record.editedAt, prefs?.editedAt),
      configEditedAt: record.editedAt || null, prefs };
  }

  // Whether the synced copy's configuration was ever edited (channels from
  // before the field say so through editedAt).
  const remoteConfigEdited = (remote) => remote ? (remote.configEditedAt !== undefined ? remote.configEditedAt : remote.editedAt) || null : null;

  // mode decides the first run after sync is turned on with data on both
  // sides: merge them, or let one replace the other. Later runs always merge.
  async function runOnce(meta) {
    const channel = await channelOf(meta.provider || 'chrome');
    // Until a first run succeeds, the choice made when turning sync on holds.
    let mode = meta.base ? 'merge' : meta.pendingMode || 'merge';
    const remote = await channel.read();
    if (remote?.incomplete) return writeMeta({ ...meta, state: 'waiting' });
    const deviceId = meta.deviceId || newDeviceId();
    const remoteEdited = remoteConfigEdited(remote);
    let pushed = null;
    let conflicts = 0;
    let holding = false;
    const { record } = await store.transact(async (current) => {
      const local = await localDocument(current);
      const ownData = Boolean(local.configEditedAt);
      // Nothing synced yet and nothing of its own: a browser shares nothing.
      // Another device's copy may still be on its way (Chrome account sync
      // takes a while), and its starter sites must not get there first.
      if (!remote && !ownData) { holding = true; return {}; }
      // A browser that only has the starter sites takes the synced copy as it
      // is: merging would bring back starter sites deleted elsewhere.
      if (remote && mode === 'merge' && !ownData && !meta.base) mode = 'remote';
      // A synced copy nobody ever edited (starter sites a fresh browser shared
      // before this one's data reached it) never removes edited data here.
      if (remote && mode === 'merge' && ownData && !remoteEdited) mode = 'local';
      let merged;
      if (!remote || mode === 'local') merged = local.document;
      else if (mode === 'remote') merged = { ...remote.document, prefs: remote.document.prefs ?? local.document.prefs };
      else {
        const result = mergeDocuments(meta.base, local.document, remote.document, { preferLocal: later(local.editedAt, remote.editedAt) });
        merged = result.document;
        // Without a base (the first sync) differences are not edits made on both sides.
        conflicts = meta.base ? result.conflicts.filter((item) => item.kind !== 'duplicate-url').length : 0;
        // A merge the rules reject (it should not happen) falls back to the copy edited last.
        try { validateState(merged); }
        catch { merged = later(local.editedAt, remote.editedAt) ? local.document : remote.document; }
      }
      const config = documentOf(merged);
      pushed = { merged, editedAt: latest(local.editedAt, remote?.editedAt), configEditedAt: latest(local.configEditedAt, remoteEdited) };
      if (merged.prefs && !sameDocument(merged.prefs, local.document.prefs)) await store.setPrefs(merged.prefs, { origin: 'sync' });
      if (sameDocument(config, documentOf(local.document))) return {};
      // Replacing this copy wholesale is always backed up first.
      // The device that deleted a site already put it in 回收站, or emptied
      // that on purpose; only a copy from a build without one leaves it to us.
      const recordRemoved = Boolean(remote) && !Array.isArray(remote.document.trash);
      return { document: config, options: { origin: 'sync', backupAs: mode === 'remote' ? 'sync' : null, trash: { keepPrevious: false, recordRemoved } } };
    });
    if (holding) {
      return writeMeta({ ...meta, enabled: true, deviceId, state: 'empty', lastSyncedAt: now().toISOString(), lastError: null, conflicts: 0, remote: null });
    }
    // The stored copy is the cleaned one; send exactly that.
    // trash goes out even when empty: a server keeps the 回收站 a save leaves out.
    const document = { ...documentOf(record), trash: record.trash || [], prefs: pushed.merged.prefs ?? null };
    let bytes = meta.bytes || remote?.bytes || 0;
    let writer = remote ? { thisDevice: Boolean(remote.deviceId) && remote.deviceId === deviceId, writtenAt: remote.writtenAt || null } : null;
    if (!remote || !sameDocument(document, remote.document)) {
      const writtenAt = now().toISOString();
      ({ bytes } = await channel.write(document, { editedAt: pushed.editedAt, configEditedAt: pushed.configEditedAt, deviceId, writtenAt }));
      writer = { thisDevice: true, writtenAt };
    }
    return writeMeta({ ...meta, enabled: true, deviceId, base: document, pendingMode: null, state: 'idle', lastSyncedAt: now().toISOString(), lastError: null, conflicts, bytes, remote: writer });
  }

  // A server refuses a write when its copy changed after the read (409):
  // read and merge again.
  async function runLocked(meta) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await runOnce(meta); }
      catch (error) { if (!error?.conflict || attempt >= 2) throw error; }
    }
  }

  async function guarded(task) {
    return withLock(async () => {
      const meta = await readMeta();
      try { return status(await task(meta)); }
      catch (error) {
        return status(await writeMeta({ ...(await readMeta()), state: 'error', lastError: error?.message || String(error) }));
      }
    });
  }

  return {
    async status() { return status(await readMeta()); },

    // What a device turning sync on would meet: nothing yet, or a copy from
    // another device, and whether it differs from this one.
    async inspect(provider = 'chrome') {
      const remote = await (await channelOf(provider)).read();
      if (!remote) return { remote: null };
      if (remote.incomplete) return { remote: { incomplete: true } };
      const local = await localDocument(await store.record());
      // editedAt is the configuration's: whether either side has data of its own to choose from.
      return { remote: { ...summary(remote.document), editedAt: remoteConfigEdited(remote), writtenAt: remote.writtenAt, same: sameDocument(documentOf(remote.document), documentOf(local.document)) },
        local: { ...summary(local.document), editedAt: local.configEditedAt } };
    },

    // Sync stays on even if this first run fails (offline, quota): later runs retry it.
    enable(mode = 'merge', { provider = 'chrome', server = null } = {}) {
      return guarded(async (meta) => runLocked(await writeMeta({ ...meta, enabled: true, provider, server, base: null, pendingMode: mode, state: 'idle', lastError: null })));
    },

    // Turning sync off keeps both copies; the base is forgotten so turning it
    // on again starts with a fresh choice.
    async disable() {
      return withLock(async () => status(await writeMeta({ ...(await readMeta()), enabled: false, base: null, pendingMode: null, state: 'off', lastError: null })));
    },

    run() {
      return guarded(async (meta) => meta.enabled ? runLocked(meta) : meta);
    },
  };
}
