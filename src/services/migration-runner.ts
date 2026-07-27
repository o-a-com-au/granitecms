import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { listFilesRecursively } from './fs-walk.ts';
import type { CommitAuthor } from './git.ts';
import { GitOperationError, commitPaths } from './git.ts';
import type { ThemeSchemas } from './validation.ts';
import { validateContent } from './validation.ts';
import { enqueue } from './write-queue.ts';

export type MigrationFunction = (content: Record<string, unknown>) => Record<string, unknown>;
export type MigrationMap = Record<number, MigrationFunction>;

export type MigrationReason =
  | 'migration-failed'
  | 'validation-failed'
  | 'write-failed'
  | 'commit-failed'
  | 'rollback-failed';

export class MigrationError extends Error {
  readonly reason: MigrationReason;

  constructor(reason: MigrationReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
    this.reason = reason;
  }
}

interface MigratedFile {
  path: string;
  originalBytes: Buffer;
  migratedBytes: Buffer;
}

// Walks the migration chain one step at a time until currentVersion is
// reached. Throws if a step is missing, or if a migration doesn't
// actually advance the version (a defensive check against a broken
// migration function).
function applyMigrationChain(
  content: Record<string, unknown>,
  migrations: MigrationMap,
  currentVersion: number,
  path: string,
): Record<string, unknown> {
  let current = content;

  const initialVersion = current.schemaVersion;
  if (typeof initialVersion !== 'number') {
    throw new MigrationError('migration-failed', `"${path}" has no numeric schemaVersion`);
  }
  let version: number = initialVersion;

  while (version < currentVersion) {
    const migrate = migrations[version];
    if (!migrate) {
      throw new MigrationError(
        'migration-failed',
        `No migration registered for schemaVersion ${version} ("${path}")`,
      );
    }

    const next = migrate(current);
    const nextVersion = next.schemaVersion;
    if (typeof nextVersion !== 'number' || nextVersion <= version) {
      throw new MigrationError(
        'migration-failed',
        `Migration from schemaVersion ${version} did not advance schemaVersion ("${path}")`,
      );
    }

    current = next;
    version = nextVersion;
  }

  return current;
}

// Hand-rolled fs snapshot/restore, matching publish.ts's established
// shape - but simpler: every file the write phase touches already
// existed with real prior bytes (F3's skip logic guarantees this), so
// there is no "did this file exist before" branch to carry.
function rollback(files: MigratedFile[]): unknown[] {
  const failures: unknown[] = [];
  for (const file of files) {
    try {
      writeFileSync(file.path, file.originalBytes);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function runMigrationsJob(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  migrations: MigrationMap,
  currentVersion: number,
  author: CommitAuthor,
): Promise<void> {
  const files = [
    ...listFilesRecursively(config.contentRoot, config.contentRoot, '.json').map((rel) => ({
      path: join(config.contentRoot, rel),
      relativePath: rel,
    })),
    ...listFilesRecursively(config.draftsRoot, config.draftsRoot, '.json').map((rel) => ({
      path: join(config.draftsRoot, rel),
      relativePath: rel,
    })),
  ];

  // Compute every migration before writing anything. If any file's
  // migration or validation throws, everything computed for other
  // files so far is simply discarded - a mid-list failure aborts with
  // literally zero writes having happened (F4's primary scenario).
  const toMigrate: MigratedFile[] = [];
  for (const { path, relativePath } of files) {
    const originalBytes = readFileSync(path);
    const parsed = JSON.parse(originalBytes.toString('utf-8')) as Record<string, unknown>;
    const schemaVersion = parsed.schemaVersion;

    if (typeof schemaVersion === 'number' && schemaVersion >= currentVersion) {
      continue;
    }

    const migrated = applyMigrationChain(parsed, migrations, currentVersion, path);

    const result = validateContent(relativePath, migrated, themeSchemas);
    if (!result.valid) {
      throw new MigrationError(
        'validation-failed',
        `Migrated content at "${path}" failed validation: ${JSON.stringify(result.errors)}`,
      );
    }

    const migratedBytes = Buffer.from(JSON.stringify(migrated, null, 2));
    toMigrate.push({ path, originalBytes, migratedBytes });
  }

  if (toMigrate.length === 0) {
    return;
  }

  try {
    for (const file of toMigrate) {
      writeFileSync(file.path, file.migratedBytes);
    }
    commitPaths(
      config.siteRoot,
      toMigrate.map((file) => file.path),
      `chore: migrate content to schema version ${currentVersion}`,
      author,
    );
  } catch (error) {
    const failures = rollback(toMigrate);
    if (failures.length > 0) {
      throw new MigrationError(
        'rollback-failed',
        'Migration run failed and rolling back afterwards also failed; the working tree may be inconsistent and needs manual inspection',
        { cause: error },
      );
    }
    const reason = error instanceof GitOperationError ? 'commit-failed' : 'write-failed';
    const detail = error instanceof Error ? error.message : String(error);
    throw new MigrationError(reason, `Migration run failed: ${detail}`, { cause: error });
  }
}

export function runMigrations(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  migrations: MigrationMap,
  currentVersion: number,
  author: CommitAuthor,
): Promise<void> {
  return enqueue(() => runMigrationsJob(config, themeSchemas, migrations, currentVersion, author));
}
