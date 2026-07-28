import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { SiteConfig } from '../config.ts';
import { commitPaths } from './git.ts';
import type { CommitAuthor } from './git.ts';
import { sanitisePath } from './path-safety.ts';
import { isBlogUrl, urlToPostPath } from './post-urls.ts';
import type { PreparedOperation } from './prepared-operation.ts';
import {
  RedirectError,
  addRedirect,
  isValidRedirectTarget,
  loadRedirectsStrict,
  removeRedirectForPath,
  serialiseRedirects,
} from './redirects.ts';
import type { RedirectEntry } from './redirects.ts';
import { urlToPagePath } from './urls.ts';
import { enqueue } from './write-queue.ts';

export type ManageRedirectReason =
  | 'invalid-from'
  | 'invalid-target'
  | 'already-exists'
  | 'not-found'
  | 'live-content-exists'
  | 'redirect-cycle'
  | 'malformed-file'
  | 'write-failed'
  | 'commit-failed'
  | 'rollback-failed';

export class ManageRedirectError extends Error {
  readonly reason: ManageRedirectReason;

  constructor(reason: ManageRedirectReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ManageRedirectError';
    this.reason = reason;
  }
}

export interface RedirectMutationResult {
  entry: RedirectEntry;
  // Existing entries whose `to` was silently rewritten by chain-
  // collapse as a side effect of this write - surfaced so a marketing
  // manager can see that other redirects were also repointed, rather
  // than a note-bearing entry changing target with no visible signal.
  retargeted: RedirectEntry[];
}

// Not required for correctness (resolve-url.ts/resolve-blog-url.ts
// already guarantee live content always wins over a redirect at the
// same URL), but rejecting here avoids a marketing manager creating a
// redirect that would silently never fire.
function liveContentExistsAt(config: SiteConfig, url: string): boolean {
  const pageFile = sanitisePath(config.pagesRoot, urlToPagePath(url));
  if (existsSync(pageFile)) {
    return true;
  }
  if (isBlogUrl(url) && existsSync(config.postsRoot)) {
    const postRelative = urlToPostPath(url);
    if (postRelative !== null && existsSync(sanitisePath(config.postsRoot, postRelative))) {
      return true;
    }
  }
  return false;
}

function validateFromAndTo(from: string, to: string): void {
  if (!isValidRedirectTarget(from)) {
    throw new ManageRedirectError('invalid-from', `"from" must be an internal path starting with "/", got "${from}"`);
  }
  if (!isValidRedirectTarget(to)) {
    throw new ManageRedirectError('invalid-target', `"to" must be an internal path starting with "/", got "${to}"`);
  }
}

function readRedirectsSnapshot(config: SiteConfig): { existed: boolean; original: string } {
  const existed = existsSync(config.redirectsPath);
  return { existed, original: existed ? readFileSync(config.redirectsPath, 'utf-8') : '' };
}

function undoRedirectsWrite(config: SiteConfig, snapshot: { existed: boolean; original: string }): unknown[] {
  const failures: unknown[] = [];
  try {
    if (snapshot.existed) {
      writeFileSync(config.redirectsPath, snapshot.original);
    } else {
      rmSync(config.redirectsPath, { force: true });
    }
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

function loadEntriesOrThrow(config: SiteConfig): RedirectEntry[] {
  try {
    return loadRedirectsStrict(config).entries;
  } catch (error) {
    if (error instanceof RedirectError) {
      throw new ManageRedirectError('malformed-file', error.message, { cause: error });
    }
    throw error;
  }
}

export function prepareCreateRedirect(
  config: SiteConfig,
  from: string,
  to: string,
  note: string | undefined,
): PreparedOperation & { result: RedirectMutationResult } {
  validateFromAndTo(from, to);

  const entries = loadEntriesOrThrow(config);
  if (entries.some((entry) => entry.from === from)) {
    throw new ManageRedirectError('already-exists', `A redirect already exists for "${from}"`);
  }
  if (liveContentExistsAt(config, from)) {
    throw new ManageRedirectError(
      'live-content-exists',
      `"${from}" already has live content; a redirect there would never take effect`,
    );
  }

  const snapshot = readRedirectsSnapshot(config);
  let addResult;
  try {
    addResult = addRedirect(entries, from, to, note);
  } catch (error) {
    if (error instanceof RedirectError) {
      throw new ManageRedirectError('redirect-cycle', error.message, { cause: error });
    }
    throw error;
  }

  writeFileSync(config.redirectsPath, serialiseRedirects(addResult.entries));

  const createdEntry = addResult.entries.find((entry) => entry.from === from);
  if (!createdEntry) {
    throw new Error('addRedirect did not produce the expected entry - this is a bug');
  }

  return {
    paths: [config.redirectsPath],
    undo: () => undoRedirectsWrite(config, snapshot),
    result: { entry: createdEntry, retargeted: addResult.retargeted },
  };
}

export function prepareUpdateRedirect(
  config: SiteConfig,
  from: string,
  to: string,
  note: string | undefined,
): PreparedOperation & { result: RedirectMutationResult } {
  validateFromAndTo(from, to);

  const entries = loadEntriesOrThrow(config);
  if (!entries.some((entry) => entry.from === from)) {
    throw new ManageRedirectError('not-found', `No redirect exists for "${from}"`);
  }

  const snapshot = readRedirectsSnapshot(config);
  let addResult;
  try {
    addResult = addRedirect(entries, from, to, note);
  } catch (error) {
    if (error instanceof RedirectError) {
      throw new ManageRedirectError('redirect-cycle', error.message, { cause: error });
    }
    throw error;
  }

  writeFileSync(config.redirectsPath, serialiseRedirects(addResult.entries));

  const updatedEntry = addResult.entries.find((entry) => entry.from === from);
  if (!updatedEntry) {
    throw new Error('addRedirect did not produce the expected entry - this is a bug');
  }

  return {
    paths: [config.redirectsPath],
    undo: () => undoRedirectsWrite(config, snapshot),
    result: { entry: updatedEntry, retargeted: addResult.retargeted },
  };
}

export function prepareDeleteRedirect(config: SiteConfig, from: string): PreparedOperation {
  const entries = loadEntriesOrThrow(config);
  if (!entries.some((entry) => entry.from === from)) {
    throw new ManageRedirectError('not-found', `No redirect exists for "${from}"`);
  }

  const snapshot = readRedirectsSnapshot(config);
  const updated = removeRedirectForPath(entries, from);
  writeFileSync(config.redirectsPath, serialiseRedirects(updated));

  return {
    paths: [config.redirectsPath],
    undo: () => undoRedirectsWrite(config, snapshot),
  };
}

async function runRedirectJob<T>(
  config: SiteConfig,
  prepare: () => PreparedOperation & { result?: T },
  message: string,
  author: CommitAuthor,
): Promise<T | undefined> {
  const prepared = prepare();
  try {
    commitPaths(config.siteRoot, prepared.paths, message, author);
  } catch (error) {
    const failures = prepared.undo();
    if (failures.length > 0) {
      throw new ManageRedirectError(
        'rollback-failed',
        'Redirect write failed and rolling back afterwards also failed; the working tree may be inconsistent and needs manual inspection',
        { cause: error },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ManageRedirectError('commit-failed', `Redirect write failed: ${detail}`, { cause: error });
  }
  return prepared.result;
}

export function createRedirect(
  config: SiteConfig,
  from: string,
  to: string,
  note: string | undefined,
  message: string,
  author: CommitAuthor,
): Promise<RedirectMutationResult | undefined> {
  return enqueue(() => runRedirectJob(config, () => prepareCreateRedirect(config, from, to, note), message, author));
}

export function updateRedirect(
  config: SiteConfig,
  from: string,
  to: string,
  note: string | undefined,
  message: string,
  author: CommitAuthor,
): Promise<RedirectMutationResult | undefined> {
  return enqueue(() => runRedirectJob(config, () => prepareUpdateRedirect(config, from, to, note), message, author));
}

export function deleteRedirect(
  config: SiteConfig,
  from: string,
  message: string,
  author: CommitAuthor,
): Promise<undefined> {
  return enqueue(() => runRedirectJob(config, () => prepareDeleteRedirect(config, from), message, author));
}
