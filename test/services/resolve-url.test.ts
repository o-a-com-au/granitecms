import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSiteConfig } from '../../src/config.ts';
import { movePage } from '../../src/services/move.ts';
import { resolveUrl } from '../../src/services/resolve-url.ts';
import { createTmpSiteRoot, writeAndCommit } from '../helpers/tmp-site.ts';

const author = { name: 'Jane Editor', email: 'jane@example.com' };

function page(title: string): string {
  return JSON.stringify({ schemaVersion: 1, title, published: true, sections: [] });
}

test('E6: a redirect whose from matches a live page is never served; the page wins', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeAndCommit(siteRoot, 'content/pages/about.json', page('About'));
    await movePage(config, '/about', '/about-old', 'move away', author);
    // A new, unrelated page is recreated at the original URL directly
    // on disk (bypassing publish's own redirect cleanup), so the
    // redirect and the live page briefly coexist - the precedence rule
    // under test, not the cleanup mechanism proven elsewhere.
    writeAndCommit(siteRoot, 'content/pages/about.json', page('New about'));

    assert.deepEqual(resolveUrl(config, '/about'), { kind: 'page', relativePath: 'about.json' });
  } finally {
    cleanup();
  }
});

test('a redirect is served when no live page exists at that URL', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeAndCommit(siteRoot, 'content/pages/about.json', page('About'));
    await movePage(config, '/about', '/about-new', 'move', author);

    assert.deepEqual(resolveUrl(config, '/about'), { kind: 'redirect', to: '/about-new' });
  } finally {
    cleanup();
  }
});

test('a URL with neither a live page nor a redirect resolves to not-found', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    assert.deepEqual(resolveUrl(config, '/never-existed'), { kind: 'not-found' });
  } finally {
    cleanup();
  }
});
