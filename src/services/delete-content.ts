import { existsSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { SiteConfig } from '../config.ts';
import { listFilesRecursively } from './fs-walk.ts';
import { commitPaths } from './git.ts';
import type { CommitAuthor } from './git.ts';
import { sanitisePath } from './path-safety.ts';
import type { PreparedOperation } from './prepared-operation.ts';
import { RedirectError, addRedirect, loadRedirects } from './redirects.ts';
import { pagePathToUrl } from './urls.ts';
import { enqueue } from './write-queue.ts';

const PAGES_PREFIX = 'pages/';

export type DeleteContentReason =
  | 'page-not-found'
  | 'has-children'
  | 'redirect-cycle'
  | 'write-failed'
  | 'commit-failed'
  | 'rollback-failed';

export class DeleteContentError extends Error {
  readonly reason: DeleteContentReason;

  constructor(reason: DeleteContentReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DeleteContentError';
    this.reason = reason;
  }
}

// Validates and writes everything a delete needs, stopping short of
// the commit itself - used both by the standalone deleteContentJob
// (which commits immediately after) and by batch.ts (which accumulates
// this alongside other operations and commits once for the whole
// batch). A write-phase failure (including a client-triggered
// redirect-cycle) is caught and rolled back here, inside prepare
// itself, so prepare either fully succeeds or fully undoes itself
// before throwing.
export function prepareDeleteContent(
  config: SiteConfig,
  relativePath: string,
  redirectTo: string | undefined,
): PreparedOperation {
  const livePath = sanitisePath(config.contentRoot, relativePath);
  if (!existsSync(livePath)) {
    throw new DeleteContentError('page-not-found', `No live page found at "${relativePath}"`);
  }

  // Subtree rejection: a deliberate scope decision (reject outright,
  // not cascade) - an accidental single DELETE can't silently take a
  // whole subtree with it. "Has children" means a real child page
  // exists (checked via listFilesRecursively), never bare directory
  // existence: a leftover *empty* sibling directory would otherwise
  // make this page permanently undeletable, since no rmdir/cleanup
  // endpoint exists anywhere in this API to ever clear it.
  if (relativePath.startsWith(PAGES_PREFIX)) {
    const dirRelative = relativePath.slice(PAGES_PREFIX.length).replace(/\.json$/, '');
    const dirPath = sanitisePath(config.pagesRoot, dirRelative);
    if (
      existsSync(dirPath) &&
      statSync(dirPath).isDirectory() &&
      listFilesRecursively(dirPath, dirPath, '.json').length > 0
    ) {
      throw new DeleteContentError('has-children', `"${relativePath}" has child pages; delete them first`);
    }
  }

  // Never touches a draft at the same path: /v1/content and /v1/drafts
  // are separate resources with their own dedicated DELETEs, and a
  // draft-only page is already a legitimate, independently-listable
  // state (Group D's listContent unions contentRoot/draftsRoot).
  const original = readFileSync(livePath);
  let redirectsBefore: string | null = null;
  let redirectsChanged = false;

  // Reverses the unlink and restores/removes redirects.json. Matches
  // publish.ts's/move.ts's rollback() philosophy: attempt everything,
  // report every failure.
  function undoDeleteWrites(): unknown[] {
    const restoreFailures: unknown[] = [];

    try {
      writeFileSync(livePath, original);
    } catch (restoreError) {
      restoreFailures.push(restoreError);
    }

    if (redirectsChanged) {
      try {
        if (redirectsBefore === null) {
          rmSync(config.redirectsPath, { force: true });
        } else {
          writeFileSync(config.redirectsPath, redirectsBefore);
        }
      } catch (restoreError) {
        restoreFailures.push(restoreError);
      }
    }

    return restoreFailures;
  }

  try {
    unlinkSync(livePath);

    // redirectTo is client-supplied, unlike publish.ts/move.ts's own
    // automatic redirect bookkeeping - a client can trivially trigger a
    // real cycle (e.g. redirectTo pointing back into an existing
    // chain), so that's surfaced as its own reason, not left to fall
    // into the generic write-failed/500 bucket an unlikely automatic-
    // bookkeeping cycle would.
    if (redirectTo !== undefined && relativePath.startsWith(PAGES_PREFIX)) {
      const fromUrl = pagePathToUrl(relativePath.slice(PAGES_PREFIX.length));
      redirectsBefore = existsSync(config.redirectsPath)
        ? readFileSync(config.redirectsPath, 'utf-8')
        : null;

      let redirects;
      try {
        redirects = addRedirect(loadRedirects(config), fromUrl, redirectTo);
      } catch (error) {
        if (error instanceof RedirectError) {
          throw new DeleteContentError('redirect-cycle', error.message, { cause: error });
        }
        throw error;
      }

      const serialised = JSON.stringify(redirects, null, 2);
      if (serialised !== (redirectsBefore ?? '')) {
        writeFileSync(config.redirectsPath, serialised);
        redirectsChanged = true;
      }
    }
  } catch (error) {
    const failures = undoDeleteWrites();
    if (failures.length > 0) {
      throw new DeleteContentError(
        'rollback-failed',
        'Delete failed and rolling back afterwards also failed; the working tree may be inconsistent and needs manual inspection',
        { cause: error },
      );
    }

    // A redirect-cycle is already a DeleteContentError with its own
    // reason - preserve it rather than reclassifying it as write-failed.
    if (error instanceof DeleteContentError) {
      throw error;
    }

    // Always write-failed here, structurally: commitPaths hasn't been
    // called yet, so this can never be a GitOperationError.
    const detail = error instanceof Error ? error.message : String(error);
    throw new DeleteContentError('write-failed', `Delete failed: ${detail}`, { cause: error });
  }

  const paths = [livePath];
  if (redirectsChanged) {
    paths.push(config.redirectsPath);
  }
  return { paths, undo: undoDeleteWrites };
}

async function deleteContentJob(
  config: SiteConfig,
  relativePath: string,
  redirectTo: string | undefined,
  message: string,
  author: CommitAuthor,
): Promise<void> {
  const { paths, undo } = prepareDeleteContent(config, relativePath, redirectTo);
  try {
    commitPaths(config.siteRoot, paths, message, author);
  } catch (error) {
    const failures = undo();
    if (failures.length > 0) {
      throw new DeleteContentError(
        'rollback-failed',
        'Delete failed and rolling back afterwards also failed; the working tree may be inconsistent and needs manual inspection',
        { cause: error },
      );
    }
    // Always commit-failed here, structurally: prepare already
    // succeeded, so anything caught in this try can only have come
    // from commitPaths itself.
    const detail = error instanceof Error ? error.message : String(error);
    throw new DeleteContentError('commit-failed', `Delete failed: ${detail}`, { cause: error });
  }
}

export function deleteContent(
  config: SiteConfig,
  relativePath: string,
  redirectTo: string | undefined,
  message: string,
  author: CommitAuthor,
): Promise<void> {
  return enqueue(() => deleteContentJob(config, relativePath, redirectTo, message, author));
}
