import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadSiteConfig } from '../src/config.ts';
import { createTmpSiteRoot } from './helpers/tmp-site.ts';

test('B1: the agent boots against a site root passed in config, not the agent package location', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const config = loadSiteConfig(siteRoot);
    assert.equal(config.siteRoot, siteRoot);
    assert.ok(config.contentRoot.startsWith(siteRoot));
    assert.ok(config.draftsRoot.startsWith(siteRoot));
    assert.ok(config.themesRoot.startsWith(siteRoot));
    assert.ok(!config.contentRoot.includes(import.meta.dirname));
  } finally {
    cleanup();
  }
});

test('config derives pagesRoot under contentRoot/pages and redirectsPath at the site root', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const config = loadSiteConfig(siteRoot);
    assert.equal(config.pagesRoot, join(config.contentRoot, 'pages'));
    assert.equal(config.redirectsPath, join(siteRoot, 'redirects.json'));
  } finally {
    cleanup();
  }
});

test('B1: a relative siteRoot is rejected rather than silently resolved against process.cwd()', () => {
  assert.throws(() => loadSiteConfig('relative/site/root'));
});

test('config derives dataRoot at the site root and searchIndexPath under it', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const config = loadSiteConfig(siteRoot);
    assert.equal(config.dataRoot, join(siteRoot, 'data'));
    assert.equal(config.searchIndexPath, join(config.dataRoot, 'search-index.sqlite'));
  } finally {
    cleanup();
  }
});
