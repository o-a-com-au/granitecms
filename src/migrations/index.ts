import type { MigrationMap } from '../services/migration-runner.ts';

// The current content schema version. Bumping this and adding a new
// migrations[N] entry is the only way a content shape may change
// (constraint 4) - never a manual edit convention.
export const CURRENT_SCHEMA_VERSION = 5;

// A trivial identity migration, proving the mechanism (per the build
// plan's Phase 1 scope): no shape change, only the version bump. Safe
// against page.schema.json's schemaVersion: { minimum: 1 } (not an
// exact/enum check), so nothing else needs updating for this bump to
// keep validating.
function migrateV1ToV2(content: Record<string, unknown>): Record<string, unknown> {
  return { ...content, schemaVersion: 2 };
}

// page.schema.json now requires "type" (Phase 2 Group D, backing the
// GET /v1/content list endpoint's type filter). Every page authored
// before this migration is a generic page, not any newer distinct
// kind, so "page" is a safe, honest default for existing content -
// never invented per-file, always this one fixed value.
function migrateV2ToV3(content: Record<string, unknown>): Record<string, unknown> {
  return { ...content, schemaVersion: 3, type: 'page' };
}

// page.schema.json now requires "layout" (theme layouts group), naming
// which theme/layouts/*.liquid file wraps this page's rendered
// content. Every page authored before this migration used the only
// layout that existed at the time, so "theme" (theme/layouts/theme.liquid)
// is the correct default, not an invented placeholder - render-page.ts's
// own read path applies this exact same default defensively too, since
// migrations aren't wired to run automatically anywhere yet.
function migrateV3ToV4(content: Record<string, unknown>): Record<string, unknown> {
  return { ...content, schemaVersion: 4, layout: 'theme' };
}

// page.schema.json now requires "name" (the admin's own page tree
// label, distinct from "title" - the same content can now be called
// "Home Page" in the tree while still rendering a different <title>).
// Every page authored before this migration has never had a name of
// its own, so its existing title is the only honest default - not an
// invented placeholder, and not the file's own path/slug, which is a
// separate concept again. content-read.ts's listContent applies this
// exact same title fallback defensively too, since migrations aren't
// wired to run automatically anywhere yet.
function migrateV4ToV5(content: Record<string, unknown>): Record<string, unknown> {
  const title = typeof content.title === 'string' ? content.title : '';
  return { ...content, schemaVersion: 5, name: title };
}

export const migrations: MigrationMap = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
  3: migrateV3ToV4,
  4: migrateV4ToV5,
};
