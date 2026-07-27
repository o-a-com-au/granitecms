# CMS build plan (v3)

## Purpose of this document

This is a build plan for a self-hosted, git-backed CMS, structured for Claude Code to work from directly. Third revision. v2 added the draft and publish model, optimistic concurrency, batch writes, git history as a feature, content schema versioning, and a tightened security posture. v3 restructures the project around a packaged distribution model: the site agent is a versioned, compiled npm package installed into a site, not source code living inside the site repo. A site repo contains only what belongs to the site. This makes the same built agent serve both agency-managed client sites and a future packaged product that third parties drop into their own Node environment, without forking anything. Sections marked **[REVIEW]** remain genuinely open.

## Project goal

Build a lightweight CMS with a Shopify-style sections and blocks content model, WordPress-style hierarchical pages, and JSON files as the sole source of truth, versioned in git. The system must work standalone before any AI features are added. A completely separate admin application talks to each site over an API, so the admin can be upgraded freely without requiring a change to a site. The site agent is distributable: compiled output only, installable by anyone with a supported Node environment.

## Non-negotiable constraints

1. Content is stored as JSON files on disk, git-tracked. No database is the source of truth for content.
2. A whole site's content, theme, and configuration must be portable by `git clone` alone, onto any server running the stack. **Known exceptions:** media binaries live in S3-compatible object storage and are not in the repo (media references in content JSON are relative or config-driven so a cloned site can be repointed at a different bucket), and the agent itself is restored by `npm install` from the lockfile rather than being vendored in the repo. The repo plus a lockfile is portable; the bucket and the npm registry are documented external dependencies.
3. The admin application and the site are two separate codebases with two separate deploy cycles. The only connection between them is a versioned HTTP API.
4. Search and any future AI enhancement live in a derived, disposable index that can be fully rebuilt by walking the content files. It is never a second source of truth.
5. AI features are out of scope for the first build. The system must work fully with a human editor only. AI is added later as just another writer that goes through the same validation path a human does.
6. Every content file carries a schema version field from day one, and the agent ships with a migration runner. Content format changes are handled by migrations, never by hand.
7. **New:** The agent never assumes it lives inside the site repo. It is a package that takes a site root path from configuration. Agent code and site data are strictly separate, from the first line of Phase 1.

## Distribution model

### The agent is a package

The server is developed in its own repository and published as a scoped npm package (working name `@oa/cms-agent`). What ships is compiled JavaScript in `dist/` plus type declarations; TypeScript source never leaves the agent repo. A site depends on a semver-pinned version of the agent via its `package.json` and lockfile.

A site is therefore a thin scaffold:

```
my-site/
  /content/           live JSON content
  /drafts/            work in progress
  /theme/             section and block templates plus schemas
  redirects.json
  site.config.json    site root is implicit; config holds ports, tokens hash, media bucket, preview settings
  package.json        depends on @oa/cms-agent at a pinned version
  package-lock.json
  server.js           three lines: import the agent, point it at this directory, start
```

"Drop into your own Node environment" is: clone or unzip the scaffold, `npm install`, `node server.js`. A `create-site` scaffolding command (a small companion package or a template repo) generates this structure with a starter theme.

### Prerequisites, checked at startup

The agent hard-checks its environment on boot and exits with a clear message if anything is missing, rather than failing mysteriously mid-operation:

- Node 22 LTS or later
- git 2.x available on PATH, and the site root is a git repository with a usable identity config
- Write access to the site root
- If media is configured: reachable object storage credentials

git stays a shelled-out dependency on the real binary. isomorphic-git is explicitly rejected: it is slower and diverges from real git behaviour in ways that would undermine the history and revert features, which are first-class in this design.

### SQLite without native module pain

The search index uses SQLite through a thin driver interface owned by the agent, with two interchangeable implementations:

- `node:sqlite` (built into Node 22+, supports FTS5) as the default, because it removes the native-compilation dependency entirely and keeps the package pure JS
- better-sqlite3 as an optional performance driver, loaded only if present

The query layer is small and the index is disposable, so keeping the driver swappable costs almost nothing and buys full distribution freedom, including the option of a single-file esbuild bundle later. **[REVIEW]** Confirm `node:sqlite` FTS5 behaviour and performance are adequate on the target Node LTS before committing to it as the default; if not, better-sqlite3 becomes the default and the package documents the native install requirement, which npm's prebuilt binaries handle on common platforms anyway.

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
- Media storage: S3-compatible object storage (Backblaze B2 or Cloudflare R2)
- Media resizing: self-hosted imgproxy as its own service in front of the object storage; a documented external service, not part of the Node package
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

`/drafts/` is git-tracked so drafts survive a server move under constraint 2. Because saves do not commit, unpublished drafts on a lost server are only as durable as the last checkpoint. The write service runs a low-frequency background checkpoint (for example every 30 minutes when drafts have changed, and on graceful shutdown) committing `/drafts/` with a conventional `chore: draft checkpoint` message. Checkpoint commits are mechanical noise by design and are flagged so history views can hide them. **[REVIEW]** Checkpoint interval, and whether checkpoints belong on the main branch (simple, slightly noisy) or a dedicated drafts branch (cleaner history, more git machinery). Do not block Phase 1 on this.

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

As shown under Distribution model: content, drafts, theme, redirects, config, a lockfile, and a three-line entry point. The gitignored `/data/search-index.sqlite` lives here at runtime, rebuilt on demand, never committed.

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

### Batch writes

- `POST /v1/batch` – accepts an array of operations (draft writes, deletes, moves) plus an optional publish instruction and commit message, executed as a single queue job, all or nothing. Each write op carries its own `If-Match`. This is the path for bulk edits (for example renaming a section setting across 40 pages) and is deliberately the same path AI writes will use in Phase 5, since those will almost always be multi-file.

### Git as a feature, not a safety net

- `GET /v1/git/log` – commit history, filterable by path, with author and message. Draft checkpoint commits are flagged so the admin can hide them by default.
- `GET /v1/git/show/:ref/:path` – read a file as it existed at a revision, for diffs and old versions.
- `POST /v1/git/revert` – restore a path (or set of paths) to a given revision as a new commit. No history rewriting, ever.
- `POST /v1/git/commit` – commit current working tree changes with a message. Retained as an escape hatch for out-of-band changes; routine operations never need it.

### Everything else

- `POST /v1/search/rebuild` – rebuild the SQLite index from content files. The index covers live content; draft search is an admin-side concern, out of MVP scope.
- `GET /v1/media`, `POST /v1/media` – list and upload media. Uploads are validated by type; SVG uploads are sanitised or rejected because an SVG served from a trusted origin is stored XSS.
- `GET /v1/capabilities` – returns agent package version, content schema version, active SQLite driver, and a manifest of optional features, so the admin can hide or disable features a given site does not support.

Page duplication and template swaps need no dedicated endpoints; they are GET plus PUT (or a batch job) from the admin side.

## Concurrency and write safety

Two mechanisms, doing two different jobs:

1. **The write queue** serialises all disk and git mutations through a single in-process queue, one job at a time. In-memory only; it does not survive restart, which is safe because the API only reports success after the write (and commit, where applicable) has completed. An in-flight request during a crash simply fails and the admin retries.
2. **Optimistic concurrency** prevents lost updates between editors. ETags on every read, `If-Match` on every write, `409` on staleness. The queue alone cannot do this job, since it happily serialises two writes where the second silently clobbers the first. The admin UI is built around the 409 from the first version of the editor: on conflict it shows a "this page changed since you opened it" state with the option to reload or view the difference.

## Content schema versioning and migrations

Every content JSON file includes `"schemaVersion": N`. The agent ships a migration runner: an ordered list of pure functions transforming version N content to N+1, living in the agent package and versioned with it. On startup (or via an explicit command) the runner walks content and drafts, migrates anything below current, and commits the result as a single migration commit. Under the package model this is what makes agent upgrades safe: bump the dependency, restart, migrations bring the content along.

## Fleet management

The `/v1/` prefix plus the capabilities manifest handles admin-to-site compatibility. Fleet drift is handled by the package model: updating a site is a semver dependency bump plus restart, and the admin registry displays each site's agent version from capabilities so outdated sites are visible at a glance. **[REVIEW]** Whether the admin should eventually be able to trigger a site's self-update through the agent, or updates stay a deliberate operator action per site. Lean towards deliberate for client sites; automation can come later.

## Security posture

- **Path sanitisation is the number one concern.** Every `:path` parameter is resolved and confirmed to sit inside the content or drafts root before any filesystem operation. Path traversal on a filesystem-backed write API is the most likely serious vulnerability in this design, and doubly important once the site root is configurable.
- **Token scopes.** Tokens carry scopes, and theme writes are a separate scope from content writes. Theme files are effectively code: a token that can write Liquid templates can do far more damage than one that can only write schema-validated JSON. Client-facing tokens never get the theme scope. Tokens are rotatable per site from the admin registry.
- **Commit authorship.** The admin passes the authenticated editor's identity with each request; the agent sets it as git author on resulting commits.
- **Rate limiting** on all write endpoints.
- **IP allowlisting is optional, not the backbone.** Available per site for locked-down clients but not relied on. Primary controls are scoped tokens, path sanitisation, schema validation, and media upload validation.
- **Media validation.** Type allowlist on upload, SVG sanitisation or rejection, media served via imgproxy in front of object storage rather than from the site origin.
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

- Object storage integration with config-driven bucket and base URL per site
- Upload validation and SVG handling
- imgproxy documented and configured as an external service; not bundled
- Media picker in the admin UI

### Phase 5: AI (explicitly deferred, not part of MVP)

- AI writes go through `POST /v1/batch` as drafts, subject to the same schema validation and `If-Match` rules as a human editor, and a human publishes
- AI is constrained to writing section and block *settings* against JSON Schema. AI-authored Liquid templates are a separate, much later problem, not part of Phase 5. Because AI never writes templates in Phase 5, LiquidJS as a sandbox boundary is not load-bearing yet and Phase 1's schema format needs no rework
- AI enrichment of the search index, kept as clearly derived data

## Remaining open questions **[REVIEW]**

- `node:sqlite` FTS5 adequacy on Node 22 LTS versus defaulting to better-sqlite3 (Phase 1 spike, low risk either way given the driver interface)
- Draft checkpoint mechanics: interval, and main branch versus a dedicated drafts branch
- Whether `redirects.json` should be schema-validated content with its own editor surface, or stay machine-written plumbing
- Whether the preview overlay should support previewing a *set* of drafts as a batch (a "release" concept) or per-page preview is enough
- Whether the admin can trigger a site's agent self-update, or updates remain a deliberate per-site operator action
- Whether the Phase 3 admin is single-tenant (one deployment per hosting customer) or multi-tenant (one shared admin serving many paying customers, needing customer isolation and billing built in). The "one instance total" framing above assumed a single internal or agency-run deployment; the hosted-admin commercialisation strategy in `docs/commercialisation-brochure.md` needs this decided before Phase 3 starts, since it changes the registry and auth model rather than being a later add-on

## Definition of done for MVP

A single site scaffold, on a clean machine with only Node 22+ and git installed, can: be set up by `git clone` plus `npm install` plus `node server.js`; store pages and sections as JSON with schema versions; hold draft and live states for a page; render live content via Liquid into a working website; render a draft in preview mode; promote a draft to live with a single authored git commit; record a redirect when a page moves; run its migration runner on a clean checkout; have its search index rebuilt from scratch with no native compilation required; and be moved to a brand new server by nothing more than `git clone` plus `npm install` plus starting the process, with media repointed by configuration. Separately, the agent package itself builds to compiled output and installs into a fresh scaffold without access to its TypeScript source.
