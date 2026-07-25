import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadThemeTemplates } from '../../src/renderer/theme-templates.ts';
import { createTmpSiteRoot } from '../helpers/tmp-site.ts';

test('loadThemeTemplates returns empty maps for a theme directory with no section/block types, without throwing', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const templates = loadThemeTemplates(siteRoot);
    assert.deepEqual(templates, { sections: {}, blocks: {} });
  } finally {
    cleanup();
  }
});
