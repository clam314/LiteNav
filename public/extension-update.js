// 检查更新 for the Chrome extension. Chrome never updates an extension loaded
// from a folder, and an extension cannot replace its own files: this finds
// out whether GitHub Actions published a newer build (the extension-latest
// release), so the page can offer the download, and reload the extension
// once its folder holds the new files.
export const UPDATE_KEY = 'litenav.update';
export const RELEASE_API = 'https://api.github.com/repos/clam314/LiteNav/releases/tags/extension-latest';
export const RELEASES_PAGE = 'https://github.com/clam314/LiteNav/releases/tag/extension-latest';
// GitHub allows 60 unauthenticated API calls an hour; once a day is plenty.
export const CHECK_MS = 20 * 60 * 60 * 1000;

const parts = (version) => (/^\d+(\.\d+){0,3}$/.test(String(version || '')) ? String(version).split('.').map(Number) : null);

export function compareVersions(a, b) {
  const [left, right] = [parts(a) || [], parts(b) || []];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

// Builds from the release carry a fourth number (the workflow run); one built
// by hand from the source does not, and is not compared.
export const releaseBuild = (version) => /^\d+\.\d+\.\d+\.\d+$/.test(String(version || ''));

// The version and download of the published build, from the release's assets.
export function latestFromRelease(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  let version = null;
  for (const asset of assets) {
    const match = /^litenav-extension-(\d+\.\d+\.\d+\.\d+)\.zip$/.exec(asset?.name || '');
    if (match && (!version || compareVersions(match[1], version) > 0)) version = match[1];
  }
  if (!version) return null;
  const download = (name) => assets.find((asset) => asset?.name === name)?.browser_download_url;
  return {
    version,
    zipUrl: download('litenav-extension.zip') || download('litenav-extension-' + version + '.zip'),
    pageUrl: release.html_url || RELEASES_PAGE,
    publishedAt: release.published_at || null,
  };
}

export function createUpdateChecker({ area, currentVersion, fetchImpl = (...args) => globalThis.fetch(...args), now = () => Date.now() }) {
  const read = async () => (await area.get(UPDATE_KEY))[UPDATE_KEY] || {};
  const shape = (record) => {
    const latest = record.latest || null;
    return {
      current: currentVersion,
      releaseBuild: releaseBuild(currentVersion),
      checkedAt: record.checkedAt || null,
      error: record.error || null,
      latest,
      available: Boolean(latest) && releaseBuild(currentVersion) && compareVersions(latest.version, currentVersion) > 0,
    };
  };

  return {
    async status() { return shape(await read()); },

    // Asks GitHub unless it was asked recently (force: 检查更新 in the page).
    async check({ force = false } = {}) {
      const record = await read();
      if (!force && record.checkedAt && now() - Date.parse(record.checkedAt) < CHECK_MS) return shape(record);
      let next;
      try {
        const response = await fetchImpl(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (response.status === 404) next = { latest: null, error: null };
        else if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub 暂时限制了查询次数，请稍后再试' : 'GitHub 返回错误（HTTP ' + response.status + '）');
        else next = { latest: latestFromRelease(await response.json()), error: null };
      } catch (error) {
        // Keep what was known; a failed check is tried again next time.
        const message = error?.name === 'TimeoutError' || error instanceof TypeError ? '无法连接 GitHub' : error.message;
        const failed = { ...record, error: message };
        await area.set({ [UPDATE_KEY]: failed });
        return shape(failed);
      }
      const saved = { ...next, checkedAt: new Date(now()).toISOString() };
      await area.set({ [UPDATE_KEY]: saved });
      return shape(saved);
    },
  };
}
