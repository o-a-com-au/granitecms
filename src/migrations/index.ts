import type { MigrationMap } from '../services/migration-runner.ts';

// The current content schema version. Bumping this and adding a new
// migrations[N] entry is the only way a content shape may change
// (constraint 4) - never a manual edit convention.
export const CURRENT_SCHEMA_VERSION = 2;

// A trivial identity migration, proving the mechanism (per the build
// plan's Phase 1 scope): no shape change, only the version bump. Safe
// against page.schema.json's schemaVersion: { minimum: 1 } (not an
// exact/enum check), so nothing else needs updating for this bump to
// keep validating.
function migrateV1ToV2(content: Record<string, unknown>): Record<string, unknown> {
  return { ...content, schemaVersion: 2 };
}

export const migrations: MigrationMap = {
  1: migrateV1ToV2,
};
