# Phase 2 acceptance checklist - site agent API and first packaged release

Rules for using this file (same as Phase 1):

- An item is done only when its proving test exists, passes, and is named in the "Proof" column. "It works when I run it" is not proof.
- Work top to bottom within a group; groups are ordered by dependency.
- When all items in a group are proven, commit with message `phase2: <group> complete`.
- Do not edit the criteria to match the implementation. If a criterion is wrong, raise it with the lead first.
- Each group gets its own working session: research any new dependency/API empirically before designing (as Phase 1 did for LiquidJS and `node:sqlite`), a plan-mode design review for anything with a real architectural decision, then implement in small commits.

## Open questions carried in from scoping (resolve at the named session, not before)

1. ~~Is `GET /v1/capabilities` exempt from auth, or does it need any valid token?~~ **Resolved in Group B: exempt, no token required.** It's the one route a client needs before it necessarily has a working token configured, and it leaks a version/feature banner, not content — comparable in kind to an HTTP `Server` header. Noted for later: once Group H's rate limiting lands, this is the natural first thing to rate-limit, being reachable with zero credentials.
2. Does `DELETE /v1/content/:path` support deleting a page with children (subtree delete), or reject it outright? The build plan's phrasing is singular-page; it doesn't say. (Group F)
3. Draft-checkpoint commit identity (Group H) — the same shape of question `src/boot.ts` already declined to answer for boot-time migrations (`src/services/migration-runner.ts`): what identity should an unattended, no-human-editor git commit use? Reintroducing a host-git-config fallback would walk back the Phase 1 H3 sign-off that commits never depend on host config. Decide whether boot-migration and checkpoint share one system identity or get separate ones.
4. Media (Group I): route-stub-only is the recommended default, not a locked decision — confirm or revise at that session.
5. ~~CORS: implied by Phase 3's admin-iframe/postMessage description but never mentioned anywhere in the build plan.~~ **Resolved in Group B: not implemented, deferred to Phase 3.** Firmer reason than "no admin app yet": this API's auth is a bearer token in an `Authorization` header, never a cookie — the primary reason CORS matters for security (protecting cookie-authenticated endpoints from cross-site request forgery via ambient credentials) doesn't apply here. A cross-origin page cannot attach an `Authorization` header without triggering a CORS preflight the server would have to opt into, so there's no ambient-credential attack surface being left open by omission — this is a pure browser-JS-enablement question, not a security gap, and belongs to Phase 3 once the admin's registered-sites/origins model exists to define an allowlist against.

## Group A: Fastify bootstrap and capabilities

| # | Criterion | Proof |
|---|---|---|
| A1 | The server boots by calling `bootSite` and starts a Fastify instance listening on a configured port | `test/server.test.ts :: A1: the server boots by calling bootSite and starts a Fastify instance listening on a configured port` — a real socket (ephemeral port, real `fetch()`), not just `.inject()`, which deliberately bypasses the network stack and can't prove a real listener |
| A2 | Every route is registered under a `/v1/` prefix | `test/server.test.ts :: A2: every route is registered under a /v1 prefix` |
| A3 | `GET /v1/capabilities` returns the agent package version, the content schema version, and the active SQLite driver name | `test/server.test.ts :: A3: GET /v1/capabilities returns the agent package version, the content schema version, and the active SQLite driver` — asserted against the real sources of truth (`package.json`, `CURRENT_SCHEMA_VERSION`, `DRIVER_NAME`), never hardcoded expected strings |
| A4 | Requesting an unregistered route returns 404 with a structured JSON error body | `test/server.test.ts :: A4: requesting an unregistered route returns 404 with a structured JSON error body` |
| A5 | An uncaught error thrown inside a route handler returns 500 with a structured JSON error body, never a raw stack trace to the client, and never crashes the process | `test/server.test.ts :: A5: an uncaught error thrown inside a route handler returns 500 with a structured JSON error body, never a raw stack trace` (also `:: a route error below 500 ... is passed through with its real message, not sanitised`, proving the error handler's status-code check doesn't mangle future validation errors). Scope note: this covers errors thrown inside a route handler only — an unhandled rejection from work outside Fastify's request cycle (e.g. Group H's background checkpoint job) is not covered by this proof and needs its own, when that group lands. CORS remains deferred to Group B (see open question 5 above) — no admin app or token/origin model exists yet to configure it against. |

## Group B: token auth with scopes

| # | Criterion | Proof |
|---|---|---|
| B1 | A request with no token is rejected with 401 on every route that requires one | `test/routes/auth.test.ts :: B1: a request with no token is rejected with 401 on every route that requires one` — synthetic route (`capabilities.ts` is the only real route at this point in the build, and it's exempt) |
| B2 | A request with a token lacking the scope a route requires is rejected with 403 | `test/routes/auth.test.ts :: B2: a request with a token lacking the scope a route requires is rejected with 403` — synthetic route |
| B3 | A request with a valid, correctly-scoped token succeeds | `test/routes/auth.test.ts :: B3: a request with a valid, correctly-scoped token succeeds` — synthetic route |
| B4 | Every route registered under `src/routes/` either declares a required scope or sits on a reasoned exemption allowlist (grep-based structural test, mirroring Phase 1's B7) | `test/static/static-analysis.test.ts :: B4: every route registered under src/routes/ either declares a required scope or sits on a reasoned exemption allowlist`, plus its own positive-control test (`B4 mechanism check`) proving the grep can actually catch a violation, since no real violating file exists yet to prove it against organically. Verified live against a real scratch violation before committing. |
| B5 | A content-scoped token cannot write theme files; the theme scope is required and distinct from the content scope | `test/routes/auth.test.ts :: B5 (synthetic proof - no theme-writing route exists anywhere in Phase 2 scope, see docs/phase-2-checklist.md): ...` — **scope note, not silently absorbed**: checked the full Phase 2 checklist (Groups C-J) and the build plan's API contract; no theme-writing route is defined anywhere in Phase 2, not merely "not yet built." This synthetic proof (a test-only theme-gated route) is very likely the only proof this criterion ever gets within Phase 2 — raised to the lead rather than assumed acceptable. |

## Group C: public page serving, redirects, and preview

| # | Criterion | Proof |
|---|---|---|
| C1 | A `GET` request for a published page's URL serves the rendered live HTML | `test/routes/public.test.ts :: C1: a request for a published page URL serves the rendered live HTML`, plus `:: C1: a nested child page URL serves the rendered live HTML` |
| C2 | A `GET` request for an unpublished or nonexistent page's URL returns 404 | `test/routes/public.test.ts :: C2: a request for an unpublished page URL returns 404`, plus `:: C2: a request for a nonexistent page URL returns 404` |
| C3 | A `GET` request for a URL with a `redirects.json` entry and no live page returns a 301 to the redirect target | `test/routes/public.test.ts :: C3: a URL with a redirects.json entry and no live page returns a 301 to the target` |
| C4 | A live page always wins over a redirect recorded at the same URL, at the HTTP layer (extends Phase 1's E6 renderer-level proof) | `test/routes/public.test.ts :: C4: a live page always wins over a redirect recorded at the same URL, at the HTTP layer` |
| C5 | An authenticated preview route renders the draft version of a page when a draft exists, and falls back to live when it does not (extends Phase 1's D6) | `test/routes/preview.test.ts :: C5: previewing a page that only exists as a draft renders the draft`, `:: C5: previewing a page with a draft overlays the draft over the live version`, `:: C5: previewing a page with no draft falls back to the live version`, plus `:: a preview request with no token is rejected with 401` (scope: `content`, the same scope a token already needs to read draft JSON directly — no new scope introduced, see design note below) |
| C6 | A path containing traversal sequences against any public or preview route fails safely (400 or 404), never a 500 with a stack trace or file contents | `test/routes/public.test.ts :: C6: a path traversal attempt against the public route fails safely, never a 500 or leaked content` and `test/routes/preview.test.ts :: C6: a path traversal attempt against the preview route fails safely, never a 500 or leaked content` — both observed 404 in practice (verified empirically against several encoded-traversal shapes, not assumed) |

Design notes worth recording, not just the proof pointers above:

- **A real double-prefix bug, caught by these tests, not by inspection**: Fastify passes the *entire* options object a plugin was registered with — including `prefix` — through as that plugin's own second argument. The first draft of `src/routes/index.ts` passed that `opts` object straight through to `fastify.register(previewRoutes, opts)`, which silently carried `prefix: '/v1'` along with it and double-applied it (`previewRoutes` ended up registered at `/v1/v1/preview/*`, confirmed via `app.printRoutes()` and direct `app.inject()` probing before the fix). Fixed by re-packing only the site-data fields (`config`, `themeTemplates`, `tokens`) for the nested `register()` call, never forwarding `opts` itself. Left as a commented warning in `src/routes/index.ts` for the next route group that needs the same plumbing.
- **A second gotcha, verified empirically before it could bite**: the public route's `GET '/*'` catch-all, registered without a `/v1` prefix alongside `v1Routes`, would otherwise swallow *unmatched* `/v1/*` requests (e.g. a typo'd or future-removed API path) and serve them as page lookups instead of Fastify's real 404 — breaking Group A's A4. Fixed with an explicit guard in `src/routes/public.ts` (`if (request.url.startsWith('/v1/') || request.url === '/v1') return reply.callNotFound();`), proven by `test/routes/public.test.ts :: an unmatched /v1/* path is never swallowed by the public catch-all as a page lookup`.
- **`resolveUrl`/`renderPage` seam**: `resolveUrl`'s `relativePath` is relative to `config.pagesRoot`, but `renderPage`'s is relative to `config.contentRoot`/`draftsRoot` directly — the two already-correct, already-tested Phase 1 modules use two different conventions for the same string. Both `public.ts` and `preview.ts` join `'pages'` onto the path before calling `renderPage`, commented at the point of use so it doesn't read as an arbitrary literal.

## Group D: content and draft reads, with ETag

| # | Criterion | Proof |
|---|---|---|
| D1 | `GET /v1/content/:path` returns the live file's content and an `ETag` header | `test/routes/content.test.ts :: D1: GET /v1/content/:path returns the live file content and an ETag header`, plus `:: D1: GET /v1/content/:path returns 404 for a missing file`, `:: a path traversal attempt against GET /v1/content/:path fails safely, never a 500`, `:: GET /v1/content/:path with no token is rejected with 401` |
| D2 | `GET /v1/drafts/:path` returns the draft file's content and an `ETag` header | `test/routes/drafts.test.ts :: D2: GET /v1/drafts/:path returns the draft file content and an ETag header`, plus its own 404/traversal/401 tests, mirroring D1's shape |
| D3 | `GET /v1/content` lists content, filterable by type, path prefix, and draft status | `test/routes/content.test.ts :: D3: GET /v1/content lists content, including a draft-only page` and `:: D3: GET /v1/content filters by type, prefix, and draftStatus`; underlying filter/union/conflict logic unit-tested directly in `test/services/content-read.test.ts` (including a real unmigrated, `type`-less fixture shape, proving the listing doesn't crash on content `boot.ts` never auto-migrates) |
| D4 | The `ETag` for a given file is stable across repeated reads when the file hasn't changed, and changes when the file's content changes | `test/routes/content.test.ts :: D4: the ETag is stable across repeated reads when the file has not changed` and `:: D4: the ETag changes when the file content changes`; the underlying hash primitive itself unit-tested in `test/services/etag.test.ts` |

Design notes:

- **A schema decision raised to the user rather than invented**: the build plan names a `type` filter for `GET /v1/content` with no backing field anywhere in the page schema. Raised as an explicit question; the user chose to add a real `type` field now via a proper migration (`src/schemas/page.schema.json`, `CURRENT_SCHEMA_VERSION` 2 → 3, `migrateV2ToV3` defaulting existing content to `type: "page"`) rather than omitting the filter or reinterpreting it. The blast radius (every caller of `validatePage`) was scoped by reading each one before writing any code.
- **A design-review claim that turned out to be wrong, caught by running the suite, not by inspection**: the plan review asserted `test/services/migration-runner.test.ts` was unaffected by the schema change because its tests use fully local, decoupled `MigrationMap`s. That's true for the migration *map*, but `runMigrationsJob` unconditionally validates migrated output against the real `page.schema.json` regardless of which map drives it — so its `page()` helper still needed the new required field. Recorded here as a reminder that "doesn't import the real chain" and "unaffected by a schema change" are not the same claim.
- **ETag algorithm**: a plain `sha256` content hash (`src/services/etag.ts`), not a git blob hash — `git.ts` only shells out for actual commits, never a per-request read, and no later group needs the ETag to coincide with a real git blob hash. One shared `computeEtag` function for both these reads and Group E's future `If-Match` comparison, never inlined separately.
- **`:path` convention**: `:path` for D1/D2 is relative to `config.contentRoot`/`config.draftsRoot` directly (e.g. `pages/about.json`), matching `renderPage`'s own convention — deliberately avoiding a second seam-translation point like the one Group C's `public.ts`/`preview.ts` needed against `resolveUrl`'s pagesRoot-relative convention.
- **D3's scope**: the listing is the union of `contentRoot` and `draftsRoot` paths, not live content alone — Group D's own heading is "content **and draft** reads," and there is no separate "list drafts" endpoint anywhere in the build plan, so this is the only place a draft-only page is discoverable at all.

## Group E: draft writes and discard, with If-Match/409

| # | Criterion | Proof |
|---|---|---|
| E1 | `PUT /v1/drafts/:path` without an `If-Match` header is rejected | |
| E2 | `PUT /v1/drafts/:path` with a stale `If-Match` returns 409 and writes nothing to disk | |
| E3 | `PUT /v1/drafts/:path` with a matching `If-Match` succeeds and writes the draft | |
| E4 | Creating a draft from a live page for the first time checks `If-Match` against the live file's ETag, not a nonexistent draft's | |
| E5 | `DELETE /v1/drafts/:path` discards the draft | |
| E6 | Two requests racing to `PUT` the same path with the same now-stale `If-Match` value: exactly one succeeds, the other gets 409 — not two successes (delay-injection test, mirroring Phase 1's C1) | |

## Group F: publish, unpublish, delete, move, batch

| # | Criterion | Proof |
|---|---|---|
| F1 | `POST /v1/publish` promotes one or more drafts atomically: all-or-nothing, one commit | |
| F2 | `POST /v1/unpublish/:path` sets `published: false` and commits | |
| F3 | `DELETE /v1/content/:path` deletes a live page, optionally recording a redirect to a supplied target, in one commit | |
| F4 | `POST /v1/content/move` moves or renames a page or subtree (wraps `movePage`) | |
| F5 | `POST /v1/batch` executes a heterogeneous set of operations (draft writes, deletes, moves, an optional publish) as a single queue job, all-or-nothing | |
| F6 | A batch job that fails partway through leaves no partial writes and creates no commit | |

## Group G: git read endpoints

| # | Criterion | Proof |
|---|---|---|
| G1 | `GET /v1/git/log` returns commit history, filterable by path, with author and message | |
| G2 | Draft checkpoint commits are flagged in the log output so a client can hide them by default | |
| G3 | `GET /v1/git/show/:ref/:path` returns a file's content as it existed at a given revision | |
| G4 | `POST /v1/git/revert` restores a path (or set of paths) to a given revision as a new commit; history is never rewritten | |
| G5 | `POST /v1/git/commit` commits current working-tree changes as an escape hatch | |

## Group H: search, rate limiting, checkpoint job

| # | Criterion | Proof |
|---|---|---|
| H1 | `POST /v1/search/rebuild` rebuilds the index and returns success | |
| H2 | A write endpoint receiving requests past its configured rate limit returns 429 | |
| H3 | Per-site IP allowlisting, when configured, rejects requests from non-allowlisted IPs; when not configured, it is a no-op | |
| H4 | A low-frequency background job commits `/drafts/` when drafts have changed, flagged as a checkpoint commit distinct from an editor-authored commit | |

## Group I: media (route surface only — scope explicitly open, see question 4 above)

| # | Criterion | Proof |
|---|---|---|
| I1 | `GET /v1/media` is present and returns a well-formed response (empty list acceptable if storage isn't wired up this phase) | |
| I2 | `POST /v1/media` is present and returns a clear "not implemented in this release" response if real storage isn't wired up, rather than a 404 or crash | |
| I3 | The capabilities manifest (`GET /v1/capabilities`) reports media support honestly, matching whatever I1/I2 actually do | |

## Group J: build pipeline and packaging

| # | Criterion | Proof |
|---|---|---|
| J1 | `npm run build` produces compiled `dist/` output, including a copy step for `src/schemas/*.schema.json` (a gap flagged and deferred back in Phase 1's bootstrap commit) | |
| J2 | The package's `files`/`exports` are structured for a `v0.x` publish to a private registry; TypeScript source is excluded from the published artifact | |
| J3 | A `create-site` scaffold template produces a working site directory: `content/`, `drafts/`, `themes/`, `site.config.json`, `package.json`, `server.js` | |
| J4 | On a clean machine (or an equivalent automated proof), `git clone` + `npm install` + `node server.js` boots a scaffolded site with no steps beyond that | |
| J5 | Phase 1's deferred H4 (page-reviewer subagent run against the fixture site) passes, now that a real HTTP layer exists | |

## Explicitly not in Phase 2 scope

`better-sqlite3` as an optional SQLite driver. The build plan's own condition for adding it ("if the `node:sqlite` review point warrants it") isn't met: Phase 1's empirical research found `node:sqlite` fully working on this environment, FTS5 included, no experimental flags needed. Revisit only if a real performance need appears. The one still-open caveat from that research — it ran against Node v26.5.0, not the project's documented `engines.node` floor (`>=22.6.0`) — is Group J's responsibility to resolve before an actual `v0.x` publish, not before then.
