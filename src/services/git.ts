import { execFileSync } from 'node:child_process';

export type GitOperationReason = 'add-failed' | 'commit-failed' | 'reset-failed';

export class GitOperationError extends Error {
  readonly reason: GitOperationReason;

  constructor(reason: GitOperationReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GitOperationError';
    this.reason = reason;
  }
}

export interface CommitAuthor {
  name: string;
  email: string;
}

// Author identity always comes from the caller, never host config
// (constraint: commit authorship passthrough, checklist C5). Passing
// GIT_AUTHOR_*/GIT_COMMITTER_* explicitly means this never depends on
// ~/.gitconfig or any host identity being configured at all, which also
// retires the "usable identity config" startup prerequisite entirely
// rather than merely deferring it.
function authorEnv(author: CommitAuthor): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}

// Guarantees its own all-or-nothing contract: either fully committed,
// or nothing left staged. Callers (publish.ts) therefore only ever need
// to reason about filesystem state on failure, never git staging state.
export function commitPaths(
  cwd: string,
  paths: string[],
  message: string,
  author: CommitAuthor,
): void {
  try {
    execFileSync('git', ['add', '--', ...paths], { cwd, stdio: 'ignore' });
  } catch (error) {
    throw new GitOperationError('add-failed', `git add failed in ${cwd}`, { cause: error });
  }

  try {
    execFileSync('git', ['commit', '-m', message, '--author', `${author.name} <${author.email}>`], {
      cwd,
      env: authorEnv(author),
      stdio: 'ignore',
    });
  } catch (error) {
    try {
      execFileSync('git', ['reset', '--', ...paths], { cwd, stdio: 'ignore' });
    } catch (resetError) {
      throw new GitOperationError(
        'reset-failed',
        `git commit failed in ${cwd} and unstaging afterwards also failed; index may be inconsistent`,
        { cause: resetError },
      );
    }
    throw new GitOperationError('commit-failed', `git commit failed in ${cwd}`, { cause: error });
  }
}

export function resetPaths(cwd: string, paths: string[]): void {
  try {
    execFileSync('git', ['reset', '--', ...paths], { cwd, stdio: 'ignore' });
  } catch (error) {
    throw new GitOperationError('reset-failed', `git reset failed in ${cwd}`, { cause: error });
  }
}
