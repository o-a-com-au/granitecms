# Phase 2 acceptance checklist - site agent API and first packaged release

Rules for using this file (same as Phase 1):

- An item is done only when its proving test exists, passes, and is named in the "Proof" column. "It works when I run it" is not proof.
- Work top to bottom within a group; groups are ordered by dependency.
- When all items in a group are proven, commit with message `phase2: <group> complete`.
- Do not edit the criteria to match the implementation. If a criterion is wrong, raise it with the lead first.
- Each group gets its own working session: research any new dependency/API empirically before designing (as Phase 1 did for LiquidJS and `node:sqlite`), a plan-mode design review for anything with a real architectural decision, then implement in small commits.

## Open questions carried in from scoping (resolve at the named session, not before)

1. Is `GET /v1/capabilities` exempt from auth, or does it need any valid token? (Group A/B)
2. Does `DELETE /v1/content/:path` support deleting a page with children (subtree delete), or reject it outright? The build plan's phrasing is singular-page; it doesn't say. (Group F)
3. Draft-checkpoint commit identity (Group H) — the same shape of question `src/boot.ts` already declined to answer for boot-time migrations (`src/services/migration-runner.ts`): what identity should an unattended, no-human-editor git commit use? Reintroducing a host-git-config fallback would walk back the Phase 1 H3 sign-off that commits never depend on host config. Decide whether boot-migration and checkpoint share one system identity or get separate ones.
4. Media (Group I): route-stub-only is the recommended default, not a locked decision — confirm or revise at that session.
5. CORS: implied by Phase 3's admin-iframe/postMessage description but never mentioned anywhere in the build plan. Needs a decision in Group A or B, flagged now so it isn't missed later.

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
| B1 | A request with no token is rejected with 401 on every route that requires one | |
| B2 | A request with a token lacking the scope a route requires is rejected with 403 | |
| B3 | A request with a valid, correctly-scoped token succeeds | |
| B4 | Every route registered under `src/routes/` either declares a required scope or sits on a reasoned exemption allowlist (grep-based structural test, mirroring Phase 1's B7) | |
| B5 | A content-scoped token cannot write theme files; the theme scope is required and distinct from the content scope | |

## Group C: public page serving, redirects, and preview

| # | Criterion | Proof |
|---|---|---|
| C1 | A `GET` request for a published page's URL serves the rendered live HTML | |
| C2 | A `GET` request for an unpublished or nonexistent page's URL returns 404 | |
| C3 | A `GET` request for a URL with a `redirects.json` entry and no live page returns a 301 to the redirect target | |
| C4 | A live page always wins over a redirect recorded at the same URL, at the HTTP layer (extends Phase 1's E6 renderer-level proof) | |
| C5 | An authenticated preview route renders the draft version of a page when a draft exists, and falls back to live when it does not (extends Phase 1's D6) | |
| C6 | A path containing traversal sequences against any public or preview route fails safely (400 or 404), never a 500 with a stack trace or file contents | |

## Group D: content and draft reads, with ETag

| # | Criterion | Proof |
|---|---|---|
| D1 | `GET /v1/content/:path` returns the live file's content and an `ETag` header | |
| D2 | `GET /v1/drafts/:path` returns the draft file's content and an `ETag` header | |
| D3 | `GET /v1/content` lists content, filterable by type, path prefix, and draft status | |
| D4 | The `ETag` for a given file is stable across repeated reads when the file hasn't changed, and changes when the file's content changes | |

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
