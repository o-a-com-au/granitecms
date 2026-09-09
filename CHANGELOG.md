# Changelog

All notable changes to this package are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Nothing before `0.2.0` was tracked in this file - see git history for anything earlier.

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
