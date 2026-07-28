# Phase 3 acceptance checklist - admin application

Rules for using this file (same as Phase 1 and 2):

- An item is done only when its proving test exists, passes, and is named in the "Proof" column. "It works when I run it" is not proof.
- Work top to bottom within a group; groups are ordered by dependency.
- When all items in a group are proven, commit with message `phase3: <group> complete`.
- Do not edit the criteria to match the implementation. If a criterion is wrong, raise it with the lead first.
- Each group gets its own working session: research any new dependency/API empirically before designing, a plan-mode design review for anything with a real architectural decision, then implement in small commits.

This is a first-pass draft, written before any admin code exists. Unlike Phase 1/2's checklists (refined session by session against a codebase that already existed one phase earlier), several criteria here will firm up - or change - once their own group's design session actually researches the chosen tooling. That is expected, not a sign the draft was wrong; each group should feel free to revise its own not-yet-started rows before implementing them, same as any other group would flag a wrong criterion to the lead.

The admin lives in its own repository (`app-granite-cms-admin`, sibling to this one, empty at the time of writing), per the build plan's constraint that the admin and the site are always two separate codebases with two separate deploy cycles. This checklist stays here, alongside the build plan it's derived from, matching where Phase 1 and 2's checklists already live.

## Open questions carried in from scoping (resolve at the named session, not before)

1. ~~Admin persistence mechanism~~ **Resolved in Group A: a JSON-file-backed `Store<T>` interface** (`packages/server/src/store/` in the admin repo). Not modelled on this repo's own SQLite driver-interface precedent - that exists because a second real implementation (`better-sqlite3`) already exists and the data (the search index) is disposable/rebuildable; neither is true of the admin's registry/account data, which is small-volume and authoritative. The interface's real job is testability (an in-memory fake for later groups' route tests), with "could swap to SQLite later" as a true but secondary bonus - so no grep-enforced single-implementation test was added, unlike this repo's B7/G5 precedent. Atomic writes (temp file + rename) and a promise-chain write-queue mutex are built in from day one, since this data is authoritative, not derived.
2. Admin login mechanism (Group B): username/password against the chosen persistence store, an OAuth provider, or a magic-link flow. The build plan only says "login for agency staff and/or clients," not how.
3. Session mechanism for the admin's own login (Group B): cookie-based session versus a bearer token held client-side. Distinct from the per-site API tokens the registry stores, which are already specified (Bearer, scoped, rotatable) - this question is about how a human logs into the admin app itself.
4. ~~Test tooling for the admin repo~~ **Resolved in Group A: a split, not a preference.** `node --experimental-strip-types --test` (matching this repo exactly) for the admin's backend, but Vitest + React Testing Library + jsdom for frontend component tests - forced, not chosen: `--experimental-strip-types` only erases type annotations, it does not transform JSX, so a `.tsx` file cannot run under bare `node:test` at all. Real end-to-end browser tests (mirroring this repo's `page-reviewer` precedent) remain undecided and deferred - no group has needed one yet.
5. Diff rendering for the history view (Group H): a real diff needs a real diffing library (line-level, at minimum) - which one, and how much of a merge-request-style UI it justifies, is a Group H research question, not decided here.

## Group A: admin app bootstrap

| # | Criterion | Proof |
|---|---|---|
| A1 | The admin app builds and boots as a standalone Vite/React project, with its own `package.json`, entirely separate from the agent repo | `app-granite-cms-admin` repo (sibling, not this one): `npm run build && npm start` then a real `fetch`/`curl` against the compiled single-process boot - verified live (`GET /`, `GET /api/health`), not just unit-tested |
| A2 | `npm run typecheck`, `npm run lint`, and a test runner are configured and pass on an empty/skeleton app, mirroring the agent repo's definition-of-done gate | `app-granite-cms-admin`: `packages/server/test/server.test.ts :: A2: GET /api/health returns ok`; `packages/web/test/App.test.tsx` (Vitest); root `npm run typecheck`/`lint`/`test` fan out across both workspace packages and all pass |
| A3 | A chosen persistence mechanism (open question 1) stores and retrieves at least a trivial record round-trip, with a justification recorded for why it was chosen over the alternative | `app-granite-cms-admin`: `packages/server/test/store/json-file-store.test.ts :: A3: a trivial record round-trips through save, list, find, and delete`, plus atomic-write and concurrent-write-queue tests in the same file; justification recorded as a comment in `packages/server/src/store/store.ts` |
| A4 | The app has no compiled-in knowledge of any specific site: every site interaction goes through a base URL and token read from the app's own persisted configuration, never a hardcoded value | `app-granite-cms-admin`: `packages/server/test/static/static-analysis.test.ts :: A4: no hardcoded http(s) URL literal exists in packages/server/src outside a reasoned allowlist`, plus its own mechanism-check positive control (mirroring this repo's B4/H2 precedent) - passes vacuously today since Group C hasn't added site-calling code yet, by design |

Design notes:

- **The admin gets its own lightweight Node backend (Fastify), not a pure browser SPA** - a real architectural gap in the original build plan, caught before any code was written: it only sketched frontend folders, but a shared, multi-user site registry holding real secrets (per-site API tokens) and real login sessions can't safely be browser-only storage. The backend proxies every site call, so a registered site's raw API token never has to reach the browser at all - confirmed directly with the user rather than assumed, given a genuine alternative (a third-party auth/BaaS provider) existed and was rejected as introducing an external vendor dependency for a tool whose whole pitch is "own your stack."
- **Two npm workspace packages (`packages/server`, `packages/web`), one repo** - a real split, not premature structure: Node/NodeNext and browser/bundler-resolution-with-JSX are genuinely different compilation targets with different dependency sets.
- **A real CVE caught before it shipped, not by inspection**: the first pass pinned `@fastify/static` at `^8.1.0` (matching what was available when the plan was drafted); `npm audit` immediately flagged four high-severity path-traversal/route-guard-bypass advisories against 8.x/9.x. Re-pinned to `^10.1.2` (confirmed via `npm view` to have no peer-dependency conflict with Fastify 5) before writing any code against it - path/traversal safety is treated with the same seriousness here as the agent repo's own `sanitisePath`.
- **`@vitejs/plugin-react`'s Babel variant, not the SWC variant** - the SWC variant ships a native Rust binary, the same "native module pain" this project already steered around by choosing `node:sqlite` over `better-sqlite3`.
- **The built web assets' default location is resolved from the server module's own location (`import.meta.dirname`), not `process.cwd()`** - deliberately the opposite convention from the agent's own "never resolve relative to the package location" rule (constraint 2 there), because the two situations aren't the same: locating a *fixed sibling build artifact* (`packages/web/dist`, always two directories under `packages/` from either source or compiled `packages/server/{src,dist}`) is a structural fact independent of deployment, unlike the agent's site *content*, which is genuinely external, per-deployment configuration. The admin's own data directory (site registry, accounts) stays `process.cwd()`/`ADMIN_DATA_DIR`-relative, since that genuinely is operator configuration - the two defaults are deliberately resolved differently, for different reasons, not an inconsistency.
- **A real port collision caught by actually running it, not by inspection**: the default dev port (originally 4000) turned out to already be bound by an unrelated pre-existing local process on the development machine. Moved to 4278 after verifying the dev-mode Vite-proxy-to-Fastify wiring end to end with real requests.
- **Stop-gate hooks are per-project and were ported, not inherited** - `app-granite-cms-admin` has its own `.claude/settings.json`/`.claude/hooks/`, adapted from this repo's (the staleness check's `find` glob changed from a flat `src test` to `packages/*/src packages/*/test` for the two-package workspace layout). Its own `CLAUDE.md` is adapted, not copied: keeps TypeScript strict mode, Australian English/no em-dashes, small commits, and the three-part definition of done, but drops everything specific to the site agent itself (content-is-JSON-files, site-root-from-config, `node:sqlite` mandate, no-Liquid-tags rule) and references this repo's build plan/checklist by relative sibling path rather than duplicating them - confirmed directly with the user that the two repos stay fully separate (no parent monorepo), after weighing that option's cost (this session's working directory would stop being "the real one," and it becomes easier to accidentally import across the admin/agent boundary instead of going through the HTTP API) against its benefit (shared docs/`.claude` without cross-repo bookkeeping).

## Group B: admin authentication

| # | Criterion | Proof |
|---|---|---|
| B1 | An unauthenticated visitor is redirected to a login screen for every route except login itself | |
| B2 | A correct login succeeds and establishes a session (mechanism per open question 3); an incorrect login is rejected with a clear error, no information leak about which field was wrong | |
| B3 | A logged-in session persists across a page reload; logging out ends it, and a subsequent request in that browser is treated as unauthenticated | |
| B4 | The authenticated user's identity is available to every later group that needs to pass it through as commit author (build plan: "the admin passes the authenticated editor's identity with each request") | |

## Group C: site registry

| # | Criterion | Proof |
|---|---|---|
| C1 | An operator can register a site by URL and API token; the registry stores it and lists it thereafter | |
| C2 | Registering a site calls `GET /v1/capabilities` and displays the agent package version, content schema version, and active SQLite driver against that entry | |
| C3 | A token can be rotated for a registered site without losing the site's other registry data | |
| C4 | A site can be removed from the registry; removal never touches the site itself (the registry is metadata only, holds no content) | |
| C5 | An unreachable site (network error) or an invalid/expired token (401 from capabilities or any later call) is surfaced clearly in the registry list, not a generic crash | |

## Group D: content browsing

| # | Criterion | Proof |
|---|---|---|
| D1 | Selecting a registered site lists its content via `GET /v1/content`, showing at minimum path, type, and draft/live status per entry | |
| D2 | The list is filterable by type and draft status, matching what the agent's `GET /v1/content` already supports server-side | |
| D3 | Selecting a content entry opens it in the editor (Group E), passing along whichever of live/draft actually exists for it | |

## Group E: sidebar editor, autosave, and conflict handling

| # | Criterion | Proof |
|---|---|---|
| E1 | Opening a page for editing reads its current content (draft if one exists, else live) and its `ETag`, via `GET /v1/drafts/:path` or `GET /v1/content/:path` | |
| E2 | Editing a field and pausing triggers an autosave (`PUT /v1/drafts/:path`) with the `If-Match` header set from the last-known `ETag`, without an explicit save action from the user | |
| E3 | A successful autosave updates the locally-held `ETag` to the response's new value, so the next autosave's `If-Match` is always current | |
| E4 | A `409` response (stale `If-Match`, another editor or tab saved first) surfaces a clear "this page changed since you opened it" state, per the build plan's own stated design, not a generic error toast | |
| E5 | From the conflict state, the user can reload to the latest version (discarding local unsaved changes) or view what changed, before choosing to proceed | |
| E6 | Two browser tabs editing the same page: the second to save gets the 409 path (E4/E5), the first's save is never silently lost | |

## Group F: live preview

| # | Criterion | Proof |
|---|---|---|
| F1 | The editor renders a live preview iframe pointed at the site's authenticated preview route for the page being edited | |
| F2 | An unsaved edit reaches the preview without a full page reload of the admin app, via `postMessage` (or an equivalent mechanism decided at this session) | |
| F3 | The preview reflects the real draft state a publish would produce - not a client-side approximation - by actually hitting the agent's preview route, matching the build plan's own "editors see exactly what publish will produce" requirement | |
| F4 | A page with no draft (viewing live content only) still previews correctly, falling back to live per the agent's own preview-route behaviour | |

## Group G: publish and discard controls

| # | Criterion | Proof |
|---|---|---|
| G1 | An explicit "publish" action prompts for (or auto-generates, per build plan wording) a commit message before calling `POST /v1/publish` | |
| G2 | A successful publish clears the local draft state in the editor and reflects the page as now-live | |
| G3 | An explicit "discard" action calls `DELETE /v1/drafts/:path` and returns the editor to the live version, with a confirmation step first (a destructive, irreversible-in-the-UI action) | |
| G4 | An "unpublish" action calls `POST /v1/unpublish/:path` and is reflected in the content list/editor as no longer live | |
| G5 | A publish or unpublish that fails (network error, validation rejection from the agent) leaves the draft state untouched in the UI, never showing a false success | |

## Group H: page history

| # | Criterion | Proof |
|---|---|---|
| H1 | A history view for a page lists its commits via `GET /v1/git/log`, scoped to that page's path | |
| H2 | Draft checkpoint commits (flagged `isCheckpoint` by the agent) are hidden by default, with an explicit toggle to reveal them | |
| H3 | Selecting two revisions (or a revision against current) shows a real diff, via `GET /v1/git/show/:ref/:path` against each side, using the tool chosen at open question 5 | |
| H4 | One-click revert calls `POST /v1/git/revert` and the page reflects the reverted content afterwards, as a new commit - history is never rewritten, matching the agent's own guarantee | |

## Group I: section and block editing

| # | Criterion | Proof |
|---|---|---|
| I1 | A page's sections render as an editable, reorderable list, matching the Shopify-customiser interaction model named in the build plan | |
| I2 | Adding a section presents only section types available in the site's active theme (read from the theme's schema data, not a hardcoded list) | |
| I3 | A section's settings form is generated from its JSON Schema (from the theme), matching field types (string, number, boolean, enum) to appropriate inputs | |
| I4 | A block can be added to, removed from, and reordered within a section that supports blocks; a section that does not support blocks shows no block controls | |
| I5 | An invalid settings value (rejected by the agent's schema validation on save) is surfaced against the specific field, not just a generic save failure | |
| I6 | Reordering sections/blocks and editing settings all flow through the same autosave/`ETag`/conflict path Group E already built - no second, parallel save mechanism | |
