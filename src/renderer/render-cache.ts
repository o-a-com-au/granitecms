// A fresh instance per bootSite() call (see boot.ts), not a module-level
// singleton - this codebase already deliberately rejected a mutable
// singleton once, for the Liquid engine itself (docs/phase-2-checklist.md's
// Group K notes: it would reintroduce global mutable state and a real
// test-isolation hazard across repeated bootSite() calls in the same
// process, exactly what the many buildServer()+.inject() tests do).
// Threaded through server.ts/public.ts the same way themeTemplates/engine
// already are.
//
// Validated against real filesystem state at read time (see public.ts's
// own use of this), not invalidated by hooking every write path - a
// write is always a real file write, so mtime always changes as a side
// effect, with zero new code needed at publish/unpublish/delete/move/
// menu-save call sites, current or future.
export interface RenderCacheEntry {
  html: string;
  pageMtimeMs: number;
  menusMtimeMs: number;
}

export interface RenderCache {
  get(renderPath: string): RenderCacheEntry | undefined;
  set(renderPath: string, entry: RenderCacheEntry): void;
}

export function createRenderCache(): RenderCache {
  const map = new Map<string, RenderCacheEntry>();
  return {
    get(renderPath) {
      return map.get(renderPath);
    },
    set(renderPath, entry) {
      map.set(renderPath, entry);
    },
  };
}
