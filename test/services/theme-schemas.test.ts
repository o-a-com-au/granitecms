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

    // Previously this exclusion was completely silent - now it must
    // name the excluded type and the specific reason, and must NOT
    // warn about the sibling type that loaded fine.
    assert.ok(schemas.warnings?.some((w) => w.includes('no-default') && w.includes('no valid "default"')));
    assert.ok(!schemas.warnings?.some((w) => w.includes('has-default')));
  } finally {
    cleanup();
  }
});

test('a section whose required-field schema has an unresolvable $ref is excluded with a warning, not a thrown exception that would crash the whole boot', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    mkdirSync(join(siteRoot, 'theme', 'sections'), { recursive: true });
    writeFileSync(
      join(siteRoot, 'theme', 'sections', 'bad-ref.liquid'),
      '<img src="{{ section.settings.poster.url }}">\n{% schema %}\n' +
        JSON.stringify({
          type: 'object',
          $defs: { image: { type: 'object', properties: { url: { type: 'string' } } } },
          required: ['poster'],
          properties: { poster: { $ref: '#/$defs/image', default: { url: '/images/a.jpg' } } },
        }) +
        '\n{% endschema %}\n',
    );

    assert.doesNotThrow(() => loadThemeSchemas(join(siteRoot, 'theme')));
    const schemas = loadThemeSchemas(join(siteRoot, 'theme'));
    assert.equal(schemas.sections['bad-ref'], undefined);
    assert.ok(schemas.warnings?.some((w) => w.includes('bad-ref')));
  } finally {
    cleanup();
  }
});

test('a section file with no {% schema %} block at all is excluded with a warning naming it', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    mkdirSync(join(siteRoot, 'theme', 'sections'), { recursive: true });
    writeFileSync(join(siteRoot, 'theme', 'sections', 'no-schema.liquid'), '<h1>Just markup, no schema block</h1>\n');

    const schemas = loadThemeSchemas(join(siteRoot, 'theme'));
    assert.equal(schemas.sections['no-schema'], undefined);
    assert.ok(schemas.warnings?.some((w) => w.includes('no-schema') && w.includes('no valid {% schema %} block')));
  } finally {
    cleanup();
  }
});

test('a block whose {% schema %} block is not valid JSON is excluded with a warning naming it', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    mkdirSync(join(siteRoot, 'theme', 'blocks'), { recursive: true });
    writeFileSync(
      join(siteRoot, 'theme', 'blocks', 'broken-json.liquid'),
      '<p>Broken</p>\n{% schema %}\n{ this is not valid json\n{% endschema %}\n',
    );

    const schemas = loadThemeSchemas(join(siteRoot, 'theme'));
    assert.equal(schemas.blocks['broken-json'], undefined);
    assert.ok(schemas.warnings?.some((w) => w.startsWith('Block type "broken-json"') && w.includes('no valid {% schema %} block')));
  } finally {
    cleanup();
  }
});

test('a theme with no excluded types at all has an empty warnings array, not a missing one', () => {
  const schemas = loadThemeSchemas(fixtureTheme);
  assert.deepEqual(schemas.warnings, []);
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
