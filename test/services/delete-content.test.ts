import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { DeleteContentError, deleteContent } from '../../src/services/delete-content.ts';
import { loadRedirects } from '../../src/services/redirects.ts';
import { createTmpSiteRoot, redirectTargetFor, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

const author = { name: 'Jane Editor', email: 'jane@example.com' };

function pageJson(title: string): string {
  return JSON.stringify({ schemaVersion: 1, title, type: 'page', published: true, sections: [] });
}

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

test('F3: deleting a live page removes the file and creates one commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await deleteContent(config, 'pages/about.json', undefined, 'delete about', author);

    assert.equal(existsSync(join(config.pagesRoot, 'about.json')), false);
    assert.equal(commitCount(siteRoot), before + 1);
  } finally {
    cleanup();
  }
});

test('F3: deleting a live page with a redirectTo records a redirect in the same commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await deleteContent(config, 'pages/about.json', '/company', 'delete about, redirect to company', author);

    assert.equal(redirectTargetFor(config, '/about'), '/company');
    assert.equal(commitCount(siteRoot), before + 1, 'redirect must land in the same commit as the delete');
  } finally {
    cleanup();
  }
});

function postJson(title: string): string {
  return JSON.stringify({
    schemaVersion: 4,
    title,
    type: 'post',
    layout: 'theme',
    published: true,
    author: 'Jane Editor',
    publishDate: '2026-07-27',
    tags: [],
    sections: [],
  });
}

test('deleting a post with a redirectTo records a /blog/-shaped redirect, same as a page', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/posts/hello-world.json', postJson('Hello World'));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await deleteContent(config, 'posts/hello-world.json', '/blog/moved', 'delete post, redirect', author);

    assert.equal(redirectTargetFor(config, '/blog/hello-world'), '/blog/moved');
    assert.equal(commitCount(siteRoot), before + 1);
  } finally {
    cleanup();
  }
});

test('deleting a menu with a redirectTo records no redirect (menus have no public URL)', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/menus/main.json', JSON.stringify({ schemaVersion: 1, items: [] }));
    const config = loadSiteConfig(siteRoot);

    await deleteContent(config, 'menus/main.json', '/somewhere', 'delete menu', author);

    assert.deepEqual(loadRedirects(config), { schemaVersion: 1, entries: [] });
  } finally {
    cleanup();
  }
});

test('deleting a page with an external redirectTo is rejected with invalid-redirect-target, not silently accepted', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    const config = loadSiteConfig(siteRoot);

    await assert.rejects(
      deleteContent(config, 'pages/about.json', 'https://example.com', 'delete about', author),
      (error: unknown) => error instanceof DeleteContentError && error.reason === 'invalid-redirect-target',
    );
    assert.ok(existsSync(join(config.pagesRoot, 'about.json')), 'the page must not be deleted when redirectTo is rejected');
  } finally {
    cleanup();
  }
});

test('deleting a page with no redirectTo records no redirect', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    const config = loadSiteConfig(siteRoot);

    await deleteContent(config, 'pages/about.json', undefined, 'delete about', author);

    assert.deepEqual(loadRedirects(config), { schemaVersion: 1, entries: [] });
  } finally {
    cleanup();
  }
});

test('page-not-found: deleting a path with no live file is rejected', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    await assert.rejects(
      deleteContent(config, 'pages/never-existed.json', undefined, 'delete', author),
      (error: unknown) => error instanceof DeleteContentError && error.reason === 'page-not-found',
    );
  } finally {
    cleanup();
  }
});

test('has-children: deleting a page with a real child page is rejected, the page is untouched', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    writeAndCommit(siteRoot, 'content/pages/about/team.json', pageJson('Team'));
    const config = loadSiteConfig(siteRoot);

    await assert.rejects(
      deleteContent(config, 'pages/about.json', undefined, 'delete about', author),
      (error: unknown) => error instanceof DeleteContentError && error.reason === 'has-children',
    );
    assert.ok(existsSync(join(config.pagesRoot, 'about.json')));
  } finally {
    cleanup();
  }
});

test('a leftover empty sibling directory does not block deletion (the bug the design review caught)', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    const config = loadSiteConfig(siteRoot);
    // An empty directory with no real child page inside it - proves
    // "has children" means a real child page, not bare directory
    // existence, which would otherwise make this page permanently
    // undeletable (no rmdir/cleanup endpoint exists anywhere in the API).
    mkdirSync(join(config.pagesRoot, 'about'), { recursive: true });

    await deleteContent(config, 'pages/about.json', undefined, 'delete about', author);

    assert.equal(existsSync(join(config.pagesRoot, 'about.json')), false);
  } finally {
    cleanup();
  }
});

test('redirect-cycle: a redirectTo that would create a cycle is rejected, the page is restored, no commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    writeJson(siteRoot, 'content/redirects.json', { '/company': '/about' });
    execFileSync('git', ['add', '-A'], { cwd: siteRoot });
    execFileSync('git', ['commit', '-m', 'seed redirect'], {
      cwd: siteRoot,
      env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@example.com', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@example.com' },
      stdio: 'ignore',
    });
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    // Deleting /about with redirectTo /company would resolve back to
    // /about via the existing /company -> /about entry: a real cycle.
    await assert.rejects(
      deleteContent(config, 'pages/about.json', '/company', 'delete about', author),
      (error: unknown) => error instanceof DeleteContentError && error.reason === 'redirect-cycle',
    );

    assert.ok(existsSync(join(config.pagesRoot, 'about.json')), 'the live page must be restored');
    assert.equal(commitCount(siteRoot), before, 'no commit should be created');
  } finally {
    cleanup();
  }
});

test('deleting a live page never touches a draft at the same path', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    writeJson(siteRoot, 'content/drafts/pages/about.json', { schemaVersion: 1, title: 'Draft', type: 'page', published: true, sections: [] });
    const config = loadSiteConfig(siteRoot);
    const draftBefore = readFileSync(join(config.draftsRoot, 'pages', 'about.json'));

    await deleteContent(config, 'pages/about.json', undefined, 'delete about', author);

    const draftAfter = readFileSync(join(config.draftsRoot, 'pages', 'about.json'));
    assert.ok(draftBefore.equals(draftAfter), 'the draft must be untouched');
  } finally {
    cleanup();
  }
});

test('rollback-on-commit-failure: a real git failure after the file is written restores the page, no commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    // A real, deterministic git failure (stray index.lock), matching
    // the established pattern in migration-runner.test.ts/publish.test.ts
    // for proving rollback without a mock.
    const lockPath = join(siteRoot, '.git', 'index.lock');
    writeFileSync(lockPath, '');
    try {
      await assert.rejects(
        deleteContent(config, 'pages/about.json', undefined, 'delete about', author),
        (error: unknown) => error instanceof DeleteContentError && error.reason === 'commit-failed',
      );
    } finally {
      execFileSync('rm', ['-f', lockPath]);
    }

    assert.ok(existsSync(join(config.pagesRoot, 'about.json')), 'the live page must be restored');
    assert.equal(commitCount(siteRoot), before, 'no commit should be created');
  } finally {
    cleanup();
  }
});
