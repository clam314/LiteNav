// Chrome account sync as a channel for the synced document: chrome.storage.sync
// carries it to every Chrome signed in to the same Google account.
//
// The store allows 8 KB per item and 100 KB in all, so the document is
// gzipped, base64-encoded and split into chunks. Chunks of each version live
// under keys of their own (ln.<generation>.<n>) and a meta item names the
// current generation and its hash: another device that has received the meta
// before all of its chunks waits for them instead of reading a mix.
export const META_KEY = 'ln.meta';
const PREFIX = 'ln.';
const CHUNK_CHARS = 7000;
// chrome.storage.sync.QUOTA_BYTES is 102400; leave room for the meta and keys.
export const SYNC_LIMIT_BYTES = 96 * 1024;

export class SyncQuotaError extends Error {}

async function pipe(bytes, stream) {
  const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}

function toBase64(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function encodeDocument(document) {
  const json = JSON.stringify(document);
  const hash = await sha256(json);
  const packed = toBase64(await pipe(new TextEncoder().encode(json), new CompressionStream('gzip')));
  const chunks = [];
  for (let index = 0; index < packed.length; index += CHUNK_CHARS) chunks.push(packed.slice(index, index + CHUNK_CHARS));
  return { hash, generation: hash.slice(0, 12), chunks, bytes: packed.length, rawBytes: json.length };
}

export async function decodeDocument(chunks, hash) {
  const json = new TextDecoder().decode(await pipe(fromBase64(chunks.join('')), new DecompressionStream('gzip')));
  if (hash && await sha256(json) !== hash) return null;
  return JSON.parse(json);
}

// area is chrome.storage.sync, or a stand-in with the same get/set/remove.
export function createChromeSyncChannel({ area }) {
  return {
    id: 'chrome',

    // null when nothing was synced yet; { incomplete: true } while chunks are
    // still arriving from another device.
    async read() {
      const items = await area.get(null);
      const meta = items[META_KEY];
      if (!meta || typeof meta !== 'object') return null;
      const chunks = [];
      for (let index = 0; index < meta.chunks; index += 1) {
        const chunk = items[PREFIX + meta.generation + '.' + index];
        if (typeof chunk !== 'string') return { incomplete: true, meta };
        chunks.push(chunk);
      }
      let document;
      try { document = await decodeDocument(chunks, meta.hash); }
      catch { return { incomplete: true, meta }; }
      if (!document) return { incomplete: true, meta };
      return { document, hash: meta.hash, editedAt: meta.editedAt || null, writtenAt: meta.writtenAt || null, deviceId: meta.deviceId || null, bytes: meta.bytes || 0 };
    },

    async write(document, { editedAt, deviceId, writtenAt = new Date().toISOString() } = {}) {
      const encoded = await encodeDocument(document);
      if (encoded.bytes > SYNC_LIMIT_BYTES) {
        throw new SyncQuotaError('配置压缩后约 ' + Math.ceil(encoded.bytes / 1024) + ' KB，超过 Chrome 同步的容量（约 ' + Math.floor(SYNC_LIMIT_BYTES / 1024) + ' KB）');
      }
      const meta = { version: 1, generation: encoded.generation, chunks: encoded.chunks.length, hash: encoded.hash, bytes: encoded.bytes, editedAt, writtenAt, deviceId };
      const items = { [META_KEY]: meta };
      encoded.chunks.forEach((chunk, index) => { items[PREFIX + encoded.generation + '.' + index] = chunk; });
      const existing = Object.keys(await area.get(null));
      // Old chunks go first, then the new version in one write (one quota
      // operation): writing first could pass the 100 KB limit mid-way.
      const stale = existing.filter((key) => key.startsWith(PREFIX) && key !== META_KEY && !(key in items));
      if (stale.length) await area.remove(stale);
      await area.set(items);
      return { hash: encoded.hash, bytes: encoded.bytes };
    },

    async clear() {
      const keys = Object.keys(await area.get(null)).filter((key) => key.startsWith(PREFIX));
      if (keys.length) await area.remove(keys);
    },
  };
}
