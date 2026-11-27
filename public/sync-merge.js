// Three-way merge of two copies of the configuration that both changed since
// the last sync (base). Sites and categories merge one by one, by id, and
// settings and companion preferences key by key, so edits made on different
// devices — even offline — all survive. Only when both devices changed the
// same field differently does one side win: the copy saved more recently.

// A synced document: the configuration plus the companion preferences.
export const emptyDocument = () => ({ categories: [], links: [], settings: {}, prefs: null });

// JSON with sorted keys, so equal content compares equal.
export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

const same = (a, b) => stableJson(a) === stableJson(b);

// Three-way merge of one value: what changed on one side only is taken.
// Returns [value, conflicted].
function mergeValue(base, local, remote, preferLocal) {
  if (same(local, remote)) return [local, false];
  if (same(local, base)) return [remote, false];
  if (same(remote, base)) return [local, false];
  return [preferLocal ? local : remote, true];
}

// Merge of two objects key by key (an entity's fields, settings, preferences).
function mergeFields(base, local, remote, preferLocal) {
  const result = {};
  let conflicted = false;
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(local || {}), ...Object.keys(remote || {})]);
  for (const key of keys) {
    const [value, clash] = mergeValue(base?.[key], local?.[key], remote?.[key], preferLocal);
    conflicted ||= clash;
    if (value !== undefined) result[key] = value;
  }
  return [result, conflicted];
}

const byId = (items) => new Map((items || []).map((item) => [item.id, item]));

// Merge of a list of entities by id. An entity changed on one side and deleted
// on the other is kept: deleting something someone just edited loses work.
function mergeEntities(base, local, remote, preferLocal, conflicts) {
  const [b, l, r] = [byId(base), byId(local), byId(remote)];
  const first = preferLocal ? local : remote;
  const second = preferLocal ? remote : local;
  const ids = [...new Set([...(first || []), ...(second || [])].map((item) => item.id))];
  const merged = [];
  for (const id of ids) {
    const [baseItem, localItem, remoteItem] = [b.get(id), l.get(id), r.get(id)];
    if (same(localItem, remoteItem)) { if (localItem) merged.push(localItem); continue; }
    if (same(localItem, baseItem)) { if (remoteItem) merged.push(remoteItem); continue; }
    if (same(remoteItem, baseItem)) { if (localItem) merged.push(localItem); continue; }
    if (!localItem || !remoteItem) {
      merged.push(localItem || remoteItem);
      conflicts.push({ id, kind: 'kept-edited' });
      continue;
    }
    const [item, clash] = mergeFields(baseItem, localItem, remoteItem, preferLocal);
    if (clash) conflicts.push({ id, kind: 'both-edited' });
    merged.push(item);
  }
  return merged;
}

const canonical = (url) => String(url || '').replace(/\/+$/, '');

export function mergeDocuments(base, local, remote, { preferLocal = false } = {}) {
  base ||= emptyDocument();
  const conflicts = [];
  const categories = mergeEntities(base.categories, local.categories, remote.categories, preferLocal, conflicts);
  let links = mergeEntities(base.links, local.links, remote.links, preferLocal, conflicts);

  // A site kept or added on one device inside a category the other deleted
  // brings the category back rather than losing the site.
  const categoryIds = new Set(categories.map((item) => item.id));
  const known = [local, remote, base].flatMap((doc) => doc.categories || []);
  links = links.flatMap((link) => {
    if (!link.categoryId || categoryIds.has(link.categoryId)) return [link];
    const category = known.find((item) => item.id === link.categoryId);
    if (category) {
      categories.push(category);
      categoryIds.add(category.id);
      return [link];
    }
    if (link.kind === 'service') return [{ ...link, categoryId: null }];
    conflicts.push({ id: link.id, kind: 'dropped-orphan' });
    return [];
  });

  // The same address added on both devices (two ids) is kept once.
  const seen = new Set();
  links = links.filter((link) => {
    const key = canonical(link.url);
    if (seen.has(key)) { conflicts.push({ id: link.id, kind: 'duplicate-url' }); return false; }
    seen.add(key);
    return true;
  });

  const [settings, settingsClash] = mergeFields(base.settings, local.settings, remote.settings, preferLocal);
  if (settingsClash) conflicts.push({ id: 'settings', kind: 'both-edited' });

  let prefs = null;
  if (local.prefs || remote.prefs) {
    const [value, prefsClash] = mergeFields(base.prefs || {}, local.prefs || {}, remote.prefs || {}, preferLocal);
    if (prefsClash) conflicts.push({ id: 'prefs', kind: 'both-edited' });
    prefs = value;
  }
  return { document: { categories, links, settings, prefs }, conflicts };
}

export const sameDocument = (a, b) => same(a, b);
