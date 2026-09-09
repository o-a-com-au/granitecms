import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { saveDraft } from '../../src/services/drafts.ts';
import { deleteContent } from '../../src/services/delete-content.ts';
import { movePage } from '../../src/services/move.ts';
import { publishDrafts, unpublishPage } from '../../src/services/publish.ts';
import { runBatch } from '../../src/services/batch.ts';
import { queryContent } from '../../src/search/query-content.ts';
import { rebuildIndexIfMissing } from '../../src/search/rebuild-index.ts';
import type { ThemeSchemas } from '../../src/services/validation.ts';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

const themeSchemas: ThemeSchemas = { sections: {}, blocks: {}, acceptsBlocks: { sections: {}, blocks: {} } };
const author = { name: 'Jane Editor', email: 'jane@example.com' };
const NO_PRIOR_FILE_ETAG = 'no-prior-file';

function page(title: string, published = true): object {
  return { schemaVersion: 4, name: title, title, type: 'page', layout: 'theme', published, sections: [] };
}

// The reindex these service functions trigger is deliberately
// fire-and-forget (see src/services/reindex-on-write.ts) - it is
// enqueued but not necessarily finished by the time the triggering
// write's own promise resolves. A bounded poll is the honest way to
// prove eventual consistency without an artificial fixed sleep,
// matching e2e/create-site-packaging.check.ts's own established
// pattern for "wait for real async state to settle".
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`condition never became true within ${timeoutMs}ms`);
}

function titlesFor(searchIndexPath: string, q: string): string[] {
  return queryContent(searchIndexPath, { q, filters: [], limit: 20, offset: 0 }).results.map((r) => r.title);
}

test('publishing a draft triggers a background reindex - GET /search.json reflects it without a manual rebuild', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    await saveDraft(config, themeSchemas, 'pages/xylophone.json', page('Xylophone Museum'), NO_PRIOR_FILE_ETAG);

    await publishDrafts(config, themeSchemas, ['pages/xylophone.json'], 'publish xylophone', author);

    await waitFor(() => titlesFor(config.searchIndexPath, 'xylophone').includes('Xylophone Museum'));
  } finally {
    cleanup();
  }
});

test('unpublishing a page triggers a background reindex - it drops out of search results', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/quokka.json', JSON.stringify(page('Quokka Sanctuary')));
    const config = loadSiteConfig(siteRoot);
    await rebuildIndexIfMissing(config);
    await waitFor(() => titlesFor(config.searchIndexPath, 'quokka').includes('Quokka Sanctuary'));

    await unpublishPage(config, 'pages/quokka.json', 'unpublish quokka', author);

    await waitFor(() => !titlesFor(config.searchIndexPath, 'quokka').includes('Quokka Sanctuary'));
  } finally {
    cleanup();
  }
});

test('deleting a page triggers a background reindex - it drops out of search results', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/narwhal.json', JSON.stringify(page('Narwhal Facts')));
    const config = loadSiteConfig(siteRoot);
    await rebuildIndexIfMissing(config);
    await waitFor(() => titlesFor(config.searchIndexPath, 'narwhal').includes('Narwhal Facts'));

    await deleteContent(config, 'pages/narwhal.json', undefined, 'delete narwhal', author);

    await waitFor(() => !titlesFor(config.searchIndexPath, 'narwhal').includes('Narwhal Facts'));
  } finally {
    cleanup();
  }
});

test('moving a page triggers a background reindex - the old URL stops matching, content is still findable', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/wombat.json', JSON.stringify(page('Wombat Burrows')));
    const config = loadSiteConfig(siteRoot);
    await rebuildIndexIfMissing(config);
    await waitFor(() => titlesFor(config.searchIndexPath, 'wombat').includes('Wombat Burrows'));

    await movePage(config, '/wombat', '/animals/wombat', 'move wombat', author);

    await waitFor(() => {
      const [result] = queryContent(config.searchIndexPath, { q: 'wombat', filters: [], limit: 20, offset: 0 }).results;
      return result?.url === '/animals/wombat';
    });
  } finally {
    cleanup();
  }
});

test('a batch operation triggers a background reindex covering everything it touched', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);

    await runBatch(
      config,
      themeSchemas,
      [{ type: 'draft-write', path: 'pages/pademelon.json', content: page('Pademelon Guide'), expectedEtag: NO_PRIOR_FILE_ETAG }],
      { relativePaths: ['pages/pademelon.json'] },
      'batch publish pademelon',
      author,
    );

    await waitFor(() => titlesFor(config.searchIndexPath, 'pademelon').includes('Pademelon Guide'));
  } finally {
    cleanup();
  }
});

test('startServer-style boot rebuild: rebuildIndexIfMissing builds a missing index but leaves an existing one alone', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/bilby.json', JSON.stringify(page('Bilby Conservation')));
    const config = loadSiteConfig(siteRoot);

    await rebuildIndexIfMissing(config);
    assert.ok(titlesFor(config.searchIndexPath, 'bilby').includes('Bilby Conservation'));

    // A second call against an index that already exists must not
    // touch it - proven by writing new content on disk WITHOUT going
    // through a real write path (so nothing else could have triggered
    // a reindex) and confirming rebuildIndexIfMissing still leaves the
    // index exactly as it was.
    writeJson(siteRoot, 'content/pages/echidna.json', page('Echidna Spines'));
    await rebuildIndexIfMissing(config);
    assert.equal(titlesFor(config.searchIndexPath, 'echidna').includes('Echidna Spines'), false);
  } finally {
    cleanup();
  }
});

test('a broken search index directory does not fail the publish that triggered a reindex', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    // config.dataRoot is <siteRoot>/vhost/data - pre-creating a plain
    // FILE at that exact path makes rebuildIndexJob's own
    // mkdirSync(dataRoot, { recursive: true }) throw ENOTDIR, a
    // realistic on-disk failure mode, without touching anything
    // publishDrafts itself needs (it only writes under content/).
    mkdirSync(join(siteRoot, 'vhost'), { recursive: true });
    writeFileSync(config.dataRoot, 'not a directory');

    await saveDraft(config, themeSchemas, 'pages/dingo.json', page('Dingo Facts'), NO_PRIOR_FILE_ETAG);

    // Must resolve, not reject - the write itself succeeded regardless
    // of the reindex it kicked off being doomed to fail.
    await publishDrafts(config, themeSchemas, ['pages/dingo.json'], 'publish dingo', author);

    // Give the doomed background reindex a moment to actually fail
    // (and be caught/logged) rather than merely not-yet-run - if it
    // somehow threw unhandled, node:test's own unhandledRejection
    // guard would fail this test.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    cleanup();
  }
});
