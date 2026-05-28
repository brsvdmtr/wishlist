// Chunk-load retry wrapper for `next/dynamic` importers.
//
// Webpack's `import()` can fail with ChunkLoadError on transient
// network / CDN-edge issues — a brief CF cache miss, mobile network
// blip, or an in-flight deploy whose chunk hash just rolled. Without a
// retry, the failure bubbles up to MiniAppErrorBoundary which renders
// the manual "Reload" prompt and the user perceives the surface as
// frozen (see GlitchTip WISHLIST-WEB-2, 2026-05-28: Wish_Support hit
// chunk 7679 on Settings → AppearanceSettings, retry-on-tap recovered).
//
// Pattern: retry the import once after a 500ms backoff. If the second
// attempt also fails, propagate so the boundary catches it and the
// user gets the manual reload UI (today's behavior). One retry is
// enough for the vast majority of transient cases; a second retry has
// diminishing returns and risks masking a genuine missing chunk.
//
// Why retry inside the importer instead of inside the boundary: by
// the time the boundary sees the error, the lazy component's Suspense
// has already unmounted. Retrying at the importer keeps the loader
// skeleton on screen, so the user sees "still loading" rather than
// "broke, then recovered".

const CHUNK_ERROR_PATTERN = /Loading chunk \w+ failed|ChunkLoadError/i;

function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string })?.name;
  if (name === 'ChunkLoadError') return true;
  return CHUNK_ERROR_PATTERN.test(String((err as Error)?.message ?? err));
}

/**
 * Wrap a `next/dynamic` importer so that a ChunkLoadError on the
 * first attempt triggers a 500ms-delayed retry. Non-chunk errors
 * propagate immediately — we don't want to mask real bugs.
 */
export function withChunkRetry<T>(importer: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await importer();
    } catch (err) {
      if (!isChunkLoadError(err)) throw err;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      return await importer();
    }
  };
}
