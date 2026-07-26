import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TmpSite {
  siteRoot: string;
  cleanup: () => void;
}

const TEST_IDENTITY_ENV = {
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
  }

  if (options.contentDirs) {
    // sanitisePath unconditionally realpaths its root argument, so
    // content/drafts/theme must exist on disk before a test calls it
    // against config.contentRoot etc, or a raw ENOENT surfaces instead
    // of a clean PathSafetyError for reasons unrelated to the test.
    for (const dir of ['content', 'content/pages', 'drafts', 'theme']) {
      mkdirSync(join(siteRoot, dir), { recursive: true });
    }
  }

  return {
    siteRoot,
    cleanup: () => rmSync(siteRoot, { recursive: true, force: true }),
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
