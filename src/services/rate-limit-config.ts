// Shared rate-limit config markers for route options objects
// (Fastify's config: { rateLimit: {...} } opt-in shape, consumed by
// @fastify/rate-limit registered with global: false in server.ts).
// One constant per tier, not ad-hoc literals at each of the ~10 call
// sites, both for DRYness and so the structural test
// (test/static/static-analysis.test.ts) has something unambiguous to
// grep for.

// An empty per-route override: @fastify/rate-limit (registered with
// global: false in server.ts) still requires each route to opt in via
// this marker, but an empty {} inherits the plugin's own registration-
// level max/timeWindow - which server.ts sets from serverConfig.rateLimit
// (site.config.json-configurable, defaulting to 60/min - see
// server-config.ts). Verified empirically before relying on it: a
// route's own config.rateLimit only needs *something* present to opt
// in, not a duplicated copy of the numbers.
export const WRITE_ROUTE_RATE_LIMIT = { rateLimit: {} };

// Generous defense-in-depth against basic scanning/abuse of the
// endpoints reachable with zero credentials (GET /v1/capabilities,
// GET /v1/search), not a meaningful throttle on legitimate use - a
// real front-end calling search on every keystroke of a live search
// box should never realistically hit this.
export const NO_AUTH_ROUTE_RATE_LIMIT = { rateLimit: { max: 300, timeWindow: 60000 } };
