import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { listFilesRecursively } from './fs-walk.ts';
import { commitPaths } from './git.ts';
import type { CommitAuthor } from './git.ts';
import { sanitisePath } from './path-safety.ts';
import type { PreparedOperation } from './prepared-operation.ts';
import { addRedirect, loadRedirects, removeRedirectForPath, serialiseRedirects } from './redirects.ts';
import type { RedirectEntry } from './redirects.ts';
import { pagePathToUrl, urlToPagePath } from './urls.ts';
import { enqueue } from './write-queue.ts';

export type MoveReason =
  | 'source-not-found'
  | 'destination-exists'
  | 'write-failed'
  | 'commit-failed'
  | 'rollback-failed';

export class MoveError extends Error {
  readonly reason: MoveReason;

  constructor(reason: MoveReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MoveError';
    this.reason = reason;
  }
}

interface AffectedPage {
  oldRelativePath: string;
  newRelativePath: string;
  oldUrl: string;
  newUrl: string;
}

// Validates and writes everything a move needs, stopping short of the
// commit itself - used both by the standalone movePageJob (which
// commits immediately after) and by batch.ts (which accumulates this
// alongside other operations and commits once for the whole batch). A
// write-phase failure is caught and rolled back here, inside prepare
// itself, so prepare either fully succeeds or fully undoes itself
// before throwing.
export function prepareMovePage(config: SiteConfig, fromUrl: string, toUrl: string): PreparedOperation {
  const fromRelative = urlToPagePath(fromUrl);
  const toRelative = urlToPagePath(toUrl);

  const fromPageFile = sanitisePath(config.pagesRoot, fromRelative);
  const toPageFile = sanitisePath(config.pagesRoot, toRelative);

  if (!existsSync(fromPageFile)) {
    throw new MoveError('source-not-found', `No page found at "${fromUrl}"`);
  }
  if (existsSync(toPageFile)) {
    throw new MoveError('destination-exists', `A page already exists at "${toUrl}"`);
  }

  const fromDirRelative = fromRelative.replace(/\.json$/, '');
  const toDirRelative = toRelative.replace(/\.json$/, '');
  const fromDir = sanitisePath(config.pagesRoot, fromDirRelative);
  const toDir = sanitisePath(config.pagesRoot, toDirRelative);
  const fromDirExists = existsSync(fromDir) && statSync(fromDir).isDirectory();

  if (fromDirExists && existsSync(toDir)) {
    throw new MoveError(
      'destination-exists',
      `A directory already exists at the destination for "${toUrl}"`,
    );
  }

  // Enumerate every affected page (the page itself, plus every
  // descendant if it has any) before touching disk. This list drives
  // both the redirect entries (E3: one per affected page) and the git
  // staging list.
  const affected: AffectedPage[] = [
    { oldRelativePath: fromRelative, newRelativePath: toRelative, oldUrl: fromUrl, newUrl: toUrl },
  ];

  if (fromDirExists) {
    for (const rel of listFilesRecursively(fromDir, fromDir, '.json')) {
      const oldRelativePath = join(fromDirRelative, rel);
      const newRelativePath = join(toDirRelative, rel);
      affected.push({
        oldRelativePath,
        newRelativePath,
        oldUrl: pagePathToUrl(oldRelativePath),
        newUrl: pagePathToUrl(newRelativePath),
      });
    }
  }

  const performedRenames: Array<{ from: string; to: string }> = [];
  let redirectsBefore: string | null = null;
  let redirectsChanged = false;

  // Reverses every rename (in reverse order) and restores/removes
  // redirects.json. Attempts everything even if one step fails,
  // reporting every failure - matches publish.ts's rollback()
  // philosophy exactly (a filesystem cannot give a true atomicity
  // guarantee, so the honest contract is "restores everything it can,
  // and is loud if it can't").
  function undoMoveWrites(): unknown[] {
    const restoreFailures: unknown[] = [];

    for (const rename of [...performedRenames].reverse()) {
      try {
        renameSync(rename.to, rename.from);
      } catch (restoreError) {
        restoreFailures.push(restoreError);
      }
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
    mkdirSync(dirname(toPageFile), { recursive: true });
    renameSync(fromPageFile, toPageFile);
    performedRenames.push({ from: fromPageFile, to: toPageFile });

    if (fromDirExists) {
      mkdirSync(dirname(toDir), { recursive: true });
      renameSync(fromDir, toDir);
      performedRenames.push({ from: fromDir, to: toDir });
    }

    redirectsBefore = existsSync(config.redirectsPath)
      ? readFileSync(config.redirectsPath, 'utf-8')
      : null;

    let entries: RedirectEntry[] = loadRedirects(config).entries;
    for (const page of affected) {
      // E5 (move half) must run BEFORE addRedirect, not after: if the
      // destination held a stale redirect (page.newUrl was itself a
      // key), addRedirect's chain-walk would otherwise treat it as a
      // legitimate hop and silently collapse straight through it,
      // rather than the new page superseding it.
      entries = removeRedirectForPath(entries, page.newUrl);
      entries = addRedirect(entries, page.oldUrl, page.newUrl).entries;
    }

    const redirectsAfter = serialiseRedirects(entries);
    if (redirectsAfter !== (redirectsBefore ?? '')) {
      writeFileSync(config.redirectsPath, redirectsAfter);
      redirectsChanged = true;
    }
  } catch (error) {
    // A write-phase failure: roll back immediately, inside prepare
    // itself, and always classify as write-failed - commitPaths hasn't
    // been called yet, so this can never be a GitOperationError.
    const failures = undoMoveWrites();
    if (failures.length > 0) {
      throw new MoveError(
        'rollback-failed',
        'Move failed and rolling back afterwards also failed; the working tree may be inconsistent and needs manual inspection',
        { cause: error },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new MoveError('write-failed', `Move failed: ${detail}`, { cause: error });
  }

  const paths: string[] = [];
  for (const page of affected) {
    paths.push(sanitisePath(config.pagesRoot, page.oldRelativePath));
    paths.push(sanitisePath(config.pagesRoot, page.newRelativePath));
  }
  if (redirectsChanged) {
    paths.push(config.redirectsPath);
  }

  return { paths, undo: undoMoveWrites };
}

async function movePageJob(
  config: SiteConfig,
  fromUrl: string,
  toUrl: string,
  message: string,
  author: CommitAuthor,
): Promise<void> {
  const { paths, undo } = prepareMovePage(config, fromUrl, toUrl);
  try {
    commitPaths(config.siteRoot, paths, message, author);
  } catch (error) {
    const failures = undo();
    if (failures.length > 0) {
      throw new MoveError(
        'rollback-failed',
        'Move failed and rolling back afterwards also failed; the working tree may be inconsistent and needs manual inspection',
        { cause: error },
      );
    }
    // Always commit-failed here, structurally: prepare already
    // succeeded, so anything caught in this try can only have come
    // from commitPaths itself.
    const detail = error instanceof Error ? error.message : String(error);
    throw new MoveError('commit-failed', `Move failed: ${detail}`, { cause: error });
  }
}

export function movePage(
  config: SiteConfig,
  fromUrl: string,
  toUrl: string,
  message: string,
  author: CommitAuthor,
): Promise<void> {
  return enqueue(() => movePageJob(config, fromUrl, toUrl, message, author));
}
