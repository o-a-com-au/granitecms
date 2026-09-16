import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SiteConfig } from '../../src/config.ts';
import { loadRedirects } from '../../src/services/redirects.ts';

export interface TmpSite {
  siteRoot: string;
  cleanup: () => void;
}

// Exported so any test that needs to make its own raw git commit (not
// through writeAndCommit or the app's own commitPaths, both of which
// already pass this) can too - a bare `git commit` with no identity
// works silently on any machine with global git config already set,
// but fails outright on a clean CI runner with none ("Author identity
// unknown"). Discovered via a real CI run, not a local one.
export const TEST_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'Test Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Test Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

// A real directory outside the repo (mkdtemp under os.tmpdir()), never a
// checked-in fixture: a symlink pointing outside the repo doesn't belong
// in git history, and this also proves config loading doesn't secretly
// depend on being run from inside this repo.
export function createTmpSiteRoot(
  options: { git?: boolean; contentDirs?: boolean } = {},
): TmpSite {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-test-'));

  if (options.git) {
    execFileSync('git', ['init', '--quiet'], { cwd: siteRoot });
    // Turn off automatic garbage collection in fixture repos. `git
    // commit` can spawn a detached `git gc --auto` that keeps writing
    // into .git after the commit command has already returned, which
    // then races this fixture's own cleanup below: rmSync walks the
    // tree, gc creates a file in a directory rmSync has just emptied,
    // and the remove fails with ENOTEMPTY. Seen as a genuinely
    // intermittent failure (roughly one run in five) in the
    // commit-heavy move tests, always in teardown rather than in an
    // assertion. gc.autoDetach alone would only make the gc run in the
    // foreground; gc.auto 0 stops it being scheduled at all, which is
    // what a short-lived fixture repo wants.
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: siteRoot });
    execFileSync('git', ['config', 'gc.autoDetach', 'false'], { cwd: siteRoot });
  }

  if (options.contentDirs) {
    // sanitisePath unconditionally realpaths its root argument, so
    // content/drafts/theme must exist on disk before a test calls it
    // against config.contentRoot etc, or a raw ENOENT surfaces instead
    // of a clean PathSafetyError for reasons unrelated to the test.
    // drafts nests inside content/ (Group N), not a sibling of it.
    for (const dir of ['content', 'content/pages', 'content/drafts', 'theme', 'theme/assets', 'media']) {
      mkdirSync(join(siteRoot, dir), { recursive: true });
    }
  }

  return {
    siteRoot,
    // maxRetries as well as the gc.auto fix above, not instead of it:
    // Node retries specifically on EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM
    // with a linear backoff, which covers any other process that
    // happens to touch the tree mid-delete (a watcher, an indexer)
    // rather than only the git gc case now ruled out at the source.
    cleanup: () => rmSync(siteRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  };
}

// Seeds a real, committed file at siteRoot/relativePath using a fixed
// test identity, independent of commitPaths under test elsewhere: for
// giving publish/rollback tests something real to overwrite and diff
// against, and a real HEAD to reset back to.
export function writeAndCommit(
  siteRoot: string,
  relativePath: string,
  contents: string,
  message = 'seed fixture content',
): void {
  const fullPath = join(siteRoot, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
  execFileSync('git', ['add', '--', relativePath], { cwd: siteRoot });
  execFileSync('git', ['commit', '-m', message], {
    cwd: siteRoot,
    env: { ...process.env, ...TEST_IDENTITY_ENV },
    stdio: 'ignore',
  });
}

// Plain write, no git: for tests that never need a commit (e.g. the
// renderer, which only reads content/drafts and never mutates git).
export function writeJson(siteRoot: string, relativePath: string, content: unknown): void {
  const fullPath = join(siteRoot, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(content, null, 2));
}

// Convenience for tests asserting on a single redirect's target,
// avoiding every call site re-deriving a lookup from redirects.json's
// entries[] shape.
export function redirectTargetFor(config: SiteConfig, from: string): string | undefined {
  return loadRedirects(config).entries.find((entry) => entry.from === from)?.to;
}
