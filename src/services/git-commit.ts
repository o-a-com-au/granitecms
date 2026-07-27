import type { SiteConfig } from '../config.ts';
import type { CommitAuthor } from './git.ts';
import { commitWorkingTree } from './git.ts';
import { enqueue } from './write-queue.ts';

// The escape hatch (checklist G5). No PreparedOperation/undo-stack
// here, unlike publish/move/delete/revert: those services write new
// content themselves on request, so a write can fail independently of
// the git step, needing an undo. Here the "write" already exists in
// the working tree before this is ever called - the only failure
// modes are git add/git commit themselves, which commitWorkingTree's
// own bare `git reset` already unwinds (git.ts).
export function commitWorkingTreeChanges(
  config: SiteConfig,
  message: string,
  author: CommitAuthor,
): Promise<'committed' | 'clean'> {
  return enqueue(() => Promise.resolve(commitWorkingTree(config.siteRoot, message, author)));
}
