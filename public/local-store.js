// The configuration store of the Chrome extension: what server.py's Store
// keeps in SQLite and data/backups, kept in chrome.storage.local instead.
// Extension pages and the background worker share it; every change runs
// under one Web Lock so a save and a sync never interleave.
import { validateState, withTrash, StateError } from './state-model.js';

export const STATE_KEY = 'litenav.state';
export const PREFS_KEY = 'litenav.prefs';
export const BACKUP_INDEX_KEY = 'litenav.backups';
const backupKey = (id) => 'litenav.backup.' + id;

export const BACKUP_KEEP = 30;
export const BULK_REMOVAL = 5;
const BACKUP_ID = /^(?<day>\d{8})-\d{6}-\d{6}-(?<reason>daily|bulk|before-restore|manual|sync)$/;

const pad = (value, width = 2) => String(value).padStart(width, '0');
const localDay = (date) => date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
// The local time with its offset, as server.py writes exportedAt.
export function localIso(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
    sign + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60);
}

// One lock for pages and the worker alike; tests pass an in-process one.
export function webLock(name = 'litenav-state') {
  return (task) => globalThis.navigator.locks.request(name, task);
}

export function memoryLock() {
  let queue = Promise.resolve();
  return (task) => {
    const run = queue.then(() => task());
    queue = run.catch(() => {});
    return run;
  };
}

// The configuration of a stored record or state: its 回收站 travels with it.
export const documentOf = (state) => ({ categories: state.categories, links: state.links, settings: state.settings, ...(state.trash?.length ? { trash: state.trash } : {}) });

export function createLocalStore({ area, withLock = webLock(), seed, now = () => new Date() }) {
  let micro = 0;
  const get = async (key) => (await area.get(key))[key];

  async function ensure() {
    const stored = await get(STATE_KEY);
    if (stored) return stored;
    // The seed counts as never edited: on joining a sync, any copy edited
    // anywhere wins over it.
    const initial = { revision: 1, updatedAt: now().toISOString(), editedAt: null, origin: 'seed', ...validateState(await seed()) };
    await area.set({ [STATE_KEY]: initial });
    return initial;
  }

  async function backupIds() {
    const ids = await get(BACKUP_INDEX_KEY);
    return Array.isArray(ids) ? ids.filter((id) => BACKUP_ID.test(id)).sort() : [];
  }

  async function writeBackup(record, reason) {
    const date = now();
    // Two backups in the same millisecond still get distinct, ordered names.
    micro = (micro + 1) % 1000;
    const id = localDay(date) + '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds()) + '-' + pad(date.getMilliseconds(), 3) + pad(micro, 3) + '-' + reason;
    const content = { version: 1, exportedAt: localIso(date), reason, revision: record.revision, ...documentOf(record) };
    const ids = [...await backupIds(), id].sort();
    const dropped = ids.slice(0, Math.max(0, ids.length - BACKUP_KEEP));
    await area.set({ [backupKey(id)]: content, [BACKUP_INDEX_KEY]: ids.slice(dropped.length) });
    if (dropped.length) await area.remove(dropped.map(backupKey));
    return id;
  }

  async function backupReason(previous, cleaned) {
    const linkIds = new Set(cleaned.links.map((link) => link.id));
    const categoryIds = new Set(cleaned.categories.map((item) => item.id));
    const removedLinks = previous.links.filter((link) => !linkIds.has(link.id)).length;
    const removedCategories = previous.categories.some((item) => !categoryIds.has(item.id));
    if (removedLinks >= BULK_REMOVAL || removedCategories) return 'bulk';
    const today = localDay(now());
    return (await backupIds()).some((id) => id.startsWith(today)) ? null : 'daily';
  }

  // Writes a cleaned document as the next revision, backing up the previous
  // one when server.py would (or always, with backupAs).
  // trash: keepPrevious keeps the 回收站 a save left out; recordRemoved puts
  // the sites it removes there (see withTrash).
  async function commit(current, cleaned, { backup = true, backupAs = null, origin = 'local', trash = { keepPrevious: true, recordRemoved: true } } = {}) {
    cleaned = withTrash(current, cleaned, { ...trash, now: now() });
    const reason = backupAs || (backup ? await backupReason(current, cleaned) : null);
    if (reason) await writeBackup(current, reason);
    const stamp = now().toISOString();
    // editedAt is when someone last changed this copy here; sync orders
    // conflicting edits by it, so applying a sync leaves it as it was.
    const editedAt = origin === 'local' ? stamp : current.editedAt ?? null;
    const next = { revision: current.revision + 1, updatedAt: stamp, editedAt, origin, ...cleaned };
    await area.set({ [STATE_KEY]: next });
    return next;
  }

  const view = (record) => ({ revision: record.revision, ...documentOf(record) });

  return {
    async state() { return view(await ensure()); },
    // The stored record, with when and where (local or sync) it last changed.
    async record() { return ensure(); },

    async save(value, options = {}) {
      return withLock(async () => {
        const current = await ensure();
        const revision = value?.revision;
        if (typeof revision !== 'number' || revision !== current.revision) throw new StateError('配置已在其他页面更新，请刷新后重试', 409);
        // A page that never knew a 回收站 keeps it; undoing an import records nothing.
        const trash = { keepPrevious: !('trash' in value), recordRemoved: value.trashRemoved !== false };
        return view(await commit(current, validateState(value), { ...options, trash }));
      });
    },

    // Runs change(current record) under the lock; a returned document becomes
    // the next revision. Used by sync, which must not lose a save in between.
    async transact(change) {
      return withLock(async () => {
        const current = await ensure();
        const result = await change(current);
        if (!result?.document) return { record: current, changed: false, ...result };
        // A sync's merged document says what 回收站 holds, empty included.
        const record = await commit(current, validateState(result.document), { trash: { keepPrevious: false, recordRemoved: true }, ...result.options });
        return { record, changed: true, ...result };
      });
    },

    async backups() {
      const listed = [];
      for (const id of (await backupIds()).reverse()) {
        const content = await get(backupKey(id));
        if (!content) continue;
        listed.push({ id, createdAt: content.exportedAt, reason: BACKUP_ID.exec(id).groups.reason,
          links: (content.links || []).length, categories: (content.categories || []).length });
      }
      return listed;
    },

    async readBackup(id) {
      if (typeof id !== 'string' || !BACKUP_ID.test(id)) throw new StateError('备份不存在', 404);
      const content = await get(backupKey(id));
      if (!content) throw new StateError('备份不存在', 404);
      return content;
    },

    async backupNow() {
      return withLock(async () => writeBackup(await ensure(), 'manual'));
    },

    async restoreBackup(id) {
      const content = await this.readBackup(id);
      return withLock(async () => {
        const current = await ensure();
        return view(await commit(current, validateState(content), { backupAs: 'before-restore', trash: { keepPrevious: !('trash' in content), recordRemoved: true } }));
      });
    },

    // Companion preferences: the page's localStorage copy, mirrored here so
    // the worker can sync it. updatedAt orders changes between devices.
    async prefs() { return (await get(PREFS_KEY)) || null; },
    async setPrefs(value, { origin = 'local' } = {}) {
      const stamp = now().toISOString();
      const previous = origin === 'local' ? null : await get(PREFS_KEY);
      const record = { value, updatedAt: stamp, editedAt: origin === 'local' ? stamp : previous?.editedAt || null, origin };
      await area.set({ [PREFS_KEY]: record });
      return record;
    },
  };
}
