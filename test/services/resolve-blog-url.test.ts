import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadSiteConfig } from '../../src/config.ts';
import { resolveBlogUrl } from '../../src/services/resolve-blog-url.ts';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

function post(title: string): string {
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

test('a live post resolves by its flat slug', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/posts/hello-world.json', post('Hello World'));
    const config = loadSiteConfig(siteRoot);

    assert.deepEqual(resolveBlogUrl(config, '/blog/hello-world'), {
      kind: 'post',
      relativePath: 'hello-world.json',
    });
  } finally {
    cleanup();
  }
});

test('a redirect is served when no live post exists at that /blog/ URL', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'redirects.json', { '/blog/old-slug': '/blog/new-slug' });
    const config = loadSiteConfig(siteRoot);

    assert.deepEqual(resolveBlogUrl(config, '/blog/old-slug'), { kind: 'redirect', to: '/blog/new-slug' });
  } finally {
    cleanup();
  }
});

test('a live post always wins over a redirect recorded at the same URL', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/posts/hello-world.json', JSON.parse(post('Hello World')));
    writeJson(siteRoot, 'redirects.json', { '/blog/hello-world': '/somewhere-else' });
    const config = loadSiteConfig(siteRoot);

    assert.deepEqual(resolveBlogUrl(config, '/blog/hello-world'), {
      kind: 'post',
      relativePath: 'hello-world.json',
    });
  } finally {
    cleanup();
  }
});

test('a /blog/ URL with no matching post and no redirect resolves to not-found', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    assert.deepEqual(resolveBlogUrl(config, '/blog/never-existed'), { kind: 'not-found' });
  } finally {
    cleanup();
  }
});

// Regression: a site that has never used blog posts has no
// content/posts/ directory on disk at all - this must resolve safely
// to not-found, never a raw, uncaught ENOENT from realpathSync.
test('a /blog/ URL resolves safely to not-found when content/posts/ does not exist on disk at all', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    assert.equal(existsSync(config.postsRoot), false);
    assert.deepEqual(resolveBlogUrl(config, '/blog/anything'), { kind: 'not-found' });
  } finally {
    cleanup();
  }
});

test('a nested /blog/ slug (posts are flat only) resolves to not-found, not a post lookup', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    assert.deepEqual(resolveBlogUrl(config, '/blog/2026/hello-world'), { kind: 'not-found' });
  } finally {
    cleanup();
  }
});
