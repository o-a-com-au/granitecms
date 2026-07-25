import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('B1: a relative siteRoot is rejected rather than silently resolved against process.cwd()', () => {
  assert.throws(() => loadSiteConfig('relative/site/root'));
});
