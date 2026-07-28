import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { CHECKPOINT_MESSAGE } from './git-history.ts';
import type { CommitAuthor } from './git.ts';
import { commitPaths } from './git.ts';
import { enqueue } from './write-queue.ts';

// Resolves the checklist's own carried-forward open question 3: the
// same shape of question boot.ts already declined to answer for
// boot-time migrations. A fixed, hardcoded in-code identity - not
// configurable per-site - so this never depends on host config
// (matching the Phase 1 sign-off that commits never fall back to
// ~/.gitconfig), and there's zero possibility of a site operator
// misconfiguring or omitting it.
export const CHECKPOINT_AUTHOR: CommitAuthor = { name: 'CMS Agent', email: 'agent@localhost' };

async function checkpointJob(config: SiteConfig, author: CommitAuthor): Promise<'committed' | 'clean'> {
  // Derived from config.draftsRoot, never a hardcoded literal - Group N
  // nested draftsRoot inside contentRoot (content/drafts), so a fixed
  // 'drafts' pathspec would silently match nothing there, making this
  // checkpoint a permanent no-op with zero error output. Always
  // relative to siteRoot, matching commitPaths'/git status's own
  // pathspec convention below.
  const draftsPathspec = relative(config.siteRoot, config.draftsRoot);

  // "When drafts have changed" (checklist H4) - checked before ever
  // staging/committing, matching the empty-commit lesson batch.ts and
  // git-revert.ts already learned: git commit with nothing staged
  // exits non-zero, which must not surface as a spurious failure for
  // a checkpoint tick that legitimately had nothing to do.
  const status = execFileSync('git', ['status', '--porcelain', '--', draftsPathspec], {
    cwd: config.siteRoot,
  }).toString('utf-8');
  if (status.trim().length === 0) {
    return 'clean';
  }

  // Reuses commitPaths (not commitWorkingTree, which stages the
  // *entire* working tree) - scoped to a single drafts-directory
  // pathspec. Verified empirically that a bare pathspec (no -A flag)
  // correctly stages both modifications and deletions under that
  // directory, essential since a discarded draft (a pure fs removal
  // today, no git call) must be captured by the next checkpoint as a
  // real change, not silently missed.
  commitPaths(config.siteRoot, [draftsPathspec], CHECKPOINT_MESSAGE, author);
  return 'committed';
}

export function runCheckpoint(config: SiteConfig, author: CommitAuthor): Promise<'committed' | 'clean'> {
  return enqueue(() => checkpointJob(config, author));
}
