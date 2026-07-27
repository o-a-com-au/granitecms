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

const CONTROL_CHAR_PATTERN = /[\r\n]/;

// The route layer's shape check for a caller-supplied author before it
// ever reaches `git commit --author` below. execFileSync (not a shell)
// already rules out command injection, but a name/email containing a
// literal newline could still smuggle a malformed or multi-line author
// string into git history - this is the first place in the codebase a
// caller-supplied identity reaches a real commit (saveDraft/discardDraft
// never take an author at all), so this check is new, necessary
// surface, not a repeat of an existing one.
export function isValidCommitAuthor(value: unknown): value is CommitAuthor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { name, email } = value as Record<string, unknown>;
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !CONTROL_CHAR_PATTERN.test(name) &&
    typeof email === 'string' &&
    email.length > 0 &&
    !CONTROL_CHAR_PATTERN.test(email)
  );
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

// Allowlist, not a denylist of "dangerous" characters - the same
// reject-on-ambiguity posture sanitisePath itself uses for paths. A
// denylist (reject leading '-', reject whitespace) is exactly the
// shape of check that's easy to get subtly wrong one case at a time
// (reflog @{...} syntax, ^{...} suffixes, unicode whitespace); this
// closes all of that in one line instead of enumerating each dangerous
// case as it's discovered.
const REF_PATTERN = /^[A-Za-z0-9._/-]+$/;

export function isValidGitRef(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && !value.includes('..') && REF_PATTERN.test(value);
}

// The escape hatch (checklist G5): stages and commits literally
// everything currently changed in the working tree, deliberately
// unscoped - a path-scoped variant would defeat the entire point of
// "out-of-band changes the API doesn't otherwise know about" (build
// plan wording). Respects .gitignore like any git invocation, so
// data/ stays excluded per existing convention.
export function commitWorkingTree(
  cwd: string,
  message: string,
  author: CommitAuthor,
): 'committed' | 'clean' {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd }).toString('utf-8');
  if (status.trim().length === 0) {
    // Nothing to stage - matches batch.ts's empty-commit lesson
    // (git commit with nothing staged exits non-zero), simpler here
    // since there's no path list to check, just the whole tree.
    return 'clean';
  }

  try {
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
  } catch (error) {
    throw new GitOperationError('add-failed', `git add -A failed in ${cwd}`, { cause: error });
  }

  try {
    execFileSync(
      'git',
      ['commit', '-m', message, '--author', `${author.name} <${author.email}>`],
      { cwd, env: authorEnv(author), stdio: 'ignore' },
    );
  } catch (error) {
    try {
      // Bare reset (no path list): unstages everything just added,
      // mirroring commitPaths's own rollback shape.
      execFileSync('git', ['reset'], { cwd, stdio: 'ignore' });
    } catch (resetError) {
      throw new GitOperationError(
        'reset-failed',
        `git commit failed in ${cwd} and unstaging afterwards also failed; index may be inconsistent`,
        { cause: resetError },
      );
    }
    throw new GitOperationError('commit-failed', `git commit failed in ${cwd}`, { cause: error });
  }

  return 'committed';
}
