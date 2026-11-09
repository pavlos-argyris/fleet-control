/** Retry transient download failures without weakening the caller's size, digest
 * or certificate verification of the exact pinned release asset. */
export async function fetchReleaseReference(url, {
  fetcher = fetch,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  attempts = 4,
  repository,
  assetId,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
} = {}) {
  const api = repository && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    && Number.isSafeInteger(assetId) && assetId > 0
    ? 'https://api.github.com/repos/' + repository + '/releases/assets/' + assetId : null;
  let failure, useApi = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetcher(useApi ? api : url, {
        signal: AbortSignal.timeout(120000),
        ...(useApi ? { headers: {
          Accept: 'application/octet-stream',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        } } : {}),
      });
      const retry = [429, 500, 502, 503, 504].includes(response.status)
        || !useApi && api && [403, 404, 408].includes(response.status);
      if (response.ok || !retry || attempt === attempts - 1) return response;
      await response.body?.cancel();
      failure = Error('Temporary release HTTP ' + response.status);
    } catch (error) {
      failure = error;
      if (attempt === attempts - 1) throw error;
    }
    if (api) useApi = true;
    await pause(Math.min(1000 * 2 ** attempt, 8000));
  }
  throw failure;
}
