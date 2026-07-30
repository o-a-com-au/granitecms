import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadThemeSchemas } from '../../src/services/theme-schemas.ts';
import { createTmpSiteRoot } from '../helpers/tmp-site.ts';

const fixtureTheme = join(import.meta.dirname, '..', 'fixtures', 'theme');

test('loadThemeSchemas returns the schema and content for each section/block type', () => {
  const schemas = loadThemeSchemas(fixtureTheme);
  assert.ok(schemas.sections.hero);
  assert.ok(schemas.blocks.button);
});

test('acceptsBlocks is true for a section whose markup loops blocksHtml, false otherwise', () => {
  const schemas = loadThemeSchemas(fixtureTheme);
  // hero.liquid contains `{% for html in blocksHtml %}` - it accepts blocks.
  assert.equal(schemas.acceptsBlocks.sections.hero, true);
  // button.liquid never references blocksHtml - it does not accept blocks.
  assert.equal(schemas.acceptsBlocks.blocks.button, false);
});

test('acceptsBlocks is false for a section that never mentions blocksHtml', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    mkdirSync(join(siteRoot, 'theme', 'sections'), { recursive: true });
    writeFileSync(
      join(siteRoot, 'theme', 'sections', 'plain.liquid'),
      '<p>{{ section.settings.text }}</p>\n{% schema %}\n{"type":"object","properties":{"text":{"type":"string"}}}\n{% endschema %}\n',
    );

    const schemas = loadThemeSchemas(join(siteRoot, 'theme'));
    assert.equal(schemas.acceptsBlocks.sections.plain, false);
  } finally {
    cleanup();
  }
});
