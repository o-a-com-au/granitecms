import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { ContentReadError, listContent, readContentFile } from '../../src/services/content-read.ts';
import { PathSafetyError } from '../../src/services/path-safety.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

function page(title: string, type: string, published = true): object {
  return { schemaVersion: 3, title, type, published, sections: [] };
}

test('readContentFile returns the file bytes and a matching ETag', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('About', 'page'));
    const config = loadSiteConfig(siteRoot);

    const result = readContentFile(config.contentRoot, 'pages/about.json');
    const onDisk = readFileSync(join(config.contentRoot, 'pages/about.json'));

    assert.ok(result.bytes.equals(onDisk));
    assert.match(result.etag, /^"[0-9a-f]{64}"$/);
  } finally {
    cleanup();
  }
});

test('readContentFile throws ContentReadError(not-found) for a missing file', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    assert.throws(
      () => readContentFile(config.contentRoot, 'pages/never-existed.json'),
      (error: unknown) => error instanceof ContentReadError && error.reason === 'not-found',
    );
  } finally {
    cleanup();
  }
});

test('readContentFile throws PathSafetyError for a traversal attempt, uncaught (route layer catches it)', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    assert.throws(
      () => readContentFile(config.contentRoot, '../../../etc/passwd'),
      (error: unknown) => error instanceof PathSafetyError,
    );
  } finally {
    cleanup();
  }
});

test('listContent returns the union of content and draft-only paths', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/live-only.json', page('Live Only', 'page'));
    writeJson(siteRoot, 'content/drafts/pages/draft-only.json', page('Draft Only', 'page'));
    const config = loadSiteConfig(siteRoot);

    const entries = listContent(config, {});
    const paths = entries.map((e) => e.path).sort();
    assert.deepEqual(paths, ['pages/draft-only.json', 'pages/live-only.json']);

    const liveOnly = entries.find((e) => e.path === 'pages/live-only.json');
    assert.equal(liveOnly?.hasDraft, false);

    const draftOnly = entries.find((e) => e.path === 'pages/draft-only.json');
    assert.equal(draftOnly?.hasDraft, true);
    assert.equal(draftOnly?.title, 'Draft Only');
  } finally {
    cleanup();
  }
});

test('listContent prefers the live file on conflict but still reports hasDraft: true', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('Live About', 'page'));
    writeJson(siteRoot, 'content/drafts/pages/about.json', page('Draft About', 'page'));
    const config = loadSiteConfig(siteRoot);

    const entries = listContent(config, {});
    const about = entries.find((e) => e.path === 'pages/about.json');
    assert.equal(about?.title, 'Live About');
    assert.equal(about?.hasDraft, true);
  } finally {
    cleanup();
  }
});

test('listContent filters by type', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('About', 'page'));
    writeJson(siteRoot, 'content/pages/blog-post.json', page('A Post', 'article'));
    const config = loadSiteConfig(siteRoot);

    const entries = listContent(config, { type: 'article' });
    assert.deepEqual(entries.map((e) => e.path), ['pages/blog-post.json']);
  } finally {
    cleanup();
  }
});

test('listContent filters by path prefix', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('About', 'page'));
    writeJson(siteRoot, 'content/pages/about/team.json', page('Team', 'page'));
    const config = loadSiteConfig(siteRoot);

    const entries = listContent(config, { prefix: 'pages/about/' });
    assert.deepEqual(entries.map((e) => e.path), ['pages/about/team.json']);
  } finally {
    cleanup();
  }
});

test('listContent filters by draft status', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/live-only.json', page('Live Only', 'page'));
    writeJson(siteRoot, 'content/drafts/pages/draft-only.json', page('Draft Only', 'page'));
    const config = loadSiteConfig(siteRoot);

    const hasDraft = listContent(config, { draftStatus: 'has-draft' });
    assert.deepEqual(hasDraft.map((e) => e.path), ['pages/draft-only.json']);

    const noDraft = listContent(config, { draftStatus: 'no-draft' });
    assert.deepEqual(noDraft.map((e) => e.path), ['pages/live-only.json']);
  } finally {
    cleanup();
  }
});

test('listContent computes a url for pages, the index page, posts, and null for menus', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/index.json', page('Home', 'page'));
    writeJson(siteRoot, 'content/pages/about/team.json', page('Team', 'page'));
    writeJson(siteRoot, 'content/posts/my-slug.json', page('A Post', 'article'));
    writeJson(siteRoot, 'content/menus/main.json', { schemaVersion: 1, items: [] });
    const config = loadSiteConfig(siteRoot);

    const entries = listContent(config, {});
    const byPath = (path: string): (typeof entries)[number] | undefined =>
      entries.find((e) => e.path === path);

    assert.equal(byPath('pages/index.json')?.url, '/');
    assert.equal(byPath('pages/about/team.json')?.url, '/about/team');
    assert.equal(byPath('posts/my-slug.json')?.url, '/blog/my-slug');
    assert.equal(byPath('menus/main.json')?.url, null);
  } finally {
    cleanup();
  }
});

test('listContent does not crash on a real unmigrated (type-less) file', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    // A schemaVersion-1 file with no "type" field at all - proving the
    // real, persistent scenario boot.ts's never-auto-migrate design
    // guarantees can exist (test/fixtures/site/content/pages/about.json
    // is exactly this shape today), not a hypothetical.
    writeJson(siteRoot, 'content/pages/legacy.json', {
      schemaVersion: 1,
      title: 'Legacy Page',
      published: true,
      sections: [],
    });
    const config = loadSiteConfig(siteRoot);

    const entries = listContent(config, {});
    const legacy = entries.find((e) => e.path === 'pages/legacy.json');
    assert.ok(legacy, 'expected the unmigrated file to still be listed');
    assert.equal(legacy?.type, '');

    // Must not accidentally match a type filter it doesn't actually have.
    const filtered = listContent(config, { type: 'page' });
    assert.equal(
      filtered.some((e) => e.path === 'pages/legacy.json'),
      false,
    );
  } finally {
    cleanup();
  }
});
