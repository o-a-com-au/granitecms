import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitPaths, commitWorkingTree, isValidGitRef, resetPaths } from '../../src/services/git.ts';
import { createTmpSiteRoot } from '../helpers/tmp-site.ts';

function log(cwd: string, format: string): string {
  return execFileSync('git', ['log', '-1', `--format=${format}`], { cwd }).toString('utf-8').trim();
}

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

test('isValidGitRef accepts ordinary branch/tag/hash-shaped refs', () => {
  assert.equal(isValidGitRef('main'), true);
  assert.equal(isValidGitRef('HEAD'), true);
  assert.equal(isValidGitRef('v1.2.3'), true);
  assert.equal(isValidGitRef('a1b2c3d'), true);
  assert.equal(isValidGitRef('feature/my-branch'), true);
});

test('isValidGitRef rejects flag-injection-shaped, traversal-shaped, and empty refs', () => {
  assert.equal(isValidGitRef('--upload-pack=/bin/sh'), false);
  assert.equal(isValidGitRef('-x'), false);
  assert.equal(isValidGitRef('a..b'), false);
  assert.equal(isValidGitRef(''), false);
  assert.equal(isValidGitRef('has spaces'), false);
  assert.equal(isValidGitRef('has\ttab'), false);
});

test('commitWorkingTree stages and commits everything currently changed, with the supplied author', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true });
  try {
    // A brand-new repo has zero commits until this call - git log
    // would throw on a HEAD-less repo, so there is no "before" count
    // to take here (the same edge case getCommitLog itself must guard
    // against in git-history.ts).
    writeFileSync(join(siteRoot, 'manual-edit.json'), '{"out":"of band"}');

    const result = commitWorkingTree(siteRoot, 'manual fix', { name: 'Jane Editor', email: 'jane@example.com' });

    assert.equal(result, 'committed');
    assert.equal(commitCount(siteRoot), 1);
    assert.equal(log(siteRoot, '%an'), 'Jane Editor');
    assert.equal(log(siteRoot, '%s'), 'manual fix');
  } finally {
    cleanup();
  }
});

test('commitWorkingTree on a clean tree creates no commit and returns "clean"', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true });
  try {
    writeFileSync(join(siteRoot, 'page.json'), '{}');
    execFileSync('git', ['add', '-A'], { cwd: siteRoot });
    execFileSync('git', ['commit', '-m', 'seed'], {
      cwd: siteRoot,
      env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x.com', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x.com' },
      stdio: 'ignore',
    });
    const before = commitCount(siteRoot);

    const result = commitWorkingTree(siteRoot, 'no-op', { name: 'Jane Editor', email: 'jane@example.com' });

    assert.equal(result, 'clean');
    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test('commitWorkingTree respects .gitignore, same as any git invocation', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true });
  try {
    writeFileSync(join(siteRoot, '.gitignore'), 'data/\n');
    execFileSync('git', ['add', '-A'], { cwd: siteRoot });
    execFileSync('git', ['commit', '-m', 'seed'], {
      cwd: siteRoot,
      env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x.com', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x.com' },
      stdio: 'ignore',
    });
    mkdirSyncRecursive(join(siteRoot, 'data'));
    writeFileSync(join(siteRoot, 'data', 'search-index.sqlite'), 'binary-ish content');
    writeFileSync(join(siteRoot, 'tracked.json'), '{"real":"change"}');

    const result = commitWorkingTree(siteRoot, 'commit real change only', {
      name: 'Jane Editor',
      email: 'jane@example.com',
    });

    assert.equal(result, 'committed');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: siteRoot }).toString('utf-8').trim();
    assert.equal(status, '', 'the gitignored data/ file must never be staged or shown as untracked-but-changed');
  } finally {
    cleanup();
  }
});

function mkdirSyncRecursive(dir: string): void {
  execFileSync('mkdir', ['-p', dir]);
}

test('commitWorkingTree rolls back the index (unstages) on a real commit failure, leaving working-tree content untouched', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true });
  try {
    writeFileSync(join(siteRoot, 'page.json'), '{}');
    execFileSync('git', ['add', '-A'], { cwd: siteRoot });
    execFileSync('git', ['commit', '-m', 'seed'], {
      cwd: siteRoot,
      env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x.com', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x.com' },
      stdio: 'ignore',
    });
    writeFileSync(join(siteRoot, 'page.json'), '{"changed":true}');
    const before = commitCount(siteRoot);

    const lockPath = join(siteRoot, '.git', 'index.lock');
    writeFileSync(lockPath, '');
    try {
      assert.throws(() =>
        commitWorkingTree(siteRoot, 'will fail', { name: 'Jane Editor', email: 'jane@example.com' }),
      );
    } finally {
      execFileSync('rm', ['-f', lockPath]);
    }

    assert.equal(commitCount(siteRoot), before, 'no commit should be created');
    assert.equal(readFileSync(join(siteRoot, 'page.json'), 'utf-8'), '{"changed":true}', 'working tree content is untouched');
  } finally {
    cleanup();
  }
});

test('commitPaths produces exactly one commit with the supplied author, not a fixed agent identity', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true });
  try {
    writeFileSync(join(siteRoot, 'page.json'), '{"hello":"world"}');

    commitPaths(siteRoot, ['page.json'], 'add page', { name: 'Jane Editor', email: 'jane@example.com' });

    assert.equal(log(siteRoot, '%an'), 'Jane Editor');
    assert.equal(log(siteRoot, '%ae'), 'jane@example.com');
    assert.equal(log(siteRoot, '%cn'), 'Jane Editor');
    assert.equal(log(siteRoot, '%ce'), 'jane@example.com');
    assert.equal(execFileSync('git', ['log', '--oneline'], { cwd: siteRoot }).toString('utf-8').trim().split('\n').length, 1);
  } finally {
    cleanup();
  }
});

test('commitPaths succeeds even with no host git identity configured (HOME redirected to an empty dir)', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true });
  const emptyHome = mkdtempSync(join(tmpdir(), 'cms-agent-test-empty-home-'));
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = emptyHome;
    writeFileSync(join(siteRoot, 'page.json'), '{}');

    assert.doesNotThrow(() =>
      commitPaths(siteRoot, ['page.json'], 'add page', { name: 'Jane Editor', email: 'jane@example.com' }),
    );
    assert.equal(log(siteRoot, '%an'), 'Jane Editor');
  } finally {
    process.env.HOME = originalHome;
    cleanup();
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test('resetPaths unstages a path without touching working tree content', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true });
  try {
    writeFileSync(join(siteRoot, 'page.json'), '{"staged":true}');
    execFileSync('git', ['add', 'page.json'], { cwd: siteRoot });

    resetPaths(siteRoot, ['page.json']);

    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: siteRoot })
      .toString('utf-8')
      .trim();
    assert.equal(staged, '');
    assert.equal(readFileSync(join(siteRoot, 'page.json'), 'utf-8'), '{"staged":true}');
  } finally {
    cleanup();
  }
});
