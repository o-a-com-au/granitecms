import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { saveDraft } from '../../src/services/drafts.ts';
import { computeEtag } from '../../src/services/etag.ts';
import { movePage } from '../../src/services/move.ts';
import { PublishError, publishDrafts, unpublishPage } from '../../src/services/publish.ts';
import { loadRedirects } from '../../src/services/redirects.ts';
import type { ThemeSchemas } from '../../src/services/validation.ts';
import { createTmpSiteRoot, writeAndCommit } from '../helpers/tmp-site.ts';

const themeSchemas: ThemeSchemas = { sections: {}, blocks: {} };
const author = { name: 'Jane Editor', email: 'jane@example.com' };

// Neither a draft nor a live file exists yet at some tests' target
// paths, so the If-Match comparison is skipped (saveDraftJob's
// null-etag case) - any non-empty placeholder satisfies it.
const NO_PRIOR_FILE_ETAG = 'no-prior-file';

function page(title: string): object {
  return { schemaVersion: 1, title, type: 'page', layout: 'theme', published: true, sections: [] };
}

function liveEtag(content: object): string {
  return computeEtag(Buffer.from(JSON.stringify(content)));
}

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

function log(siteRoot: string, format: string): string {
  return execFileSync('git', ['log', '-1', `--format=${format}`], { cwd: siteRoot })
    .toString('utf-8')
    .trim();
}

test('C4: publishing promotes the draft over the live file, deletes the draft, and creates exactly one commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/about.json', JSON.stringify(page('Old')));
    const config = loadSiteConfig(siteRoot);
    await saveDraft(config, themeSchemas, 'about.json', page('New'), liveEtag(page('Old')));
    const before = commitCount(siteRoot);

    await publishDrafts(config, themeSchemas, ['about.json'], 'publish about', author);

    assert.deepEqual(JSON.parse(readFileSync(join(config.contentRoot, 'about.json'), 'utf-8')), page('New'));
    assert.equal(existsSync(join(config.draftsRoot, 'about.json')), false);
    assert.equal(commitCount(siteRoot), before + 1);
  } finally {
    cleanup();
  }
});

test('C5: the publish commit author is the identity supplied with the request, not a fixed agent identity', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/about.json', JSON.stringify(page('Old')));
    const config = loadSiteConfig(siteRoot);
    await saveDraft(config, themeSchemas, 'about.json', page('New'), liveEtag(page('Old')));

    await publishDrafts(config, themeSchemas, ['about.json'], 'publish about', {
      name: 'Alex Author',
      email: 'alex@example.com',
    });

    assert.equal(log(siteRoot, '%an'), 'Alex Author');
    assert.equal(log(siteRoot, '%ae'), 'alex@example.com');
  } finally {
    cleanup();
  }
});

test('C6: publishing multiple drafts in one call is atomic: if one fails validation, no files change and no commit is created', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/a.json', JSON.stringify(page('A-old')));
    writeAndCommit(siteRoot, 'content/b.json', JSON.stringify(page('B-old')));
    const config = loadSiteConfig(siteRoot);
    await saveDraft(config, themeSchemas, 'a.json', page('A-new'), liveEtag(page('A-old')));
    // Written directly, bypassing saveDraft's own validation, so there
    // is an invalid draft on disk for publishDrafts to reject.
    mkdirSync(config.draftsRoot, { recursive: true });
    writeFileSync(join(config.draftsRoot, 'b.json'), JSON.stringify({ schemaVersion: 1, title: 'B-new' }));

    const before = commitCount(siteRoot);

    await assert.rejects(
      publishDrafts(config, themeSchemas, ['a.json', 'b.json'], 'publish both', author),
      (error: unknown) => error instanceof PublishError && error.reason === 'validation-failed',
    );

    assert.equal(commitCount(siteRoot), before);
    assert.deepEqual(JSON.parse(readFileSync(join(config.contentRoot, 'a.json'), 'utf-8')), page('A-old'));
    assert.deepEqual(JSON.parse(readFileSync(join(config.contentRoot, 'b.json'), 'utf-8')), page('B-old'));
    assert.ok(existsSync(join(config.draftsRoot, 'a.json')), 'draft a should be untouched');
    assert.ok(existsSync(join(config.draftsRoot, 'b.json')), 'draft b should be untouched');
  } finally {
    cleanup();
  }
});

test('C8 (mechanics only, renderer 404 half proven in Group D): unpublish sets published:false and commits with the supplied author', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/about.json', JSON.stringify(page('About')));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await unpublishPage(config, 'about.json', 'unpublish about', author);

    const updated = JSON.parse(readFileSync(join(config.contentRoot, 'about.json'), 'utf-8')) as {
      published: boolean;
    };
    assert.equal(updated.published, false);
    assert.equal(commitCount(siteRoot), before + 1);
    assert.equal(log(siteRoot, '%an'), author.name);
  } finally {
    cleanup();
  }
});

test('C9: a write failure partway through a multi-file publish rolls back cleanly, no partial writes, no staged-but-uncommitted state', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/a.json', JSON.stringify(page('A-old')));
    const config = loadSiteConfig(siteRoot);
    await saveDraft(config, themeSchemas, 'a.json', page('A-new'), liveEtag(page('A-old')));
    await saveDraft(config, themeSchemas, 'foo/bar.json', page('B-new'), NO_PRIOR_FILE_ETAG);

    // Pre-create content/foo as a plain file, not a directory, so the
    // second entry's mkdirSync fails with a real, non-mocked fs error
    // partway through the batch, after the first entry already wrote
    // successfully.
    writeFileSync(join(config.contentRoot, 'foo'), 'not a directory');

    const before = commitCount(siteRoot);

    await assert.rejects(
      publishDrafts(config, themeSchemas, ['a.json', 'foo/bar.json'], 'publish both', author),
      (error: unknown) => error instanceof PublishError && error.reason === 'write-failed',
    );

    assert.equal(commitCount(siteRoot), before, 'no commit should be created');
    assert.deepEqual(
      JSON.parse(readFileSync(join(config.contentRoot, 'a.json'), 'utf-8')),
      page('A-old'),
      'a.json must be rolled back to its original content',
    );
    assert.ok(existsSync(join(config.draftsRoot, 'a.json')), 'draft a must be restored');

    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: siteRoot })
      .toString('utf-8')
      .trim();
    assert.equal(staged, '', 'nothing should be left staged after rollback');
  } finally {
    cleanup();
  }
});

test('E5 (publish half, move half closed out in move.test.ts): creating a page at a path that has a redirect entry removes that entry in the same commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About')));
    // Moving the original "about" page away leaves a redirect recorded
    // at /about, pointing elsewhere.
    await movePage(config, '/about', '/about-old', 'move about away', author);
    assert.equal(loadRedirects(config)['/about'], '/about-old');

    // A brand-new, unrelated page is now authored and published at the
    // same URL via the normal draft workflow.
    await saveDraft(config, themeSchemas, 'pages/about.json', page('New About'), NO_PRIOR_FILE_ETAG);
    const before = commitCount(siteRoot);
    await publishDrafts(config, themeSchemas, ['pages/about.json'], 'publish new about', author);

    assert.equal(commitCount(siteRoot), before + 1);
    assert.deepEqual(
      JSON.parse(readFileSync(join(config.pagesRoot, 'about.json'), 'utf-8')),
      page('New About'),
    );
    assert.equal(loadRedirects(config)['/about'], undefined);
  } finally {
    cleanup();
  }
});

function post(title: string): object {
  return {
    schemaVersion: 4,
    title,
    type: 'post',
    layout: 'theme',
    published: true,
    author: 'Jane Editor',
    publishDate: '2026-07-27',
    tags: [],
    sections: [],
  };
}

test('E5 (posts): publishing a new post at a URL that has a stale redirect entry removes that entry in the same commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    // move.ts isn't extended to posts (see docs/phase-2-checklist.md's
    // Group L notes), so the stale redirect is seeded directly, rather
    // than via movePage as the pages test above does.
    writeAndCommit(siteRoot, 'redirects.json', JSON.stringify({ '/blog/hello-world': '/blog/elsewhere' }));

    await saveDraft(config, themeSchemas, 'posts/hello-world.json', post('Hello World'), NO_PRIOR_FILE_ETAG);
    const before = commitCount(siteRoot);
    await publishDrafts(config, themeSchemas, ['posts/hello-world.json'], 'publish hello-world', author);

    assert.equal(commitCount(siteRoot), before + 1);
    assert.equal(loadRedirects(config)['/blog/hello-world'], undefined);
  } finally {
    cleanup();
  }
});

test('E5 (menus): publishing a menu never touches redirects.json (menus have no public URL)', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeAndCommit(siteRoot, 'redirects.json', JSON.stringify({ '/menus/main': '/somewhere' }));

    await saveDraft(config, themeSchemas, 'menus/main.json', { schemaVersion: 1, items: [] }, NO_PRIOR_FILE_ETAG);
    await publishDrafts(config, themeSchemas, ['menus/main.json'], 'publish main menu', author);

    // The unrelated, coincidentally-similar-looking entry is left
    // exactly as-is - publishing a menu has no redirect-clearing
    // concept at all, unlike pages/posts.
    assert.equal(loadRedirects(config)['/menus/main'], '/somewhere');
  } finally {
    cleanup();
  }
});
