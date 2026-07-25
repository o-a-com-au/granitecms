import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SiteConfig } from '../config.ts';
import type { CommitAuthor } from './git.ts';
import { GitOperationError, commitPaths } from './git.ts';
import { sanitisePath } from './path-safety.ts';
import type { ThemeSchemas } from './validation.ts';
import { validatePage } from './validation.ts';
import { enqueue } from './write-queue.ts';

export type PublishReason =
  | 'validation-failed'
  | 'draft-not-found'
  | 'page-not-found'
  | 'duplicate-path'
  | 'write-failed'
  | 'commit-failed'
  | 'rollback-failed';

export class PublishError extends Error {
  readonly reason: PublishReason;

  constructor(reason: PublishReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PublishError';
    this.reason = reason;
  }
}

interface PublishEntry {
  relativePath: string;
  draftPath: string;
  livePath: string;
  draftContent: Buffer;
}

interface FileSnapshot {
  livePath: string;
  liveExisted: boolean;
  liveOriginal?: Buffer;
  draftPath: string;
  draftOriginal: Buffer;
}

// Hand-rolled fs snapshot/restore, not a database transaction
// (deliberate, given the minimal-dependency policy). Attempts every
// restore even if one fails, rather than aborting on the first error,
// and reports every failure to the caller: a filesystem cannot give a
// true atomicity guarantee (disk full, permissions changing mid-flight
// are real residual risks), so the honest contract is "restores
// everything it can, and is loud if it can't" rather than a silent
// best-effort.
function rollback(snapshots: FileSnapshot[]): unknown[] {
  const failures: unknown[] = [];

  for (const snapshot of snapshots) {
    try {
      if (snapshot.liveExisted) {
        writeFileSync(snapshot.livePath, snapshot.liveOriginal as Buffer);
      } else if (existsSync(snapshot.livePath)) {
        unlinkSync(snapshot.livePath);
      }
    } catch (error) {
      failures.push(error);
    }

    try {
      mkdirSync(dirname(snapshot.draftPath), { recursive: true });
      writeFileSync(snapshot.draftPath, snapshot.draftOriginal);
    } catch (error) {
      failures.push(error);
    }
  }

  return failures;
}

function rollbackOrRethrow(snapshots: FileSnapshot[], cause: unknown): never {
  const failures = rollback(snapshots);
  if (failures.length > 0) {
    throw new PublishError(
      'rollback-failed',
      'Publish failed and rolling back afterwards also failed; the working tree may be inconsistent and needs manual inspection',
      { cause },
    );
  }
  const reason = cause instanceof GitOperationError ? 'commit-failed' : 'write-failed';
  const message = cause instanceof Error ? cause.message : String(cause);
  throw new PublishError(reason, `Publish failed: ${message}`, { cause });
}

async function publishDraftsJob(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  relativePaths: string[],
  message: string,
  author: CommitAuthor,
): Promise<void> {
  // Reject duplicates up front: without this, a repeated path's live-
  // file snapshot would capture already-overwritten state instead of
  // the true original, corrupting any later rollback.
  const seen = new Set<string>();
  for (const relativePath of relativePaths) {
    if (seen.has(relativePath)) {
      throw new PublishError('duplicate-path', `Duplicate path in publish request: "${relativePath}"`);
    }
    seen.add(relativePath);
  }

  // Validate every path before writing anything. Nothing is written
  // during this pass, so "no files change and no commit is created" on
  // any failure (C6) falls out of ordering, not cleanup logic. Safe
  // because the write queue serialises everything: no other job can
  // interleave and change a draft between this pass and the write pass.
  const entries: PublishEntry[] = [];
  for (const relativePath of relativePaths) {
    const draftPath = sanitisePath(config.draftsRoot, relativePath);
    const livePath = sanitisePath(config.contentRoot, relativePath);

    let draftContent: Buffer;
    try {
      draftContent = readFileSync(draftPath);
    } catch {
      throw new PublishError('draft-not-found', `No draft found at "${relativePath}"`);
    }

    const parsed: unknown = JSON.parse(draftContent.toString('utf-8'));
    const result = validatePage(parsed, themeSchemas);
    if (!result.valid) {
      throw new PublishError(
        'validation-failed',
        `Draft at "${relativePath}" failed validation: ${JSON.stringify(result.errors)}`,
      );
    }

    entries.push({ relativePath, draftPath, livePath, draftContent });
  }

  const snapshots: FileSnapshot[] = [];
  try {
    for (const entry of entries) {
      let liveExisted = false;
      let liveOriginal: Buffer | undefined;
      try {
        liveOriginal = readFileSync(entry.livePath);
        liveExisted = true;
      } catch {
        liveExisted = false;
      }

      snapshots.push({
        livePath: entry.livePath,
        liveExisted,
        liveOriginal,
        draftPath: entry.draftPath,
        draftOriginal: entry.draftContent,
      });

      mkdirSync(dirname(entry.livePath), { recursive: true });
      writeFileSync(entry.livePath, entry.draftContent);
      unlinkSync(entry.draftPath);
    }

    // Only the live paths are ever staged: drafts are never git-tracked
    // in the first place (saves don't commit, per C2), so a draft's
    // deletion has no git-visible effect at all. Including it in the
    // commit would fail outright, since `git add` on a path that is
    // both absent from disk and was never tracked is a hard error
    // ("pathspec did not match any files"), not a silent no-op.
    const livePaths = entries.map((entry) => entry.livePath);
    // commitPaths gives its own all-or-nothing contract for git staging,
    // so a failure here only ever leaves filesystem state for this
    // catch block to worry about, never git index state.
    commitPaths(config.siteRoot, livePaths, message, author);
  } catch (error) {
    rollbackOrRethrow(snapshots, error);
  }
}

async function unpublishPageJob(
  config: SiteConfig,
  relativePath: string,
  message: string,
  author: CommitAuthor,
): Promise<void> {
  const livePath = sanitisePath(config.contentRoot, relativePath);

  let original: Buffer;
  try {
    original = readFileSync(livePath);
  } catch {
    throw new PublishError('page-not-found', `No live page found at "${relativePath}"`);
  }

  const parsed = JSON.parse(original.toString('utf-8')) as Record<string, unknown>;
  parsed.published = false;
  const updated = Buffer.from(JSON.stringify(parsed, null, 2));

  // Unpublish only ever touches one file and never a draft, so it gets
  // its own minimal inline restore rather than routing through the
  // two-file publish rollback() above, which would need an unused
  // draft slot to fit the same shape for no benefit.
  try {
    writeFileSync(livePath, updated);
    commitPaths(config.siteRoot, [livePath], message, author);
  } catch (error) {
    try {
      writeFileSync(livePath, original);
    } catch {
      throw new PublishError(
        'rollback-failed',
        'Unpublish failed and rolling back afterwards also failed; the working tree may be inconsistent and needs manual inspection',
        { cause: error },
      );
    }
    const reason = error instanceof GitOperationError ? 'commit-failed' : 'write-failed';
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new PublishError(reason, `Unpublish failed: ${errorMessage}`, { cause: error });
  }
}

export function publishDrafts(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  relativePaths: string[],
  message: string,
  author: CommitAuthor,
): Promise<void> {
  return enqueue(() => publishDraftsJob(config, themeSchemas, relativePaths, message, author));
}

export function unpublishPage(
  config: SiteConfig,
  relativePath: string,
  message: string,
  author: CommitAuthor,
): Promise<void> {
  return enqueue(() => unpublishPageJob(config, relativePath, message, author));
}
