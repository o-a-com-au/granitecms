import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadThemeSchemas } from '../../src/services/theme-schemas.ts';
import { loadSnippets, loadThemeTemplates } from '../../src/renderer/theme-templates.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

test('loadThemeTemplates returns empty maps for a theme directory with no section/block types, without throwing', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const templates = loadThemeTemplates(siteRoot);
    assert.deepEqual(templates, { sections: {}, blocks: {} });
  } finally {
    cleanup();
  }
});

test('loadSnippets reads real fixture snippet files, keyed by filename without extension', () => {
  const fixtureTheme = join(import.meta.dirname, '..', 'fixtures', 'theme');
  const snippets = loadSnippets(fixtureTheme);
  assert.equal(typeof snippets['site-name'], 'string');
  assert.match(snippets['site-name'] as string, /site-name/);
});

test('loadSnippets returns an empty map for a theme with no snippets directory, without throwing', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    assert.deepEqual(loadSnippets(siteRoot), {});
  } finally {
    cleanup();
  }
});

test('loadSnippets ignores non-.liquid files and subdirectories under snippets/', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeJson(siteRoot, 'snippets/.DS_Store', {});
    writeJson(siteRoot, 'snippets/subdir/nested.liquid', {});
    const snippets = loadSnippets(siteRoot);
    assert.deepEqual(snippets, {});
  } finally {
    cleanup();
  }
});

function writeComponentFile(siteRoot: string, relativePath: string, contents: string): void {
  const fullPath = join(siteRoot, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

test('a real fixture .liquid file is loaded, keyed by filename, with the schema block correctly split from the markup', () => {
  const fixtureTheme = join(import.meta.dirname, '..', 'fixtures', 'theme');

  const templates = loadThemeTemplates(fixtureTheme);
  assert.equal(typeof templates.sections.hero, 'string');
  assert.equal(templates.sections.hero?.includes('{% schema %}'), false);
  assert.ok(templates.sections.hero?.includes('section.settings.heading'));

  const schemas = loadThemeSchemas(fixtureTheme);
  assert.deepEqual(schemas.sections.hero, {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: ['heading'],
    properties: {
      heading: { type: 'string', minLength: 1 },
      subheading: { type: 'string' },
      columns: { type: 'integer', minimum: 1, maximum: 4 },
    },
  });
});

test('a .liquid file with no schema block is skipped entirely - a real, deliberate behaviour change from the old two-file shape (Group O)', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeComponentFile(siteRoot, 'sections/no-schema.liquid', '<p>markup with no schema block at all</p>');

    assert.equal(loadThemeTemplates(siteRoot).sections['no-schema'], undefined);
    assert.equal(loadThemeSchemas(siteRoot).sections['no-schema'], undefined);
  } finally {
    cleanup();
  }
});

test('a .liquid file with a malformed schema block is skipped entirely, both markup and schema', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeComponentFile(
      siteRoot,
      'sections/broken.liquid',
      '<p>markup</p>\n{% schema %}\n{ not valid json\n{% endschema %}\n',
    );

    assert.equal(loadThemeTemplates(siteRoot).sections.broken, undefined);
    assert.equal(loadThemeSchemas(siteRoot).sections.broken, undefined);
  } finally {
    cleanup();
  }
});

test('sections/blocks are named directly by filename, with no subfolder - a multi-word name like media-text.liquid works', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    writeComponentFile(
      siteRoot,
      'sections/media-text.liquid',
      '<div>media-text markup</div>\n{% schema %}\n{ "type": "object" }\n{% endschema %}\n',
    );

    const templates = loadThemeTemplates(siteRoot);
    assert.ok(templates.sections['media-text']?.includes('media-text markup'));
    assert.deepEqual(loadThemeSchemas(siteRoot).sections['media-text'], { type: 'object' });
  } finally {
    cleanup();
  }
});
