import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPageTemplates } from '../../src/services/theme-page-templates.ts';
import { loadThemeSchemas } from '../../src/services/theme-schemas.ts';
import { createTmpSiteRoot } from '../helpers/tmp-site.ts';

const fixtureTheme = join(import.meta.dirname, '..', 'fixtures', 'theme');
const themeSchemas = loadThemeSchemas(fixtureTheme);

const VALID_TEMPLATE = {
  schemaVersion: 1,
  name: 'blog-article',
  title: 'Blog Article',
  type: 'page',
  layout: 'theme',
  published: true,
  sections: [{ id: 'sec-hero', type: 'hero', settings: { heading: 'A blog post' }, blocks: [] }],
};

test('loadPageTemplates returns [] when the templates folder does not exist', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const templates = loadPageTemplates(join(siteRoot, 'theme', 'templates'), themeSchemas);
    assert.deepEqual(templates, []);
  } finally {
    cleanup();
  }
});

test('loadPageTemplates reads each flat *.json file, id from the filename, title from the page itself', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const templatesDir = join(siteRoot, 'theme', 'templates');
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, 'blog-article.json'), JSON.stringify(VALID_TEMPLATE));

    const templates = loadPageTemplates(templatesDir, themeSchemas);
    assert.equal(templates.length, 1);
    assert.equal(templates[0]?.id, 'blog-article');
    assert.equal(templates[0]?.title, 'Blog Article');
    assert.deepEqual(templates[0]?.content, VALID_TEMPLATE);
  } finally {
    cleanup();
  }
});

test('loadPageTemplates skips a file that is not valid JSON, without throwing', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const templatesDir = join(siteRoot, 'theme', 'templates');
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, 'broken.json'), '{ not valid json');
    writeFileSync(join(templatesDir, 'blog-article.json'), JSON.stringify(VALID_TEMPLATE));

    const templates = loadPageTemplates(templatesDir, themeSchemas);
    assert.equal(templates.length, 1);
    assert.equal(templates[0]?.id, 'blog-article');
  } finally {
    cleanup();
  }
});

test('loadPageTemplates skips a file that fails page validation - an unknown section type - without throwing', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const templatesDir = join(siteRoot, 'theme', 'templates');
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(
      join(templatesDir, 'invalid.json'),
      JSON.stringify({
        ...VALID_TEMPLATE,
        sections: [{ id: 'sec-1', type: 'not-a-real-section', settings: {} }],
      }),
    );
    writeFileSync(join(templatesDir, 'blog-article.json'), JSON.stringify(VALID_TEMPLATE));

    const templates = loadPageTemplates(templatesDir, themeSchemas);
    assert.equal(templates.length, 1);
    assert.equal(templates[0]?.id, 'blog-article');
  } finally {
    cleanup();
  }
});
