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

test('K3: an extra top-level schema key (allowedBlocks) is preserved verbatim, not stripped by the loader', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    mkdirSync(join(siteRoot, 'theme', 'sections'), { recursive: true });
    writeFileSync(
      join(siteRoot, 'theme', 'sections', 'restricted.liquid'),
      '<p>{{ section.settings.text }}</p>\n{% schema %}\n{"type":"object","properties":{"text":{"type":"string"}},"allowedBlocks":["button"]}\n{% endschema %}\n',
    );

    const schemas = loadThemeSchemas(join(siteRoot, 'theme'));
    const restricted = schemas.sections.restricted as { allowedBlocks?: unknown };
    assert.deepEqual(restricted.allowedBlocks, ['button']);
  } finally {
    cleanup();
  }
});

test('L2: a type whose required field has no valid default is excluded from the registered schemas entirely', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    mkdirSync(join(siteRoot, 'theme', 'sections'), { recursive: true });
    writeFileSync(
      join(siteRoot, 'theme', 'sections', 'no-default.liquid'),
      '<h1>{{ section.settings.heading }}</h1>\n{% schema %}\n{"type":"object","required":["heading"],"properties":{"heading":{"type":"string","minLength":1}}}\n{% endschema %}\n',
    );
    writeFileSync(
      join(siteRoot, 'theme', 'sections', 'has-default.liquid'),
      '<h1>{{ section.settings.heading }}</h1>\n{% schema %}\n{"type":"object","required":["heading"],"properties":{"heading":{"type":"string","minLength":1,"default":"New Section"}}}\n{% endschema %}\n',
    );

    const schemas = loadThemeSchemas(join(siteRoot, 'theme'));
    assert.equal(schemas.sections['no-default'], undefined);
    assert.equal(schemas.acceptsBlocks.sections['no-default'], undefined);
    assert.ok(schemas.sections['has-default']);
  } finally {
    cleanup();
  }
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
