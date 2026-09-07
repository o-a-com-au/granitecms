import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  // Equal to path for an ordinary in-place migration. Differs only for
  // a legacy content/posts/<slug>.json file, relocated to
  // content/pages/blog/<slug>.json as part of folding posts into pages
  // (see the "legacy posts" pass below) - the write phase writes here,
  // not to path, and removes path afterwards.
  targetPath: string;
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
// there is no "did this file exist before" branch to carry. A
// relocated file (targetPath !== path) is undone by removing whatever
// landed at targetPath and restoring the original at its original path.
function rollback(files: MigratedFile[]): unknown[] {
  const failures: unknown[] = [];
  for (const file of files) {
    try {
      if (file.targetPath !== file.path) {
        try {
          unlinkSync(file.targetPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
      }
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
  // content/posts/ is a legacy root: posts were folded into pages, and
  // no code walks a postsRoot for anything else any more (see
  // config.ts) - it's computed locally, here only, purely to find any
  // leftover legacy files this migration needs to relocate. A site
  // that never had posts has no such directory; listFilesRecursively
  // already returns [] for a missing root, same as every other caller.
  const legacyPostsRoot = join(config.contentRoot, 'posts');

  // Named walks (pages/menus/legacy posts), not one broad walk of
  // contentRoot - see content-read.ts's listContent for the identical
  // reasoning (Group N nested draftsRoot/redirectsPath inside
  // contentRoot; a broad walk would double-migrate drafts and try to
  // validate redirects.json as a page). base stays config.contentRoot
  // for pages/menus so relativePath matches what validateContent
  // expects. Legacy posts get their own targetPath: content/posts/
  // was always flat (no nested slugs), so relocating each file to
  // content/pages/blog/<slug>.json preserves its old /blog/<slug> URL
  // as an ordinary nested page - no reserved namespace needed any more.
  const files = [
    ...listFilesRecursively(config.pagesRoot, config.contentRoot, '.json').map((rel) => ({
      path: join(config.contentRoot, rel),
      targetPath: join(config.contentRoot, rel),
      relativePath: rel,
    })),
    ...listFilesRecursively(config.menusRoot, config.contentRoot, '.json').map((rel) => ({
      path: join(config.contentRoot, rel),
      targetPath: join(config.contentRoot, rel),
      relativePath: rel,
    })),
    ...listFilesRecursively(legacyPostsRoot, legacyPostsRoot, '.json').map((rel) => ({
      path: join(legacyPostsRoot, rel),
      targetPath: join(config.contentRoot, 'pages', 'blog', rel),
      relativePath: join('pages', 'blog', rel),
    })),
    ...listFilesRecursively(config.draftsRoot, config.draftsRoot, '.json').map((rel) => ({
      path: join(config.draftsRoot, rel),
      targetPath: join(config.draftsRoot, rel),
      relativePath: rel,
    })),
  ];

  // Compute every migration before writing anything. If any file's
  // migration or validation throws, everything computed for other
  // files so far is simply discarded - a mid-list failure aborts with
  // literally zero writes having happened (F4's primary scenario).
  const toMigrate: MigratedFile[] = [];
  for (const { path, targetPath, relativePath } of files) {
    const originalBytes = readFileSync(path);
    const parsed = JSON.parse(originalBytes.toString('utf-8')) as Record<string, unknown>;
    const schemaVersion = parsed.schemaVersion;

    // A legacy posts/ file can never already be at currentVersion: the
    // posts/ directory only ever held content written before this very
    // migration existed, so this skip and the relocation above never
    // conflict in practice.
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
    toMigrate.push({ path, targetPath, originalBytes, migratedBytes });
  }

  if (toMigrate.length === 0) {
    return;
  }

  try {
    for (const file of toMigrate) {
      if (file.targetPath !== file.path) {
        mkdirSync(dirname(file.targetPath), { recursive: true });
      }
      writeFileSync(file.targetPath, file.migratedBytes);
      if (file.targetPath !== file.path) {
        unlinkSync(file.path);
      }
    }
    const committedPaths = new Set<string>();
    for (const file of toMigrate) {
      committedPaths.add(file.path);
      committedPaths.add(file.targetPath);
    }
    commitPaths(
      config.siteRoot,
      [...committedPaths],
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
