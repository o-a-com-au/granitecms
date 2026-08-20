import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { ContentReadError, readContentFile } from './content-read.ts';
import { computeEtag, etagsMatch } from './etag.ts';
import type { CommitAuthor } from './git.ts';
import { commitPaths } from './git.ts';
import { sanitisePath } from './path-safety.ts';
import { validateMenu } from './validation.ts';
import { enqueue } from './write-queue.ts';

export type ManageMenuReason =
  | 'validation-failed'
  | 'conflict'
  | 'write-failed'
  | 'commit-failed'
  | 'rollback-failed';

export class ManageMenuError extends Error {
  readonly reason: ManageMenuReason;

  constructor(reason: ManageMenuReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ManageMenuError';
    this.reason = reason;
  }
}

// Mirrors drafts.ts's readCurrentEtag, narrowed to a single root since
// menus have no draft state to prefer over live.
function readCurrentEtag(config: SiteConfig, relativePath: string): string | null {
  try {
    return readContentFile(config.menusRoot, relativePath).etag;
  } catch (error) {
    if (!(error instanceof ContentReadError) || error.reason !== 'not-found') {
      throw error;
    }
    return null;
  }
}

async function saveMenuJob(
  config: SiteConfig,
  relativePath: string,
  content: unknown,
  expectedEtag: string,
  message: string,
  author: CommitAuthor,
): Promise<string> {
  // menusRoot is optional, unlike pagesRoot - a site that has never
  // had a menu has no content/menus/ at all. sanitisePath unconditionally
  // realpaths its root argument, so it must exist before the very
  // first menu is ever created, or a legitimate first-write crashes
  // with a raw ENOENT instead of just creating the directory.
  mkdirSync(config.menusRoot, { recursive: true });
  const menuPath = sanitisePath(config.menusRoot, relativePath);

  // The If-Match check happens here, inside the queued job, never at
  // the route layer before enqueuing - same TOCTOU reasoning as
  // drafts.ts's saveDraftJob (a route-layer check-then-enqueue has a
  // real, empirically-verified gap; the same check run inside the job
  // does not).
  const currentEtag = readCurrentEtag(config, relativePath);
  if (currentEtag !== null && !etagsMatch(currentEtag, expectedEtag)) {
    throw new ManageMenuError(
      'conflict',
      `If-Match "${expectedEtag}" does not match the current ETag for "${relativePath}"`,
    );
  }
  // currentEtag === null means no menu exists yet at this path (a
  // brand-new menu) - matches saveDraftJob's own precedent of skipping
  // the comparison for a wholly new resource.

  const result = validateMenu(content);
  if (!result.valid) {
    throw new ManageMenuError(
      'validation-failed',
      `Menu at "${relativePath}" failed validation: ${JSON.stringify(result.errors)}`,
    );
  }

  const existedBefore = existsSync(menuPath);
  const originalBytes = existedBefore ? readFileSync(menuPath) : null;

  mkdirSync(dirname(menuPath), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(content, null, 2));
  writeFileSync(menuPath, bytes);

  // No draft state (Group N: menus behave like redirects.json) -
  // commits immediately, mirroring manage-redirects.ts's shape, rather
  // than drafts.ts's write-with-no-commit.
  try {
    commitPaths(config.siteRoot, [menuPath], message, author);
  } catch (error) {
    try {
      if (existedBefore) {
        writeFileSync(menuPath, originalBytes as Buffer);
      } else {
        unlinkSync(menuPath);
      }
    } catch (rollbackError) {
      throw new ManageMenuError(
        'rollback-failed',
        'Menu save failed and rolling back afterwards also failed; the working tree may be inconsistent and needs manual inspection',
        { cause: rollbackError },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ManageMenuError('commit-failed', `Menu save failed: ${detail}`, { cause: error });
  }

  return computeEtag(bytes);
}

export function saveMenu(
  config: SiteConfig,
  relativePath: string,
  content: unknown,
  expectedEtag: string,
  message: string,
  author: CommitAuthor,
): Promise<string> {
  return enqueue(() => saveMenuJob(config, relativePath, content, expectedEtag, message, author));
}
