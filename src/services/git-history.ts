import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { isValidGitRef } from './git.ts';
import { sanitisePath } from './path-safety.ts';

export interface LogEntry {
  hash: string;
  author: { name: string; email: string };
  date: string;
  message: string;
  isCheckpoint: boolean;
}

export interface LogResult {
  commits: LogEntry[];
  hasMore: boolean;
}

const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 500;

// Settled by the build plan itself (docs/cms-build-plan.md): the
// future (not-yet-built) Group H checkpoint job commits drafts/ with
// this literal message. Exact match only, deliberately not a prefix
// match - migration-runner.ts's own automated commit
// ("chore: migrate content to schema version N") is a different,
// meaningful category and must not be flagged as checkpoint noise.
// The checkpoint commit's *author identity* is a separate, still-open
// question (docs/phase-2-checklist.md) this module does not attempt
// to resolve - flagging is by message only.
const CHECKPOINT_MESSAGE = 'chore: draft checkpoint';

const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';

export function getCommitLog(config: SiteConfig, options: { path?: string; limit?: number }): LogResult {
  // A brand-new site's repo can exist (startup-checks.ts already
  // verified it's a real work tree at boot) with zero commits until
  // the first publish/checkpoint/manual commit ever happens. Plain
  // `git log` on a HEAD-less repo exits non-zero ("does not have any
  // commits yet"), which must not surface as an uncaught 500 for what
  // is simply an empty history.
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: config.siteRoot,
      stdio: 'ignore',
    });
  } catch {
    return { commits: [], hasMore: false };
  }

  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LOG_LIMIT), MAX_LOG_LIMIT);
  const args = [
    'log',
    `--format=%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%B${RECORD_SEP}`,
    '-n',
    String(limit + 1),
  ];
  if (options.path) {
    // A bare fs-pathspec (not the <rev>:<path> colon syntax
    // readFileAtRevision below uses), so sanitisePath's absolute
    // return value is used directly - git resolves an absolute
    // pathspec fine, same as git.ts's own `git add -- <absolutePaths>`
    // already relies on.
    args.push('--', sanitisePath(config.siteRoot, options.path));
  }

  const raw = execFileSync('git', args, { cwd: config.siteRoot }).toString('utf-8');
  const parsed = parseLogOutput(raw);
  return { commits: parsed.slice(0, limit), hasMore: parsed.length > limit };
}

function parseLogOutput(raw: string): LogEntry[] {
  return raw
    .split(RECORD_SEP)
    // `--format=` is shorthand for `--pretty=tformat:`, which appends
    // its own newline terminator after EVERY record, including after
    // our own literal RECORD_SEP - that terminator lands as a leading
    // "\n" on the *next* record, not a trailing one on the record it
    // belongs to. Verified empirically against a real multi-commit
    // repo (including a commit with an embedded multi-line message)
    // before trusting this: without stripping it, every commit but the
    // first silently fails to parse, since the leading \n corrupts the
    // hash field.
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash, name, email, date, ...rest] = record.split(FIELD_SEP);
      // Defensive rejoin: FIELD_SEP is "unlikely" to appear inside a
      // real commit message, not impossible. If it ever does, this
      // keeps the message intact rather than corrupting every field
      // after it.
      const message = rest.join(FIELD_SEP).trimEnd();
      return {
        hash: hash ?? '',
        author: { name: name ?? '', email: email ?? '' },
        date: date ?? '',
        message,
        isCheckpoint: message === CHECKPOINT_MESSAGE,
      };
    });
}

export type GitShowReason = 'invalid-ref' | 'not-found-at-ref';

export class GitShowError extends Error {
  readonly reason: GitShowReason;

  constructor(reason: GitShowReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GitShowError';
    this.reason = reason;
  }
}

export function readFileAtRevision(config: SiteConfig, ref: string, relativePath: string): Buffer {
  if (!isValidGitRef(ref)) {
    throw new GitShowError('invalid-ref', `Invalid ref: "${ref}"`);
  }

  // The <rev>:<path> colon syntax below resolves <path> relative to
  // cwd (config.siteRoot), never as a literal absolute filesystem path
  // - unlike getCommitLog's `--` pathspec above. Re-deriving the
  // repo-relative string from sanitisePath's own already-validated
  // absolute result (not re-decoding relativePath a second time)
  // guarantees the exact same string sanitisePath vetted.
  const repoRelativePath = relative(config.siteRoot, sanitisePath(config.siteRoot, relativePath));

  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: config.siteRoot,
      stdio: 'ignore',
    });
  } catch {
    throw new GitShowError('invalid-ref', `Ref does not resolve to a commit: "${ref}"`);
  }

  let objectType: string;
  try {
    objectType = execFileSync('git', ['cat-file', '-t', `${ref}:${repoRelativePath}`], {
      cwd: config.siteRoot,
    })
      .toString('utf-8')
      .trim();
  } catch {
    throw new GitShowError('not-found-at-ref', `No file at "${relativePath}" at revision "${ref}"`);
  }
  // A directory (tree) at that ref must not fall through to `git show`,
  // which would print a plain-text directory listing as if it were
  // file content, with a wrong Content-Type. This route serves file
  // content only.
  if (objectType !== 'blob') {
    throw new GitShowError('not-found-at-ref', `"${relativePath}" is not a file at revision "${ref}"`);
  }

  return execFileSync('git', ['show', `${ref}:${repoRelativePath}`], { cwd: config.siteRoot });
}
