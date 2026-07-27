import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
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
