import type { SiteConfig } from '../config.ts';
import { rebuildIndex, rebuildIndexIfMissing } from '../search/rebuild-index.ts';

// Search is a derived, disposable index (constraint 3) - previously
// nothing ever rebuilt it except a caller manually hitting
// POST /v1/search/rebuild, so GET /search.json stayed empty forever on
// a fresh site and stale forever after a real edit. This is the one
// place that closes that gap: called after a content-affecting write's
// own enqueue()d promise has already resolved.
//
// Deliberately fire-and-forget, never awaited by the caller: rebuildIndex
// is itself enqueue()d internally (search/rebuild-index.ts) - awaiting it
// from inside the very job whose own completion is what let this run
// would deadlock (routes/search.ts's own comment describes the same
// hazard for a second, nested enqueue() call). A failed reindex must
// also never surface as a failure of the write that triggered it - the
// write already succeeded, and the index is rebuildable from content at
// any time, so a logged-and-swallowed failure here is the correct
// severity, not a thrown error.
export function reindexInBackground(config: SiteConfig): void {
  void rebuildIndex(config).catch((error: unknown) => {
    console.error('Background search reindex failed:', error);
  });
}

// startServer's own boot-time call - see rebuildIndexIfMissing's own
// comment for why this is conditional (existsSync), unlike the
// unconditional reindexInBackground above.
export function reindexOnBootIfMissing(config: SiteConfig): void {
  void rebuildIndexIfMissing(config).catch((error: unknown) => {
    console.error('Background search reindex failed:', error);
  });
}
