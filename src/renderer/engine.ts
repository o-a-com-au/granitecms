import { Liquid } from 'liquidjs';

// The single shared Liquid engine instance. Nothing beyond these
// constructor options is ever configured: no registerTag, no
// registerFilter, no plugin() - ever (constraint: no dynamically
// registered Liquid tags or filters). Exported directly so it can be
// inspected by name (see test/renderer/engine.test.ts, D8).
//
// outputEscape: 'escape' makes {{ value }} escape HTML by default (a
// stock constructor option, not a registered filter/tag), with an
// explicit `| raw` as the only opt-out - used for pre-rendered block
// HTML that was already safely rendered by an earlier parseAndRender
// call (see render-page.ts).
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
export const engine = new Liquid({
  outputEscape: 'escape',
  renderLimit: 50,
});
