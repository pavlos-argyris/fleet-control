// Shared by the publisher and Worker, so a growing static bundle fails in CI.
export const MAX_WEB_RELEASE_FILES = 512;
export const MAX_RELEASE_MANIFEST_BYTES = 128 * 1024;
export function releaseCapacityError(manifest) {
  if (!Array.isArray(manifest?.web?.files) || manifest.web.files.length < 1 || manifest.web.files.length > MAX_WEB_RELEASE_FILES) return `Web release must contain 1–${MAX_WEB_RELEASE_FILES} files.`;
  if (new TextEncoder().encode(JSON.stringify(manifest)).length > MAX_RELEASE_MANIFEST_BYTES) return 'Release manifest exceeds 128 KiB.';
  return '';
}
