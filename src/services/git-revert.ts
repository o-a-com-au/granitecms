import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { SiteConfig } from '../config.ts';
import type { CommitAuthor } from './git.ts';
import { commitPaths, isValidGitRef } from './git.ts';
import { sanitisePath } from './path-safety.ts';
import type { PreparedOperation } from './prepared-operation.ts';
import { enqueue } from './write-queue.ts';

export type RevertReason =
  | 'invalid-ref'
  | 'path-not-found-at-ref'
  | 'write-failed'
  | 'commit-failed'
  | 'rollback-failed';

export class RevertError extends Error {
  readonly reason: RevertReason;

  constructor(reason: RevertReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RevertError';
    this.reason = reason;
  }
}

interface PathSnapshot {
  path: string;
  existed: boolean;
  original?: Buffer;
}

// Validates and writes everything a revert needs, stopping short of
// the commit itself - mirrors publish.ts/move.ts/delete-content.ts's
// prepareX/xJob split exactly.
export function prepareRevertPaths(
  config: SiteConfig,
  ref: string,
  relativePaths: string[],
): PreparedOperation {
  if (!isValidGitRef(ref)) {
    throw new RevertError('invalid-ref', `Invalid ref: "${ref}"`);
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: config.siteRoot,
      stdio: 'ignore',
    });
  } catch {
    throw new RevertError('invalid-ref', `Ref does not resolve to a commit: "${ref}"`);
  }

  const absolutePaths = relativePaths.map((p) => sanitisePath(config.siteRoot, p));
  const repoRelativePaths = absolutePaths.map((p) => relative(config.siteRoot, p));

  // Validate every path exists at ref BEFORE touching any working-tree
  // file - same "validate everything, write nothing yet" ordering as
  // publish.ts/move.ts, so a bad path in a multi-path revert fails
  // clean with zero side effects on the other paths. Deliberately out
  // of scope: "revert to a state before this file existed" (i.e.
  // simulate a delete) - surfaced as a clean, distinct error instead of
  // silently unlinking a file based on inferred intent nobody asked
  // for.
  for (let i = 0; i < repoRelativePaths.length; i++) {
    try {
      execFileSync('git', ['cat-file', '-e', `${ref}:${repoRelativePaths[i]}`], {
        cwd: config.siteRoot,
        stdio: 'ignore',
      });
    } catch {
      throw new RevertError(
        'path-not-found-at-ref',
        `No file at "${relativePaths[i]}" at revision "${ref}"`,
      );
    }
  }

  const snapshots: PathSnapshot[] = [];

  function undo(): unknown[] {
    const failures: unknown[] = [];
    for (const snap of snapshots) {
      try {
        if (snap.existed) {
          writeFileSync(snap.path, snap.original as Buffer);
        } else if (existsSync(snap.path)) {
          unlinkSync(snap.path);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
    // No explicit unstage here: a failed commitPaths already runs its
    // own `git reset -- <paths>` internally (git.ts), matching
    // delete-content.ts's identical precedent - undo only needs to
    // restore file content.
  }

  try {
    for (const absolutePath of absolutePaths) {
      const existed = existsSync(absolutePath);
      snapshots.push({
        path: absolutePath,
        existed,
        original: existed ? readFileSync(absolutePath) : undefined,
      });
    }
    for (const absolutePath of absolutePaths) {
      execFileSync('git', ['checkout', ref, '--', absolutePath], {
        cwd: config.siteRoot,
        stdio: 'ignore',
      });
    }
  } catch (error) {
    const failures = undo();
    if (failures.length > 0) {
      throw new RevertError(
        'rollback-failed',
        'Revert failed and rolling back afterwards also failed; the working tree may be inconsistent and needs manual inspection',
        { cause: error },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new RevertError('write-failed', `Revert failed: ${detail}`, { cause: error });
  }

  return { paths: absolutePaths, undo };
}

async function revertJob(
  config: SiteConfig,
  ref: string,
  relativePaths: string[],
  message: string,
  author: CommitAuthor,
): Promise<void> {
  const { paths, undo } = prepareRevertPaths(config, ref, relativePaths);

  // The batch.ts empty-commit lesson, triggered here by content-
  // identity rather than an empty path list: `git checkout` always
  // stages *something* even when the reverted content is byte-
  // identical to what's already live (e.g. reverting to HEAD, or a
  // double-submitted revert) - `git commit` would then fail with
  // "nothing to commit" for a request that didn't actually do anything
  // wrong. Scoped to just the reverted paths, not the whole repo, so
  // an unrelated pre-existing dirty index (exactly what /git/commit's
  // escape hatch exists for) is never mistaken for "this revert was a
  // no-op".
  let hasChanges = true;
  try {
    execFileSync('git', ['diff', '--cached', '--quiet', '--', ...paths], {
      cwd: config.siteRoot,
      stdio: 'ignore',
    });
    hasChanges = false;
  } catch {
    hasChanges = true;
  }
  if (!hasChanges) {
    return;
  }

  try {
    commitPaths(config.siteRoot, paths, message, author);
  } catch (error) {
    const failures = undo();
    if (failures.length > 0) {
      throw new RevertError(
        'rollback-failed',
        'Revert failed and rolling back afterwards also failed; the working tree may be inconsistent and needs manual inspection',
        { cause: error },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new RevertError('commit-failed', `Revert failed: ${detail}`, { cause: error });
  }
}

export function revertPaths(
  config: SiteConfig,
  ref: string,
  relativePaths: string[],
  message: string,
  author: CommitAuthor,
): Promise<void> {
  return enqueue(() => revertJob(config, ref, relativePaths, message, author));
}
