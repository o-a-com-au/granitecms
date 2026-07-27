import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { RevertError, revertPaths } from '../../src/services/git-revert.ts';
import { createTmpSiteRoot, writeAndCommit } from '../helpers/tmp-site.ts';

const author = { name: 'Jane Editor', email: 'jane@example.com' };

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

test('G4: reverting a path restores its content from the given revision as one new commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', '{"title":"v1"}', 'v1');
    const v1Hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot }).toString('utf-8').trim();
    writeAndCommit(siteRoot, 'content/pages/about.json', '{"title":"v2"}', 'v2');
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await revertPaths(config, v1Hash, ['content/pages/about.json'], 'revert about to v1', author);

    assert.equal(
      readFileSync(join(config.pagesRoot, 'about.json'), 'utf-8'),
      '{"title":"v1"}',
    );
    assert.equal(commitCount(siteRoot), before + 1, 'exactly one new commit');
  } finally {
    cleanup();
  }
});

test('reverting multiple paths in one call restores all of them in a single commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', '{"n":"a1"}', 'about v1');
    writeAndCommit(siteRoot, 'content/pages/contact.json', '{"n":"c1"}', 'contact v1');
    const v1Hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot }).toString('utf-8').trim();
    writeAndCommit(siteRoot, 'content/pages/about.json', '{"n":"a2"}', 'about v2');
    writeAndCommit(siteRoot, 'content/pages/contact.json', '{"n":"c2"}', 'contact v2');
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await revertPaths(
      config,
      v1Hash,
      ['content/pages/about.json', 'content/pages/contact.json'],
      'revert both to v1',
      author,
    );

    assert.equal(readFileSync(join(config.pagesRoot, 'about.json'), 'utf-8'), '{"n":"a1"}');
    assert.equal(readFileSync(join(config.pagesRoot, 'contact.json'), 'utf-8'), '{"n":"c1"}');
    assert.equal(commitCount(siteRoot), before + 1);
  } finally {
    cleanup();
  }
});

test('reverting to the currently-live content is a no-op: no commit is created, not an error', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', '{"title":"only"}', 'only version');
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await revertPaths(config, 'HEAD', ['content/pages/about.json'], 'revert to head', author);

    assert.equal(commitCount(siteRoot), before, 'reverting to the already-live content creates no commit');
  } finally {
    cleanup();
  }
});

test('a path absent at the given revision fails with path-not-found-at-ref and leaves the other path untouched', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', '{"n":"a1"}', 'about v1');
    const v1Hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot }).toString('utf-8').trim();
    writeAndCommit(siteRoot, 'content/pages/contact.json', '{"n":"c1"}', 'add contact');
    writeAndCommit(siteRoot, 'content/pages/about.json', '{"n":"a2"}', 'about v2');
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await assert.rejects(
      revertPaths(
        config,
        v1Hash,
        ['content/pages/about.json', 'content/pages/contact.json'],
        'revert both',
        author,
      ),
      (error: unknown) => error instanceof RevertError && error.reason === 'path-not-found-at-ref',
    );

    assert.equal(
      readFileSync(join(config.pagesRoot, 'about.json'), 'utf-8'),
      '{"n":"a2"}',
      'about.json must be untouched since the whole revert failed validation before any checkout',
    );
    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test('an invalid ref is rejected before touching any file', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', '{"n":"a1"}', 'about v1');
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await assert.rejects(
      revertPaths(config, '--upload-pack=/bin/sh', ['content/pages/about.json'], 'x', author),
      (error: unknown) => error instanceof RevertError && error.reason === 'invalid-ref',
    );
    await assert.rejects(
      revertPaths(config, 'not-a-real-ref', ['content/pages/about.json'], 'x', author),
      (error: unknown) => error instanceof RevertError && error.reason === 'invalid-ref',
    );

    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test('rollback-on-commit-failure: a real git failure after checkout rolls back file content, no commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', '{"title":"v1"}', 'v1');
    const v1Hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot }).toString('utf-8').trim();
    writeAndCommit(siteRoot, 'content/pages/about.json', '{"title":"v2"}', 'v2');
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    const lockPath = join(siteRoot, '.git', 'index.lock');
    writeFileSync(lockPath, '');
    try {
      await assert.rejects(
        revertPaths(config, v1Hash, ['content/pages/about.json'], 'revert to v1', author),
        (error: unknown) => error instanceof RevertError,
      );
    } finally {
      execFileSync('rm', ['-f', lockPath]);
    }

    assert.equal(
      readFileSync(join(config.pagesRoot, 'about.json'), 'utf-8'),
      '{"title":"v2"}',
      'file content must be restored to what it was before the revert attempt',
    );
    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test('reverting a path that was later deleted restores (recreates) the file', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', '{"title":"existed"}', 'add about');
    const v1Hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot }).toString('utf-8').trim();
    execFileSync('git', ['rm', '-q', 'content/pages/about.json'], { cwd: siteRoot });
    execFileSync('git', ['commit', '-m', 'remove about'], {
      cwd: siteRoot,
      env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x.com', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x.com' },
      stdio: 'ignore',
    });
    const config = loadSiteConfig(siteRoot);
    assert.equal(existsSync(join(config.pagesRoot, 'about.json')), false);

    await revertPaths(config, v1Hash, ['content/pages/about.json'], 'restore about', author);

    assert.equal(readFileSync(join(config.pagesRoot, 'about.json'), 'utf-8'), '{"title":"existed"}');
  } finally {
    cleanup();
  }
});
