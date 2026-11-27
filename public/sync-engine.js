// Keeps this browser's configuration and companion preferences in step with
// the copy on a sync channel (Chrome account sync for now). Each run reads the
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

export function createSyncEngine({ store, channel, area, withLock = globalThis.navigator?.locks ? webLock('litenav-sync') : memoryLock(), now = () => new Date() }) {
  const readMeta = async () => ({ enabled: false, base: null, deviceId: null, ...((await area.get(SYNC_KEY))[SYNC_KEY] || {}) });
  const writeMeta = async (meta) => { await area.set({ [SYNC_KEY]: meta }); return meta; };
  const newDeviceId = () => globalThis.crypto?.randomUUID?.() || 'device-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const status = (meta) => ({
    enabled: Boolean(meta.enabled), provider: channel.id, state: meta.state || (meta.enabled ? 'idle' : 'off'),
    lastSyncedAt: meta.lastSyncedAt || null, lastError: meta.lastError || null, conflicts: meta.conflicts || 0,
    bytes: meta.bytes || 0, deviceId: meta.deviceId,
  });

  async function localDocument(record) {
    const prefs = await store.prefs();
    return { document: { ...documentOf(record), prefs: prefs?.value ?? null }, editedAt: latest(record.editedAt, prefs?.editedAt), prefs };
  }

  // mode decides the first run after sync is turned on with data on both
  // sides: merge them, or let one replace the other. Later runs always merge.
  async function runLocked(meta) {
    // Until a first run succeeds, the choice made when turning sync on holds.
    let mode = meta.base ? 'merge' : meta.pendingMode || 'merge';
    const remote = await channel.read();
    if (remote?.incomplete) return writeMeta({ ...meta, state: 'waiting' });
    const deviceId = meta.deviceId || newDeviceId();
    let pushed = null;
    let conflicts = 0;
    const { record } = await store.transact(async (current) => {
      const local = await localDocument(current);
      // A browser that only has the starter sites takes the synced copy as it
      // is: merging would bring back starter sites deleted elsewhere.
      if (remote && !meta.base && mode === 'merge' && !local.editedAt) mode = 'remote';
      let merged;
      if (!remote || mode === 'local') merged = local.document;
      else if (mode === 'remote') merged = { ...remote.document, prefs: remote.document.prefs ?? local.document.prefs };
      else {
        const result = mergeDocuments(meta.base, local.document, remote.document, { preferLocal: later(local.editedAt, remote.editedAt) });
        merged = result.document;
        conflicts = result.conflicts.filter((item) => item.kind !== 'duplicate-url').length;
        // A merge the rules reject (it should not happen) falls back to the copy edited last.
        try { validateState(merged); }
        catch { merged = later(local.editedAt, remote.editedAt) ? local.document : remote.document; }
      }
      const config = documentOf(merged);
      pushed = { merged, editedAt: latest(local.editedAt, remote?.editedAt) };
      if (merged.prefs && !sameDocument(merged.prefs, local.document.prefs)) await store.setPrefs(merged.prefs, { origin: 'sync' });
      if (sameDocument(config, documentOf(local.document))) return {};
      // Replacing this copy wholesale is always backed up first.
      return { document: config, options: { origin: 'sync', backupAs: mode === 'remote' ? 'sync' : null } };
    });
    // The stored copy is the cleaned one; send exactly that.
    const document = { ...documentOf(record), prefs: pushed.merged.prefs ?? null };
    let bytes = meta.bytes || remote?.bytes || 0;
    if (!remote || !sameDocument(document, remote.document)) {
      ({ bytes } = await channel.write(document, { editedAt: pushed.editedAt, deviceId, writtenAt: now().toISOString() }));
    }
    return writeMeta({ ...meta, enabled: true, deviceId, base: document, pendingMode: null, state: 'idle', lastSyncedAt: now().toISOString(), lastError: null, conflicts, bytes });
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
    async inspect() {
      const remote = await channel.read();
      if (!remote) return { remote: null };
      if (remote.incomplete) return { remote: { incomplete: true } };
      const local = await localDocument(await store.record());
      return { remote: { ...summary(remote.document), editedAt: remote.editedAt, writtenAt: remote.writtenAt, same: sameDocument(documentOf(remote.document), documentOf(local.document)) },
        local: { ...summary(local.document), editedAt: local.editedAt } };
    },

    // Sync stays on even if this first run fails (offline, quota): later runs retry it.
    enable(mode = 'merge') { return guarded(async (meta) => runLocked(await writeMeta({ ...meta, enabled: true, base: null, pendingMode: mode, state: 'idle', lastError: null }))); },

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
