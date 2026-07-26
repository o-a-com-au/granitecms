import type { MigrationMap } from '../services/migration-runner.ts';

// The current content schema version. Bumping this and adding a new
// migrations[N] entry is the only way a content shape may change
// (constraint 4) - never a manual edit convention.
export const CURRENT_SCHEMA_VERSION = 3;

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

export const migrations: MigrationMap = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
};
