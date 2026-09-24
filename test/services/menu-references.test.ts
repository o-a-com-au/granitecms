import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { findMenuReferences, isValidMenuHandle } from '../../src/services/menu-references.ts';
import { createTmpSiteRoot } from '../helpers/tmp-site.ts';

function writeTheme(siteRoot: string, relativePath: string, body: string): void {
  const full = join(siteRoot, 'theme', relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

test('findMenuReferences finds dot and bracket lookups of a handle across theme .liquid files, sorted', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeTheme(siteRoot, 'layouts/theme.liquid', '{% for item in menus.main.items %}{{ item.label }}{% endfor %}');
    writeTheme(siteRoot, 'snippets/nav.liquid', "{% assign m = menus['main'] %}");
    writeTheme(siteRoot, 'sections/footer.liquid', '{{ menus["main"].name }}');
    writeTheme(siteRoot, 'sections/unrelated.liquid', '{{ page.title }}');

    assert.deepEqual(findMenuReferences(loadSiteConfig(siteRoot), 'main'), [
      'theme/layouts/theme.liquid',
      'theme/sections/footer.liquid',
      'theme/snippets/nav.liquid',
    ]);
  } finally {
    cleanup();
  }
});

test('findMenuReferences matches a handle only as a whole name, never a prefix of a longer one', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeTheme(siteRoot, 'layouts/theme.liquid', '{{ menus.mainFooter.items }}{{ menus.main-extra.items }}');

    assert.deepEqual(findMenuReferences(loadSiteConfig(siteRoot), 'main'), []);
    assert.deepEqual(findMenuReferences(loadSiteConfig(siteRoot), 'main-extra'), ['theme/layouts/theme.liquid']);
  } finally {
    cleanup();
  }
});

test('a menu handle is letters, numbers, hyphens and underscores only', () => {
  assert.equal(isValidMenuHandle('footer-company_2'), true);
  for (const bad of ['', 'a b', '../x', 'a/b', 'a.json', 'a.b']) {
    assert.equal(isValidMenuHandle(bad), false, bad);
  }
});
