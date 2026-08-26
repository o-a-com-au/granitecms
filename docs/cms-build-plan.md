# CMS build plan (v3)

## Purpose of this document

This is a build plan for a self-hosted, git-backed CMS, structured for Claude Code to work from directly. Third revision. v2 added the draft and publish model, optimistic concurrency, batch writes, git history as a feature, content schema versioning, and a tightened security posture. v3 restructures the project around a packaged distribution model: the site agent is a versioned, compiled npm package installed into a site, not source code living inside the site repo. A site repo contains only what belongs to the site. This makes the same built agent serve both agency-managed client sites and a future packaged product that third parties drop into their own Node environment, without forking anything. Sections marked **[REVIEW]** remain genuinely open.

## Project goal

Build a lightweight CMS with a Shopify-style sections and blocks content model, WordPress-style hierarchical pages, and JSON files as the sole source of truth, versioned in git. The system must work standalone before any AI features are added. A completely separate admin application talks to each site over an API, so the admin can be upgraded freely without requiring a change to a site. The site agent is distributable: compiled output only, installable by anyone with a supported Node environment.

## Non-negotiable constraints

1. Content is stored as JSON files on disk, git-tracked. No database is the source of truth for content.
2. A whole site's content, theme, and configuration must be portable by `git clone` alone, onto any server running the stack. **Known exceptions:** `/media/` is deliberately not git-tracked regardless of which storage driver is active (binary uploads committed forever is unbounded repo bloat with no diffing or expiry benefit) - for the default local-filesystem driver this means `git clone` alone does not restore uploaded media, and moving a site to a new server means separately copying `/media/` (rsync, tar, a backup tool) alongside the clone; for the config-driven object storage driver, media is repointed by bucket configuration instead, same as before. The agent itself is restored by `npm install` from the lockfile rather than being vendored in the repo. The repo plus a lockfile is portable; `/media/` and the npm registry are documented external-to-git dependencies.
3. The admin application and the site are two separate codebases with two separate deploy cycles. The only connection between them is a versioned HTTP API.
4. Search and any future AI enhancement live in a derived, disposable index that can be fully rebuilt by walking the content files. It is never a second source of truth.
5. AI features are out of scope for the first build. The system must work fully with a human editor only. AI is added later as just another writer that goes through the same validation path a human does.
6. Every content file carries a schema version field from day one, and the agent ships with a migration runner. Content format changes are handled by migrations, never by hand.
7. **New:** The agent never assumes it lives inside the site repo. It is a package that takes a site root path from configuration. Agent code and site data are strictly separate, from the first line of Phase 1.

## Distribution model

### The agent is a package

The server is developed in its own repository and published as a scoped npm package (working name `@o-a/cms-agent`). What ships is compiled JavaScript in `dist/` plus type declarations; TypeScript source never leaves the agent repo. A site depends on a semver-pinned version of the agent via its `package.json` and lockfile.

A site is therefore a thin scaffold, restructured during Phase 2 (Group N) to four top-level folders - everything a marketing manager touches lives under `content/`, everything a web designer touches lives under `theme/`, uploaded media lives under `media/`, and the site's own serving configuration lives under `vhost/` (a real vhost's own scope in hosting terms - Apache/nginx/CyberPanel - the per-site serving configuration, not a multi-tenancy concept). `media/` is its own top-level folder rather than nesting inside `content/` specifically so its git-ignored status is a single, unambiguous `.gitignore` line at the site root - not a partial exception carved out of a folder every other line in this document describes as always git-tracked:

```
my-site/
  /content/
    /drafts/          work in progress (nested inside content/, not a sibling of it)
    /pages/
    /menus/           direct-write, no draft state - see below
    redirects.json    direct-write, no draft state
  /theme/             section and block templates plus schemas
  /media/             uploaded assets, served at /media/... - gitignored, see constraint 2
  /vhost/
    site.config.json  config holds ports, tokens hash, media driver settings, preview settings
    package.json      depends on @o-a/cms-agent at a pinned version
    package-lock.json
    server.js         imports the agent, points it one directory up (the real site root), starts
```

"Drop into your own Node environment" is: clone or unzip the scaffold, `cd vhost`, `npm install`, `node server.js`. A `create-site` scaffolding command (a small companion package or a template repo) generates this structure with a starter theme.

Not every content type has a draft state. Pages and posts go through the full draft-then-publish workflow described below. Menus and redirects do not: both are edited directly with an immediate commit, the same low-ceremony model, because neither has a meaningful "preview before publish" step worth the overhead of a separate draft file.

### Prerequisites, checked at startup

The agent hard-checks its environment on boot and exits with a clear message if anything is missing, rather than failing mysteriously mid-operation:

- Node 22 LTS or later
- git 2.x available on PATH, and the site root is a git repository with a usable identity config
- Write access to the site root, and to `/media/` specifically for the default local-filesystem storage driver
- If the object storage driver is configured instead: reachable bucket credentials

git stays a shelled-out dependency on the real binary. isomorphic-git is explicitly rejected: it is slower and diverges from real git behaviour in ways that would undermine the history and revert features, which are first-class in this design.

### SQLite without native module pain

The search index uses SQLite through a thin driver interface owned by the agent, with two interchangeable implementations:

- `node:sqlite` (built into Node 22+, supports FTS5) as the default, because it removes the native-compilation dependency entirely and keeps the package pure JS
- better-sqlite3 as an optional performance driver, loaded only if present

The query layer is small and the index is disposable, so keeping the driver swappable costs almost nothing and buys full distribution freedom, including the option of a single-file esbuild bundle later. ~~Confirm `node:sqlite` FTS5 behaviour and performance are adequate~~ **Resolved in Phase 1: `node:sqlite` is the default.** Empirical research found it fully working, FTS5 included, no experimental flags needed (see `docs/phase-2-checklist.md`'s "Explicitly not in Phase 2 scope" note). `better-sqlite3` stays available as the optional driver behind the same interface, not the default.

### Versioning and updates

The agent package follows semver. The capabilities endpoint reports the agent package version and the content schema version, so the admin knows exactly what it is talking to. Updating a site is a dependency bump plus restart; migrations run automatically on boot when content is below the current schema version. This replaces v2's "git pull the source tree" fleet story with a normal dependency upgrade, which is the real fix for fleet drift.

### Source protection stance

Compiled TypeScript is readable JavaScript; minification obfuscates but does not secure. The commercial posture is licensing terms plus shipping only compiled output. Binary packaging (Node SEA, pkg, bytenode) is noted as possible but not planned: all are speed bumps rather than locks, and all make field debugging harder. This is a settled decision unless the commercial context changes.

The commercial context did change during Phase 2: a source-available, open-core commercialisation strategy was agreed (free self-hosted engine, paid hosted admin, paid enterprise features), captured in `docs/commercialisation-brochure.md`. This does not alter the packaging stance above, which concerns what ships inside the npm package, not whether the agent's source repository is publicly viewable. Whether the source repository itself is made public is a separate, still-open decision.

## Tech stack

- Runtime and language: Node.js 22+ with TypeScript, compiled to JS for distribution
- Web framework for the site agent: Fastify (plugin-based, JSON Schema validation built in)
- Templating for sections and blocks: LiquidJS (sandboxed, plain text, git-diffable, render timeouts enforced, no dynamically registered tags or filters ever)
- Search index: SQLite via a swappable driver interface, `node:sqlite` default, better-sqlite3 optional, FTS5, rebuilt from content files on demand. No vector planning now; because the index is disposable, adding sqlite-vec later is a rebuild, not a migration.
- Admin frontend: React with Vite, its own separate project and package.json
- Media storage: behind a driver interface (mirroring the SQLite driver pattern) - local filesystem (`/media/`, gitignored) is the default, config-driven S3-compatible object storage (Backblaze B2 or Cloudflare R2) is an optional alternative driver
- Media resizing: deferred past MVP - the default is a plain passthrough (original file served as-is, no image-processing dependency of any kind). A later transform driver (self-hosted imgproxy, or an in-process resizer) is a separately-scoped addition behind the same interface, not decided yet
- Version control: git binary on the host, one repo per site

## Draft and publish model

A first-class concept, not a bolt-on.

### Content states

Every page exists in one or both of two trees:

```
/content/           live content, what the renderer serves to the public
/drafts/            work in progress, mirrors the /content/ folder structure
```

A page with no draft is simply live. Editing a live page creates a draft copy in `/drafts/` at the same relative path. The live file is untouched until publish.

### Save versus publish

Two different operations with two different costs:

- **Save** writes the draft JSON to `/drafts/` on disk after schema validation. It does not touch `/content/` and does not create a git commit. Saves are cheap and frequent; the sidebar editor can autosave aggressively without polluting history.
- **Publish** promotes the draft: the draft file is validated again, copied over the live file in `/content/`, the draft is removed, and a single git commit is created with a meaningful message and the editing user as the git author. Publish is the only routine operation that writes history.

This solves the commit noise problem (commit-on-every-save would make history unreadable once the editor exists) and gives clients the draft, preview, publish workflow they expect.

### Draft durability

`/drafts/` is git-tracked so drafts survive a server move under constraint 2. Because saves do not commit, unpublished drafts on a lost server are only as durable as the last checkpoint. The write service runs a low-frequency background checkpoint (for example every 30 minutes when drafts have changed, and on graceful shutdown) committing `/drafts/` with a conventional `chore: draft checkpoint` message. Checkpoint commits are mechanical noise by design and are flagged so history views can hide them. ~~Checkpoint interval, and whether checkpoints belong on the main branch or a dedicated drafts branch~~ **Resolved in Phase 2 Group H:** main branch, not a dedicated drafts branch - Group G's `isCheckpoint` flag already lets history views hide the noise without needing branch isolation. Interval is a configurable `checkpointIntervalMs` in `site.config.json`, defaulting to 30 minutes.

### Unpublish and discard

- **Discard draft** deletes the draft file; the live page is unaffected.
- **Unpublish** sets `published: false` in the live page JSON and commits. The renderer skips unpublished pages, so taking a page offline is not the same as deleting it.

### Preview

The public renderer reads `/content/` only. An authenticated preview mode (token-gated route used by the admin's iframe) renders with `/drafts/` overlaid on `/content/`, so editors see exactly what publish will produce, using the site's real renderer.

## Codebases and repositories

Three repositories now, not two:

### Agent (the product, one repo, published as a package)

```
/agent/
  /src/
    /routes/          Fastify plugins, one file per concern (content, drafts, publish, media, search, git)
    /services/        content validation, git operations, index rebuilding, write queue, migration runner
    /renderer/        Liquid rendering only, no business logic; public mode and preview mode
    /search/          index builder, query layer, swappable SQLite driver interface
    /migrations/      ordered content schema migrations
  /dist/              compiled output, the only thing published
  package.json
```

### Site scaffold (per client, thin, content only)

As shown under Distribution model: content, drafts, theme, media, redirects, config, a lockfile, and a three-line entry point. The gitignored `/data/search-index.sqlite` lives here at runtime, rebuilt on demand, never committed - `/media/` is gitignored for a different reason (constraint 2), not because it's disposable the way the index is.

### Admin (control plane, one instance total)

```
/admin/
  /src/
    /editor/          sidebar editor UI, draft editing, live preview iframe, publish and discard controls
    /history/         page-level git history view, diff display, revert
    /registry/        connected sites, their URLs, scoped API tokens, agent versions from capabilities
    /auth/            login for agency staff and/or clients; identity passed through to sites for commit authorship
  package.json        entirely separate
```

## The site agent API contract

The site agent is the only thing a site exposes to the outside world. Deliberately generic so new admin features rarely require a site update. Versioned from day one (`/v1/...`).

### Content and drafts

- `GET /v1/content/:path` – read a live content file. Response includes an `ETag` (git blob hash or content hash).
- `GET /v1/drafts/:path` – read a draft file, same ETag behaviour.
- `PUT /v1/drafts/:path` – save a draft. Validated against the matching schema before touching disk. Requires `If-Match` with the ETag from the prior read; returns `409 Conflict` if stale. Creating a draft from a live page requires the live file's ETag, so two editors starting from different versions is caught immediately.
- `DELETE /v1/drafts/:path` – discard a draft.
- `POST /v1/publish` – body lists one or more draft paths plus a commit message. Validates, promotes draft to live, removes drafts, creates one commit, all or nothing. The authenticated user becomes the git author.
- `POST /v1/unpublish/:path` – flip the published flag and commit.
- `DELETE /v1/content/:path` – delete a live page (commits, and records a redirect if a target is supplied).
- `POST /v1/content/move` – move or rename a page or subtree; moves files, rewrites child paths, appends to `redirects.json`, commits as one unit.
- `GET /v1/content` – list content, optionally filtered by type, path prefix, or draft status.
- `GET/POST/PUT/DELETE /v1/redirects` – direct redirect management, resolved during Phase 2's Group M: `redirects.json` is schema-validated content (`{schemaVersion, entries: [{from, to, note?}]}`), targets restricted to internal paths, with no draft step of its own (every write commits immediately, same as the automatic redirect bookkeeping above already did). See `docs/phase-2-checklist.md` Group M for detail.

### Batch writes

- `POST /v1/batch` – accepts an array of operations (draft writes, deletes, moves) plus an optional publish instruction and commit message, executed as a single queue job, all or nothing. Each write op carries its own `If-Match`. This is the path for bulk edits (for example renaming a section setting across 40 pages) and is deliberately the same path AI writes will use in Phase 5, since those will almost always be multi-file.

### Git as a feature, not a safety net

- `GET /v1/git/log` – commit history, filterable by path, with author and message. Draft checkpoint commits are flagged so the admin can hide them by default.
- `GET /v1/git/show/:ref/:path` – read a file as it existed at a revision, for diffs and old versions.
- `POST /v1/git/revert` – restore a path (or set of paths) to a given revision as a new commit. No history rewriting, ever.
- `POST /v1/git/commit` – commit current working tree changes with a message. Retained as an escape hatch for out-of-band changes; routine operations never need it.

### Everything else

- `POST /v1/search/rebuild` – rebuild the SQLite index from content files. The index covers live content; draft search is an admin-side concern, out of MVP scope.
- `GET /v1/media`, `POST /v1/media`, `DELETE /v1/media/:path` – list, upload, and delete media. Uploads are content-addressed (named by a hash of their own bytes - no collisions, identical re-uploads dedupe for free). SVG uploads are rejected outright, not sanitised (an SVG served from a trusted origin is stored XSS; sanitisation is a possible later addition, not MVP). Upload size is capped at the HTTP/multipart layer itself (`@fastify/multipart`'s own `limits.fileSize`, which aborts the stream once exceeded rather than buffering an oversized body into memory first) - `413` on rejection, limit configurable per site in `site.config.json`. `DELETE` is permanent: `/media/` carries no git history the way `/content/` does, so there is no revert for a deleted or overwritten file - a broken image on a live page referencing it is an accepted consequence, not a bug to guard against with a trash/soft-delete layer.
- `GET /v1/capabilities` – returns agent package version, content schema version, active SQLite driver, the configured max media upload size, and a manifest of optional features, so the admin can hide or disable features a given site does not support, and can validate an upload client-side against the same limit the server will actually enforce.

Page duplication and template swaps need no dedicated endpoints; they are GET plus PUT (or a batch job) from the admin side.

## Concurrency and write safety

Two mechanisms, doing two different jobs:

1. **The write queue** serialises all disk and git mutations through a single in-process queue, one job at a time. In-memory only; it does not survive restart, which is safe because the API only reports success after the write (and commit, where applicable) has completed. An in-flight request during a crash simply fails and the admin retries.
2. **Optimistic concurrency** prevents lost updates between editors. ETags on every read, `If-Match` on every write, `409` on staleness. The queue alone cannot do this job, since it happily serialises two writes where the second silently clobbers the first. The admin UI is built around the 409 from the first version of the editor: on conflict it shows a "this page changed since you opened it" state with the option to reload or view the difference.

## Content schema versioning and migrations

Every content JSON file includes `"schemaVersion": N`. The agent ships a migration runner: an ordered list of pure functions transforming version N content to N+1, living in the agent package and versioned with it. On startup (or via an explicit command) the runner walks content and drafts, migrates anything below current, and commits the result as a single migration commit. Under the package model this is what makes agent upgrades safe: bump the dependency, restart, migrations bring the content along.

## Fleet management

The `/v1/` prefix plus the capabilities manifest handles admin-to-site compatibility. Fleet drift is handled by the package model: updating a site is a semver dependency bump plus restart, and the admin registry displays each site's agent version from capabilities so outdated sites are visible at a glance. ~~Whether the admin should eventually be able to trigger a site's self-update~~ **Resolved: deliberate operator action for Phase 3.** The registry displays each site's version from capabilities and stops there - no remote-triggered `npm update` plus restart, which would be a disproportionate amount of new blast-radius (orchestrating a remote dependency bump and process restart, handling a failure mid-update) for a single-tenant Phase 3 admin nobody has asked for yet. Revisit only if fleet size or client demand actually makes manual updates painful.

## Security posture

- **Path sanitisation is the number one concern.** Every `:path` parameter is resolved and confirmed to sit inside the content or drafts root before any filesystem operation. Path traversal on a filesystem-backed write API is the most likely serious vulnerability in this design, and doubly important once the site root is configurable.
- **Token scopes.** Tokens carry scopes, and theme writes are a separate scope from content writes. Theme files are effectively code: a token that can write Liquid templates can do far more damage than one that can only write schema-validated JSON. Client-facing tokens never get the theme scope. Tokens are rotatable per site from the admin registry.
- **Commit authorship.** The admin passes the authenticated editor's identity with each request; the agent sets it as git author on resulting commits.
- **Rate limiting** on all write endpoints.
- **IP allowlisting is optional, not the backbone.** Available per site for locked-down clients but not relied on. Primary controls are scoped tokens, path sanitisation, schema validation, and media upload validation.
- **Media validation.** SVG rejected outright (no sanitisation attempted in MVP), upload size capped at the multipart-stream layer rather than after buffering the full body, filenames content-addressed so an upload can never overwrite an unrelated file by name collision. Served directly (the MVP transform driver is a passthrough); revisit "served from a proxy rather than the site origin" once a real transform driver exists, since that framing was written assuming object storage plus imgproxy specifically and no longer describes the local-filesystem default.
- **Supply chain.** Because the agent is now a published package that third parties install, the agent repo gets lockfile auditing, provenance-enabled npm publishing, and a minimal dependency policy from day one.

## Phased build order

### Phase 1: agent core, no admin, no network

Built inside the agent repo from the start, against a local test site scaffold, honouring constraint 7 (site root from config, never assumed).

- Define the JSON schema for a page, a section instance, and a section/block definition, including `schemaVersion` and `published` fields from the first schema
- Build the content validation layer (JSON Schema, used by the draft save path, the publish path, and later by the AI path)
- Build the Liquid-based renderer reading content JSON and theme files from a configured site root, producing HTML, with render timeouts; public mode reads `/content/`, preview mode overlays `/drafts/`
- Build the write queue, the draft save path (no commit), and the publish path (promote plus single commit with author)
- Build the migration runner with a trivial identity migration to prove the mechanism
- Build the SQLite driver interface with the `node:sqlite` implementation, the index rebuilder, and a basic full-text query over live content
- Prove out hierarchical URLs resolving to nested page files, including move/rename with redirect recording
- Startup environment checks (Node version, git presence, site root validity)
- No UI required yet beyond manually editing JSON and seeing it render, to prove the core loop works

### Phase 2: site agent API and first packaged release

- Wrap Phase 1 in the Fastify site agent, implementing the full contract above including drafts, publish, batch, and the git read endpoints
- ETag and `If-Match` optimistic concurrency on all reads and writes, with `409` semantics
- API token auth with scopes (content, theme, media), one or more tokens per registered admin
- Commit author passthrough
- Capabilities endpoint reporting agent version, schema version, and SQLite driver
- Rate limiting; optional per-site IP allowlisting
- Draft checkpoint background commit job
- Build pipeline producing compiled `dist/` output; publish v0.x of the package to a private registry; create the site scaffold template and prove `npm install` plus `node server.js` on a clean machine
- better-sqlite3 as the optional driver, if the `node:sqlite` review point warrants it

### Phase 3: admin application

- Site registry (add a site, store its URL and scoped tokens, rotate tokens, display agent version from capabilities)
- Sidebar editor UI reading and writing drafts through the agent API, with autosave
- Conflict handling UI for 409 responses built into the editor from the start
- Explicit publish and discard controls; publish prompts for or generates a commit message
- Live preview via iframe and postMessage against the site's authenticated preview mode
- Page history view using the git log and show endpoints, with diff display and one-click revert; checkpoint commits hidden by default
- Section and block editing matching the Shopify customiser interaction model

### Phase 4: media

`/media/` is a fourth top-level site folder (sibling to `content/`, `theme/`, `vhost/` - not nested inside `content/`), gitignored regardless of which storage driver is active. See constraint 2 and the site scaffold diagram above for the full reasoning.

- **Storage driver interface** (mirroring the SQLite driver pattern - a thin interface, swappable implementations): local filesystem is the default and the only implementation built in this phase; config-driven S3-compatible object storage is a later, separately-scoped alternative driver, not built now
- **Upload naming**: content-addressed - the filename is derived from a hash of the file's own bytes. No collision handling needed (a hash collision on distinct content is not a real concern at this scale), and an identical re-upload naturally dedupes to the same file rather than creating a duplicate
- **Upload validation**: SVG rejected outright, not sanitised, for MVP - avoids taking on an XML/SVG sanitisation dependency before it's clear anyone needs SVG support. Size capped via `@fastify/multipart`'s own stream-level `limits.fileSize` (rejects mid-stream once exceeded, never buffers an oversized body fully into memory first, which would itself be a memory-exhaustion vector) - configurable per site in `site.config.json`, `413` on rejection. Pixel-dimension ("decompression bomb": a small file that decodes to enormous dimensions) limits are a known, explicitly deferred gap, not solved in this phase
- **Deletion**: `DELETE /v1/media/:path`, permanent, no soft-delete/trash. `/media/` has no git history behind it the way `/content/` does (that's the whole point of not git-tracking it), so a delete - or an overwrite, though content-addressed naming makes accidental overwrite unlikely - is genuinely unrecoverable. A broken image on a live page as a result is an accepted trade-off, not something this phase guards against
- **Serving and resizing**: behind a separate `ImageTransformDriver` interface (deliberately independent of the storage driver - storage and resizing are two different axes, not one bundled choice; local storage plus a self-hosted resizer, or object storage plus no resizing, are both valid combinations). MVP implementation is a plain passthrough: serves the original file as-is, no image-processing dependency of any kind, native or pure-JS. **The URL shape is decided now even though resizing isn't built yet**: Shopify-style query params, e.g. `image.jpg?width=1500` - the passthrough driver accepts and silently ignores these params, so nothing in stored content JSON needs migrating once real resizing exists. Dynamic resizing itself is deferred, not dropped: an imgproxy-backed (self-hosted, sitting in front of whichever storage driver is active - not a required cloud dependency) or in-process (`sharp` vs a pure-JS resizer is an open choice, revisit when this is actually built) driver is later, separately-scoped work behind the same interface. Building it also means revisiting response caching / a bound on permitted width values first - an unauthenticated route doing attacker-parameterised CPU work on every request with no cache is a real DoS surface, deferred along with the resizing work itself, not forgotten
- **No Liquid filter for image URLs, ever** (CLAUDE.md's ban on dynamically registered tags/filters) - matches Group K's existing asset-URL precedent. Resize params are baked into the URL stored in content JSON by the admin's media picker at pick-time, never computed at template-render time
- **Media picker in the admin UI.** Browse/upload/select, writing the picked file's URL into whichever `ImageField`-shaped setting is being edited (see `app-granite-cms-admin`'s own `format: "image"` field work - already stores `{ url, focalX, focalY }` and needs no shape change for this). Picker-grid thumbnails: ship the plain version first (lazy-loaded original images, browser-scaled) - a client-side, Canvas-API-generated companion thumbnail file per upload (zero new dependency, no per-request compute, scoped only to this picker's own browsing UX, not a substitute for the deferred transform driver) is a later addition if the plain version actually feels slow, not built speculatively now

### Phase 5: AI (explicitly deferred, not part of MVP)

- AI writes go through `POST /v1/batch` as drafts, subject to the same schema validation and `If-Match` rules as a human editor, and a human publishes
- AI is constrained to writing section and block *settings* against JSON Schema. AI-authored Liquid templates are a separate, much later problem, not part of Phase 5. Because AI never writes templates in Phase 5, LiquidJS as a sandbox boundary is not load-bearing yet and Phase 1's schema format needs no rework
- AI enrichment of the search index, kept as clearly derived data

## Remaining open questions **[REVIEW]**

All previously-listed items here are now resolved (see their inline `~~strikethrough~~` resolutions above: `node:sqlite` as default, checkpoint interval/branch, self-update, single-tenant Phase 3). One more resolved directly ahead of Phase 3 planning:

- ~~Whether the preview overlay should support previewing a *set* of drafts as a batch (a "release" concept) or per-page preview is enough~~ **Resolved: per-page only for Phase 3.** One page, one draft, one publish button - a coordinated multi-page launch is still possible by publishing pages one at a time in quick succession. No new agent-side work is implied either way: `POST /v1/publish` already accepts multiple draft paths in one commit, and preview already overlays every current draft regardless of which single page is being viewed. A "pending changes" batch-publish screen is a cheap, natural follow-up if real usage asks for it, not built speculatively now.

No open items remain blocking Phase 3. See `docs/phase-3-checklist.md` for the phase's own group breakdown and acceptance criteria.

Not blocking anything, parked for later: **multiple starter themes for `create-site`.** Idea is roughly 6 starter themes (built from the section/template work done in `granite-starter`), bundled inside the package under `src/create-site/themes/` and chosen via an interactive `create-site` prompt (or a `--theme` flag) - not a website zip download, since a raw download skips `npm install`/config wiring and goes stale against package updates. A theme gallery with visual previews on the marketing website is still worth doing, but the "use this" action from that gallery should hand the user the CLI command (with the theme flag filled in), the way Astro/Next.js template galleries work, not trigger a file download. Revisit once there are actually 6 themes worth choosing between.

## Definition of done for MVP

A single site scaffold, on a clean machine with only Node 22+ and git installed, can: be set up by `git clone` plus `npm install` plus `node server.js`; store pages and sections as JSON with schema versions; hold draft and live states for a page; render live content via Liquid into a working website; render a draft in preview mode; promote a draft to live with a single authored git commit; record a redirect when a page moves; run its migration runner on a clean checkout; have its search index rebuilt from scratch with no native compilation required; and be moved to a brand new server by nothing more than `git clone` plus `npm install` plus starting the process, with media handled per the active storage driver: repointed by configuration for object storage, or separately copied (rsync, tar, a backup tool - `git clone` alone does not carry it) for the default local-filesystem driver, since `/media/` is deliberately not git-tracked either way. Separately, the agent package itself builds to compiled output and installs into a fresh scaffold without access to its TypeScript source.
