import { Liquid } from 'liquidjs';

// Called exactly once, inside bootSite - never a setter invoked again
// mid-process. This is what keeps "every theme file read once at
// boot" a structural guarantee rather than a convention: a mutable
// singleton with a snippets setter would let a future caller silently
// reload snippets without a restart, exactly what this design exists
// to avoid.
//
// Nothing beyond these constructor options is ever configured: no
// registerTag, no registerFilter, no plugin() - ever (constraint: no
// dynamically registered Liquid tags or filters). fs and
// relativeReference are stock constructor options, not registered
// tags/filters - confirmed empirically that the built-in `render` tag
// resolves purely against the in-memory `snippets` map below, with no
// disk access at all, and that a snippet rendered this way is still
// bounded by renderLimit (see test/renderer/engine.test.ts, D8, and
// test/renderer/snippets.test.ts).
//
// outputEscape: 'escape' makes {{ value }} escape HTML by default (a
// stock constructor option, not a registered filter/tag), with an
// explicit `| raw` as the only opt-out - used for pre-rendered block
// HTML that was already safely rendered by an earlier parseAndRender
// call (see render-page.ts), and for content_for_layout in a layout
// template for the same reason.
//
// renderLimit: 50 (ms) is the only reliable defence against a runaway
// template: an external Promise.race/setTimeout wrapper cannot abort a
// synchronous-only render (LiquidJS's drive loop only yields to the
// event loop when it awaits an actual Promise), confirmed empirically.
// This bounds a single parseAndRender call, not a whole page: a page
// with many sections/blocks each individually finishing just under
// budget has no aggregate ceiling. A page-level wall-clock guard is a
// Phase 2 route-handler concern, once there is an actual request to
// bound - not solved here.
export function createEngine(snippets: Record<string, string>): Liquid {
  return new Liquid({
    outputEscape: 'escape',
    renderLimit: 50,
    relativeReference: false,
    fs: {
      exists: async (file: string) => file in snippets,
      existsSync: (file: string) => file in snippets,
      readFile: async (file: string) => snippets[file] as string,
      readFileSync: (file: string) => snippets[file] as string,
      resolve: (_root: string, file: string) => file,
    },
  });
}
