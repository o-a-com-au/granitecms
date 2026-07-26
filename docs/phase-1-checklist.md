# Phase 1 acceptance checklist - agent core

Rules for using this file:
- An item is done only when its proving test exists, passes, and is named in the "Proof" column. "It works when I run it" is not proof.
- Work top to bottom within a group; groups are ordered by dependency.
- When all items in a group are proven, commit with message `phase1: <group> complete`.
- Do not edit the criteria to match the implementation. If a criterion is wrong, raise it with the lead first.

## Group A: schemas and validation

| # | Criterion (must be testable as an assertion) | Proof (test file :: test name) |
|---|---|---|
| A1 | A page JSON with all required fields (including `schemaVersion` and `published`) validates successfully | `test/services/validation.page.test.ts :: A1: a page with all required fields (including schemaVersion and published) validates successfully` |
| A2 | A page JSON missing any required field fails validation with an error naming the field and path | `test/services/validation.page.test.ts :: A2: a page missing a required field fails validation with an error naming the field and path` |
| A3 | A section instance validates against its section type's schema.json from the theme | `test/services/validation.instance.test.ts :: A3: a section instance validates against its section type's schema.json from the theme` (and the block-type counterpart in the same file) |
| A4 | A section instance with a setting of the wrong type fails validation with a specific error | `test/services/validation.instance.test.ts :: A4: a section instance with a setting of the wrong type fails validation with a specific error` |
| A5 | A section instance referencing a section type that does not exist in the theme fails validation | `test/services/validation.instance.test.ts :: A5: a section instance referencing a section type that does not exist in the theme fails validation` |
| A6 | Validation errors are structured data (path, message, keyword), not just strings | `test/services/validation.page.test.ts :: A6: page validation errors are structured data (path, message, keyword), not just strings` and `test/services/validation.instance.test.ts :: A6: instance validation errors are structured data (path, message, keyword), not just strings` |
| A7 | An unknown/extra property on a page or section is rejected (additionalProperties false) | `test/services/validation.page.test.ts :: A7: an unknown/extra property on a page is rejected (additionalProperties false)` and `test/services/validation.instance.test.ts :: A7: an unknown/extra property on a section instance is rejected (additionalProperties false)` |

## Group B: site root and path safety

| # | Criterion | Proof |
|---|---|---|
| B1 | The agent boots against a site root passed in config; no path in the codebase resolves relative to the agent package location | `test/config.test.ts :: B1: the agent boots against a site root passed in config, not the agent package location` and `test/static/static-analysis.test.ts :: B1: no path in the codebase resolves relative to the agent package location, outside a reasoned allowlist` |
| B2 | Startup fails with a clear, specific error when: site root missing, not a git repo, git binary absent, Node version too old | `test/services/startup-checks.test.ts` :: the four `B2: startup fails with a clear, specific error when...` tests |
| B3 | A content path containing `..` is rejected before any fs call | `test/services/path-safety.test.ts :: B3: a content path containing ".." is rejected before any fs call` |
| B4 | A percent-encoded traversal (`%2e%2e%2f`) is rejected before any fs call | `test/services/path-safety.test.ts :: B4: a percent-encoded traversal (%2e%2e%2f) is rejected before any fs call` (and the encoded-slash-segment-boundary variant in the same file) |
| B5 | An absolute path passed as a content path is rejected | `test/services/path-safety.test.ts :: B5: an absolute path passed as a content path is rejected` (and the encoded-absolute variant in the same file) |
| B6 | A symlink inside the content tree pointing outside the site root is not followed | `test/services/path-safety.test.ts :: B6: a symlink inside the content tree pointing outside the site root is not followed` (and the symlinked-directory variant in the same file) |
| B7 | The sanitisation function is a single shared helper and every fs-touching code path imports it (verified by a grep-based test or lint rule, not by convention) | `test/static/static-analysis.test.ts :: B7: the sanitisation function is a single shared helper and every fs-touching code path imports it` (also enforced live by `no-restricted-imports`/`no-restricted-syntax` in `eslint.config.js`) |

## Group C: write queue, drafts, and publish

| # | Criterion | Proof |
|---|---|---|
| C1 | Two writes submitted concurrently to the queue are applied strictly one at a time (test with deliberate delay injection) | `test/services/write-queue.test.ts :: C1: two writes submitted concurrently to the queue are applied strictly one at a time` |
| C2 | Saving a draft writes to `/drafts/<path>` and creates no git commit | `test/services/drafts.test.ts :: C2: saving a draft writes to /drafts/<path> and creates no git commit` |
| C3 | Saving a draft that fails schema validation writes nothing to disk | `test/services/drafts.test.ts :: C3: saving a draft that fails schema validation writes nothing to disk` |
| C4 | Publishing promotes the draft over the live file, deletes the draft, and creates exactly one commit | `test/services/publish.test.ts :: C4: publishing promotes the draft over the live file, deletes the draft, and creates exactly one commit` |
| C5 | The publish commit's author is the identity supplied with the request, not a fixed agent identity | `test/services/publish.test.ts :: C5: the publish commit author is the identity supplied with the request, not a fixed agent identity` (also `test/services/git.test.ts`'s no-host-identity-required case) |
| C6 | Publishing multiple drafts in one call is atomic: if one fails validation, no files change and no commit is created | `test/services/publish.test.ts :: C6: publishing multiple drafts in one call is atomic: if one fails validation, no files change and no commit is created` |
| C7 | Discarding a draft deletes only the draft; the live file is byte-identical before and after | `test/services/drafts.test.ts :: C7: discarding a draft deletes only the draft; the live file is byte-identical before and after` |
| C8 | Unpublish sets `published: false`, commits, and the renderer then 404s the page | Mechanics: `test/services/publish.test.ts :: C8 (mechanics only, renderer 404 half proven in Group D): unpublish sets published:false and commits with the supplied author`. Renderer half (closed out in Group D): `test/renderer/render-page.test.ts :: D5/C8: public mode treats an unpublished live page (published: false) as not found, closing out the renderer half of unpublish`. No HTTP layer exists yet (Phase 2), so "404" specifically means `PageRenderError` with `reason: 'page-not-found'` in public mode; the literal HTTP status mapping is a Phase 2 route-handler concern. |
| C9 | A queue job that throws leaves the working tree clean (no partial writes, no staged-but-uncommitted state) | `test/services/write-queue.test.ts`'s queue-survives-a-throw case (ordering level) and `test/services/publish.test.ts :: C9: a write failure partway through a multi-file publish rolls back cleanly, no partial writes, no staged-but-uncommitted state` (fs/git level). The harder "rollback itself also fails" scenario is a documented residual risk (see `rollback()` in `src/services/publish.ts`), not test-proven — reaching for it would need Node's experimental module-mocking API for one edge case. |

## Group D: renderer

| # | Criterion | Proof |
|---|---|---|
| D1 | A page JSON plus theme renders to HTML with sections in declared order | `test/renderer/render-page.test.ts :: D1: a page JSON plus theme renders to HTML with sections in declared order` |
| D2 | Block settings render inside their parent section | `test/renderer/render-page.test.ts :: D2: block settings render inside their parent section` (and the blocks-within-blocks variant in the same file) |
| D3 | Text settings containing HTML are escaped in output by default | `test/renderer/render-page.test.ts :: D3: text settings containing HTML are escaped in output by default` |
| D4 | A template that loops forever is killed by the render timeout and returns an error, not a hung process | `test/renderer/render-page.test.ts :: D4: a template that loops forever is killed by the render timeout and returns an error, not a hung process` |
| D5 | Public mode renders `/content/` only; a page existing only as a draft is not publicly reachable | `test/renderer/render-page.test.ts :: D5: public mode renders /content/ only; a page existing only as a draft is not publicly reachable` and `:: D5/C8: public mode treats an unpublished live page (published: false) as not found...` |
| D6 | Preview mode renders the draft version when a draft exists, and falls back to live when it does not | `test/renderer/render-page.test.ts :: D6: preview mode renders the draft version when a draft exists` and `:: D6: preview mode falls back to live when no draft exists` |
| D7 | Rendering a page whose section type is missing from the theme produces a clear error identifying the section, not a crash | `test/renderer/render-page.test.ts :: D7: rendering a page whose section type is missing from the theme produces a clear error identifying the section, not a crash` (and the missing-block-type variant in the same file) |
| D8 | No Liquid tags or filters beyond the LiquidJS defaults are registered (asserted by inspecting the engine instance) | `test/renderer/engine.test.ts :: D8: no Liquid tags or filters beyond the LiquidJS defaults are registered (asserted by inspecting the engine instance)` |

## Group E: hierarchy, moves, and redirects

| # | Criterion | Proof |
|---|---|---|
| E1 | A page at `content/pages/about/team.json` resolves at URL `/about/team` | `test/services/urls.test.ts :: E1: a page at content/pages/about/team.json resolves at URL /about/team` |
| E2 | Moving a page moves the file, and requesting the old URL returns a 301 to the new URL | `test/services/move.test.ts :: E2: moving a page moves the file (old path gone, new path present), recorded as one commit` and `:: E2/critical fix: the move commit stages both the old path (deleted) and the new path (added), not just the new one`. No HTTP layer exists yet (Phase 2); "301" here means a redirect entry recorded old-URL-to-new-URL, the mechanism a future route handler maps to an actual 301. |
| E3 | Moving a subtree writes one redirect entry per affected page, and the move plus redirect append is one commit | `test/services/move.test.ts :: E3: moving a subtree moves every descendant, writes one redirect entry per affected page, and is one commit` |
| E4 | Redirect chains are collapsed at write time: after `/a` to `/b` then `/b` to `/c`, the stored entry maps `/a` directly to `/c` | `test/services/redirects.test.ts :: E4: redirect chains are collapsed at write time: after /a to /b then /b to /c, the stored entry maps /a directly to /c` |
| E5 | Creating a page at a path that has a redirect entry removes that entry in the same commit | Move half: `test/services/move.test.ts :: E5 (move half): moving a page onto a destination that already had a stale redirect removes that redirect in the same commit`. Publish half (the literal "creating a page" case): `test/services/publish.test.ts :: E5 (publish half, move half closed out in move.test.ts): creating a page at a path that has a redirect entry removes that entry in the same commit` |
| E6 | A redirect whose `from` matches a live page is never served; the page wins | `test/services/resolve-url.test.ts :: E6: a redirect whose from matches a live page is never served; the page wins` |

## Group F: migrations

| # | Criterion | Proof |
|---|---|---|
| F1 | The runner walks content and drafts, migrating any file below current schemaVersion, as a single commit | `test/services/migration-runner.test.ts :: F1: the runner walks content and drafts, migrating any file below current schemaVersion, as a single commit` (also `:: F1: when nothing is below current version...` and `:: F1: a migrated draft file, never before committed...`) |
| F2 | Migrations apply in order and each is a pure function (same input, same output, verified by running twice) | `test/services/migration-runner.test.ts :: F2: migrations apply in order for a multi-step chain` and `:: F2: a migration function does not mutate its input and produces the same output when run twice` (also the two `F2 (error path)` tests in the same file, and `test/migrations/index.test.ts`'s purity check on the real `migrateV1ToV2`) |
| F3 | A file already at current version is untouched (byte-identical) | `test/services/migration-runner.test.ts :: F3: a file already at current version is untouched (byte-identical)` |
| F4 | A failed migration aborts the whole run with a clean working tree | `test/services/migration-runner.test.ts :: F4: a failed migration aborts the whole run with a clean working tree` (compute-phase) and `:: F4 (write-phase): a real failure after files are written rolls back cleanly...` |

## Group G: search index

| # | Criterion | Proof |
|---|---|---|
| G1 | Rebuild from a clean checkout produces an index; a basic FTS query returns the expected page for a known term | `test/search/rebuild-index.test.ts :: G1: rebuild from a clean checkout produces an index; a basic FTS query returns the expected page for a known term`. Verified against Node v26.5.0 (this environment's only available version); the build plan's own open `[REVIEW]` item asking to confirm `node:sqlite`/FTS5 behaviour on the documented `engines.node` floor (>=22.6.0) / target LTS is not resolved by this session and should not be read as closed. |
| G2 | Deleting the index file and rebuilding produces equivalent query results (disposability proven) | `test/search/rebuild-index.test.ts :: G2: deleting the index file and rebuilding produces equivalent query results (disposability proven)` |
| G3 | Unpublished pages and drafts are absent from the index | `test/search/rebuild-index.test.ts :: G3: unpublished pages and drafts are absent from the index` |
| G4 | The index file is gitignored and a rebuild creates no git changes | `test/search/rebuild-index.test.ts :: G4: the index file is gitignored and a rebuild creates no git changes` (seeds its own representative `.gitignore`, since no site-scaffold-template exists yet — that's Phase 2 scope) |
| G5 | The SQLite driver is accessed only through the driver interface (grep test: no `node:sqlite` or `better-sqlite3` import outside `src/search/drivers/`) | `test/static/static-analysis.test.ts :: G5: the SQLite driver is accessed only through the driver interface (no node:sqlite or better-sqlite3 import outside src/search/drivers/)` |

## Group H: phase exit criteria

| # | Criterion | Proof |
|---|---|---|
| H1 | The full fixture site clones to a temp dir, and the agent boots against it and serves pages with no steps beyond config (portability drill, automated) | `test/portability.test.ts :: H1: the full fixture site clones to a temp dir, and the agent boots against it and serves pages with no steps beyond config (portability drill)`. Introduces `test/fixtures/site/` (the first full-scaffold fixture) and `src/boot.ts` (the composition root plan-reviewer's H3 audit flagged as missing). |
| H2 | All of the above green under `npm test` in a single run | Structural fact, verified directly: 101/101 passing in one `npm test` run as of this commit. No dedicated test (plan-reviewer's own assessment: "acceptable as-is" — this is a property of the test runner, not a named assertion). |
| H3 | plan-reviewer subagent has audited the phase and its findings are addressed or explicitly accepted by the lead (Scott) | Audit run against Groups A-G; verdict **pass**, zero constraint violations. One finding fixed directly (symlink-check TOCTOU, now documented in `path-safety.ts` as an accepted residual risk). Two remaining items **explicitly signed off by the lead (Scott, 2026-07-26)**: (1) `startup-checks.ts` deliberately drops the build plan's "usable identity config" startup prerequisite in favour of always-explicit `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars — accepted as a considered improvement superseding that line of the build plan, not to be re-litigated; (2) `redirects.json` stays machine-written plumbing with no schema/validation path for now — accepted as genuinely open, left for Phase 2 to decide. |
| H4 | page-reviewer subagent has run against the fixture site with a pass verdict | **Deliberately not run.** `page-reviewer`'s actual procedure starts the agent and makes real HTTP requests against it; no Fastify/HTTP layer exists yet (that's Phase 2). Running it now would mean either faking an HTTP shim (throwaway work) or a vacuous pass. Carried forward to Phase 2 rather than forced now — confirmed with the lead before proceeding this way. |
