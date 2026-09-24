# Changelog

All notable changes to this package are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Nothing before `0.2.0` was tracked in this file - see git history for anything earlier.

## [Unreleased]

### Added

- **`npm run stop` stops a site from any terminal**, not only the one it was started in (`stop-site`, a new bin). The server records the process to stop in `vhost/data/server.pid`; under `npm run dev` that is the watcher, so both it and the server end. It sends `SIGTERM` (the same graceful shutdown as Ctrl+C) and only to a process still answering as a site on the recorded port. Starting a site that is already running now says so instead of reporting a bare port conflict. Existing sites add `"stop": "stop-site"` to `vhost/package.json`'s scripts.

## [0.5.2] - 2026-09-24

### Added

- **A menu can have a display name**, separate from its handle: an optional, non-empty `"name"` in `content/menus/<handle>.json` (content schema 7, with an identity migration - no existing menu needs a value). Layouts can print it as `{{ menus.<handle>.name }}`, for example as a footer column heading. Renaming a menu this way never affects a layout.
- **A menu's handle can be changed** with `POST /v1/menus/rename` (`{ from, to, message, author }`, If-Match): one commit through the write queue, refusing a handle that is taken, a stale ETag, a missing menu, and anything but letters, numbers, hyphens and underscores. It returns the theme files still using the old handle, since every one of them now renders an empty menu until updated.
- **`GET /v1/menus/references?handle=<handle>`** lists the theme files that use a handle (`menus.<handle>` or `menus['<handle>']`, as a whole name only), so a client can warn before a rename or delete.

### Fixed

- **Redeploying never upgraded the agent on an existing volume.** The scaffolded `docker-entrypoint.sh` copied the image onto `/site` on first boot only, so the installed `@o-a/cms-agent` on a persistent volume was never replaced, and the only way to upgrade was destroying the volume and every live edit with it. Every later boot now refreshes `vhost/package.json`, `package-lock.json` and `node_modules` from the image and touches nothing else. Existing sites need this script copied into their own `vhost/` once.
- **A renamed or deleted menu left cached pages showing their old navigation.** The render cache's menu freshness check used the newest menu file's modification time; a rename keeps that time and a delete removes a file, so when the changed menu was not the most recently edited one, nothing moved. The menus directory's own modification time now counts too.

## [0.5.1] - 2026-09-19

### Fixed

- **`seed-media` could not be run the way every document said to run it.** `npx seed-media . <file>` from the site directory never worked: there is no `package.json` or `node_modules` at the site root - the CMS is installed under `vhost/` - so npx resolves nothing locally, asks the public registry for a package called "seed-media" and fails with a 404, *while still exiting 0*. A generated site consequently put all 28 of its images in `theme/root/images/`, because the one documented route into `media/` was a dead end that reported no error. The generated `vhost/package.json` now exposes a `seed-media` script, exactly as it already did for `check`, and both documents give the working form: `npm run seed-media -- .. <file>` from `vhost/`.
- **`npm run check` now reports a content image or video served from `theme/root/` or `theme/assets/`** as a `misplaced-media` finding. This had no other way of being noticed: the file exists, so the page renders perfectly, and the only symptom is that the media library never shows the image and an editor can never replace it. The rule keys off the same extension list the upload route accepts, so the two cannot drift, and only examines `src`/`srcset`/`poster` - an `href` is a link or a favicon, and `.svg` is absent from that list, so a site's own icon and an inline logo are not mistaken for misplaced photographs.
- **A `mailto:` link was reported as a missing file**, because the text after the "@" contains a dot and so looked like a filename. One real site produced 39 such findings and not a single true one - output that noisy trains whoever reads it to ignore the check entirely. Any non-http scheme (`mailto:`, `tel:`, and anything future) is now skipped.
- **A video's `poster` was never checked at all.** It is a real content image reference and is now scanned alongside `src` and `srcset`.
- **A site with no `media/`, `theme/assets/` or `theme/root/` directory crashed the check** with a raw `ENOENT` instead of reporting the missing file, because path sanitisation resolves its root argument unconditionally. The guard fell over on exactly the sites most likely to hold a broken reference. A root directory that does not exist now means the file does not exist, which is an ordinary finding.

## [0.5.0] - 2026-09-18

### Added

- **Every scaffolded site now ships `theme/snippets/responsive-media.liquid`**, and the scaffold uses it: `hero` gains an image setting and `cta-banner` a short silent background loop. It renders a `format: "image"` or `format: "video"` setting and marks the result as a drag-and-drop target, so an editor can drag a file from the admin's media library straight onto the picture in the live preview. Until now the scaffold shipped no image snippet at all, and not one of its sections or blocks even had an image setting, so a theme author had nothing to copy.
  - It deliberately builds no `srcset`. Uploaded files are named by a hash of their own bytes, so a resized variant's name is not derivable from the original's URL - hand-built variant URLs point at files that do not exist, producing a page that looks perfect except at one breakpoint, which is precisely the failure `npm run check` exists to catch.
  - An unset image renders nothing at all rather than a placeholder. A theme cannot tell whether it is rendering for the admin preview or for the public site, so an editor-only affordance would show to real visitors.
  - A video slot emits `data-cms-media`/`data-cms-media-kind` but never `data-cms-image`. An admin predating video support understands only the older attribute and would write an image-shaped value (`{ url, focalX, focalY }`) straight over the field's own `{ url, poster }` - better it ignores the slot than corrupts it.

### Fixed

- **The attribute that makes an image editable was documented nowhere.** Drag-and-drop finds a drop target purely by looking for `data-cms-image` in the previewed page, and no document in this project mentioned it. A real generated site consequently shipped with every image un-editable: the theme rendered perfectly, images simply were not droppable, and nothing about the page looked wrong. `AGENTS.md` and `guide-theme-authoring.md` now both spell out the contract, and do so at each point an image actually comes up rather than in one section near the end.
- **`AGENTS.md` said an image "is just a plain string setting"**, treating `format: "image"` as the exception for when a focal point is wanted. That is backwards: a drop writes an object, so a string-declared field fails validation outright. The object form is now the documented default, and the `seed-media` example that still produced a plain string has been corrected to match.
- **Both guides told authors to hand-write the markup** - `{{ section.settings.<field>.url }}` for an image, a bare `<video>` for a loop. Both now point at the snippet, including the format table rows, the worked example a section is copied from, and the snippets section itself.

## [0.4.0] - 2026-09-17

### Added

- **The media library now accepts and serves video** (`.mp4` and `.webm`), for the short silent loops that stand in for a hero image rather than long-form video. Same 10MB cap as any other upload - anything longer belongs on YouTube or Vimeo, embedded. `.svg` stays rejected (it is never sanitised, so it is a stored-XSS path when loaded as a top-level navigation), and `.mov` with it, since QuickTime frequently will not play in Chrome or Firefox at all.
- **Real HTTP Range support on `/media/*`**: `Accept-Ranges: bytes` on every response, a `206` with `Content-Range` for a satisfiable range, and a `416` for one starting past the end. This is not a bandwidth optimisation. Safari and iOS open a `<video>` with `Range: bytes=0-1` and refuse to play at all without a `206` in reply, so hosted video simply did not work before this. A suffix range (`bytes=-500`) correctly means the *last* 500 bytes rather than the first, an end past the last byte is clamped rather than rejected (browsers routinely overshoot), and a multi-range request falls back to sending the whole file rather than answering with an incorrect multipart body.
- **`format: "video"`** is now a recognised UI hint on an `"type": "object"` setting, storing `{ url, poster }`. The admin renders a video picker with a poster picker for it, in place of the raw-JSON fallback an unrecognised object shape otherwise gets.

### Documentation

- **The scaffold's `AGENTS.md` now says where images actually go.** An agent building a real site from it put every image in the site root, twice running. `assets/` is now described as design assets only, the workflow names the `seed-media` step and `npm run check` explicitly, and the Images section leads with where images live. It also states plainly that one image is one file and one URL, and that the CMS does not generate resized variants - previously left to inference.
- **`format: "video"` is documented in both `AGENTS.md` and `guide-theme-authoring.md`.** Both present their format table as an exhaustive, closed set ("never invent a new setting field shape"), so leaving the new value out did not merely omit it - it actively told theme authors the field did not exist.

## [0.3.1] - 2026-09-17

### Fixed

- **The scaffold's own `AGENTS.md` now explains what a page's `type` does.** It was described only as "free-form", with nothing saying that a template's `type` is inherited by every page created from it, or that the value is what `GET /search.json?pageType=...` filters on. An Article template left at `"type": "page"` therefore produces articles no blog index can find - and because it still validates and previews perfectly, nothing signals the mistake. Documentation only; no code change.

## [0.3.0] - 2026-09-17

### Added

- **`POST /v1/publish-page/:path`**: sets `published: true` on a live page in place and commits - the exact twin of the existing `POST /v1/unpublish/:path`. Deliberately separate from `POST /v1/publish`, which promotes drafts: a page that is live but unpublished has no draft to promote, so publish could not reach it at all, and promoting a draft would push every pending edit live alongside the flag. Like unpublish, it never touches a draft, so a page with unpublished edits keeps them.

## [0.2.2] - 2026-09-09

Three gaps found by having a different AI agent build a real demo site from `AGENTS.md` and report back what it wished were different.

### Fixed

- **The search index now keeps itself current automatically.** Previously `GET /search.json` stayed empty forever on a fresh site and stale forever after a real edit - nothing ever rebuilt it except a caller manually hitting `POST /v1/search/rebuild`. It now rebuilds in the background after every publish/unpublish/delete/move/batch write, and once at boot if no index exists yet (the index is never git-tracked, so a fresh clone starts with none). Fire-and-forget in both cases - a slow or failed reindex never blocks or fails the write that triggered it.

### Added

- **Sections and blocks can now render `page.author`, `page.publishDate`, and `page.tags`** - the same built-in envelope a layout already got (previously just `page.title`), widened and made available to section/block templates too, not just layouts. Closes a real gap: these fields were already indexed for search but had no way to actually appear on the rendered page without duplicating the value into a settings field.
- **A broken theme component now prints a boot warning instead of vanishing silently.** A section/block with no `{% schema %}` block, invalid JSON in it, or a required property with no valid default was already excluded from the theme (unchanged, still never a boot failure) - it just did so with zero output anywhere. `loadThemeSchemas` now names each excluded type and the specific reason.

## [0.2.1] - 2026-09-09

### Added

- **A new `AGENTS.md` in every scaffolded site**, onboarding an AI coding agent to this specific CMS's conventions: theme folder structure, the section/block `{% schema %}` pattern with worked examples, the `format` field-hint table, the current content JSON model, image handling, `GET /search.json`, and the hard constraints. Self-contained - no external link, since generated content shouldn't depend on a live docs site being reachable.

## [0.2.0] - 2026-09-09

### Breaking changes

- **The distinct "post" content type is gone.** `author`, `publishDate`, and `tags` are now optional fields any page may carry - there is no separate schema, and `/blog` is no longer a reserved URL namespace (a page can live at `/blog/<slug>` the same way it can live anywhere else, by nesting it under a `blog` page). A new `schemaVersion` 6 migration relocates any existing `content/posts/<slug>.json` file to `content/pages/blog/<slug>.json`, preserving its old URL, and backfills a `name` field if it doesn't already have one.
  - **Known gap**: there's no automatic migration trigger at boot, and no CLI command runs one either (`runMigrations` exists in `src/services/migration-runner.ts` but nothing currently calls it outside tests). No adopter currently has content under `content/posts/`, so this doesn't affect anyone today - but the migration path itself needs a real trigger mechanism before it would.
- **`GET /v1/search` has moved to `GET /search.json`, unprefixed.** The old path is removed outright, not kept as an alias. Update any theme code calling it directly. The endpoint's behaviour (full-text search, structured filters, sort, pagination) is unchanged - only the path moved, out from under the versioned `/v1/` admin/integration surface to reflect that it's a stable, public, front-end-facing contract instead.
- **Uploaded media filenames changed shape**: `<slug>-<hash>.<ext>` instead of `<hash>-<slug>.<ext>` for new uploads. Still the same content-addressed name (a sha256 hash of the file's own bytes); only the order changed, so the readable part sorts first in a directory listing or URL. Existing uploaded files are untouched - this only affects new uploads going forward.

### Added

- **`GET /search.json`**: one unified, genuinely public query endpoint - no bearer token required, full-text search (`q`), structured filters (`filter=field:op:value`, repeatable, AND'd together), sort, and pagination in a single response. Replaces an earlier, narrower `GET /v1/search/fields` that queried one field at a time.
- **A new `"api": true` JSON Schema keyword** for section/block settings, exposing that field's value through the search index for structured filtering (e.g. `filter=price:lt:50`) - independent of full-text search.
- **`GET /admin`**: a configurable, opt-in redirect to your admin instance. Set `adminBaseUrl` in `site.config.json` and visiting `yoursite.com/admin` redirects there with `?site=<host>` appended, so the admin can resolve straight to this site's own dashboard. Leave it unset and the route doesn't exist at all - a site can still use "admin" as an ordinary page path.
- **An in-process render cache for public pages.** Previously every request re-read and re-rendered a page from scratch; rendered HTML is now cached and validated against real file mtimes (the page's own file, plus every menu file, since menus render into every page's nav), so a repeat request for an unchanged page skips rendering entirely.
- **`Cache-Control: public, max-age=31536000, immutable`** on every media response - safe unconditionally, since filenames are content-addressed and a given URL's bytes can never change.

### Fixed

- **`engines.node` was wrong and is now `>=22.16.0`, not `>=22.6.0`.** The old floor was never actually verified against real Node builds: `node:sqlite` needs `--experimental-sqlite` below Node 22.13.0 (never passed anywhere in this package), and FTS5 support itself - the search index's own full-text engine - isn't compiled in at all until Node 22.16.0. Every version from the old floor up to 22.15.x would hard-crash the moment a search index rebuild ran. Confirmed by downloading and testing real Node builds directly, not assumed from release notes.
- **A search index rebuild no longer blocks the entire server.** `rebuildIndexJob` was `async` but had no real `await` in its body, so on a busy site a rebuild froze every other request (not just search) for its whole duration. It now yields to the event loop periodically during a rebuild.
- **A search index rebuild is now atomic.** Previously the index file was deleted then recreated in place, a real window where a concurrent read could see a missing file or one with no tables yet. It's now built into a temp file and swapped in via an atomic rename.

### Documentation

- Caught up `guide-theme-authoring.md` (then named `theme-authoring-guide.md`) on several already-shipped theme field conventions that were undocumented or stale: `format: "richtext"`, `format: "image"` (with focal-point support), `format: "color"`'s `swatches` keyword, the range field format, the consolidated toggle/select field formats.
