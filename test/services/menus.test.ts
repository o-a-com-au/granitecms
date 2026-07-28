import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSiteConfig } from '../../src/config.ts';
import { loadMenus } from '../../src/services/menus.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

test('loadMenus returns every live menu, keyed by filename without extension', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/menus/main.json', {
      schemaVersion: 1,
      items: [{ label: 'Home', url: '/' }],
    });
    writeJson(siteRoot, 'content/menus/footer.json', {
      schemaVersion: 1,
      items: [{ label: 'Privacy', url: '/privacy' }],
    });
    const config = loadSiteConfig(siteRoot);

    const menus = loadMenus(config, 'public');
    assert.deepEqual(menus.main, { items: [{ label: 'Home', url: '/' }] });
    assert.deepEqual(menus.footer, { items: [{ label: 'Privacy', url: '/privacy' }] });
  } finally {
    cleanup();
  }
});

test('loadMenus returns {} gracefully when content/menus/ does not exist at all (a site that has never used menus)', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    assert.deepEqual(loadMenus(config, 'public'), {});
  } finally {
    cleanup();
  }
});

test('loadMenus in preview mode overlays a draft menu over its live counterpart by name', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/menus/main.json', { schemaVersion: 1, items: [{ label: 'Live', url: '/live' }] });
    writeJson(siteRoot, 'content/drafts/menus/main.json', { schemaVersion: 1, items: [{ label: 'Draft', url: '/draft' }] });
    const config = loadSiteConfig(siteRoot);

    const preview = loadMenus(config, 'preview');
    assert.deepEqual(preview.main, { items: [{ label: 'Draft', url: '/draft' }] });

    const publicMenus = loadMenus(config, 'public');
    assert.deepEqual(publicMenus.main, { items: [{ label: 'Live', url: '/live' }] });
  } finally {
    cleanup();
  }
});

test('loadMenus in preview mode includes a draft-only menu that has no live counterpart at all', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/drafts/menus/new-menu.json', { schemaVersion: 1, items: [{ label: 'New', url: '/new' }] });
    const config = loadSiteConfig(siteRoot);

    const preview = loadMenus(config, 'preview');
    assert.deepEqual(preview['new-menu'], { items: [{ label: 'New', url: '/new' }] });
    assert.equal(loadMenus(config, 'public')['new-menu'], undefined);
  } finally {
    cleanup();
  }
});

test('a malformed menu file (no items array) is skipped individually, not fatal', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/menus/broken.json', { schemaVersion: 1, notItems: 'oops' });
    writeJson(siteRoot, 'content/menus/good.json', { schemaVersion: 1, items: [{ label: 'OK', url: '/ok' }] });
    const config = loadSiteConfig(siteRoot);

    const menus = loadMenus(config, 'public');
    assert.equal(menus.broken, undefined);
    assert.deepEqual(menus.good, { items: [{ label: 'OK', url: '/ok' }] });
  } finally {
    cleanup();
  }
});
