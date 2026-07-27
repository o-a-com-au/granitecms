import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContent, validateMenu } from '../../src/services/validation.ts';
import type { ThemeSchemas } from '../../src/services/validation.ts';

const themeSchemas: ThemeSchemas = { sections: {}, blocks: {} };

test('a menu with a valid items list validates successfully', () => {
  const menu = {
    schemaVersion: 1,
    items: [
      { label: 'Home', url: '/' },
      { label: 'Blog', url: '/blog' },
    ],
  };
  const result = validateMenu(menu);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('an empty items list is valid (a menu with no links yet)', () => {
  const result = validateMenu({ schemaVersion: 1, items: [] });
  assert.equal(result.valid, true);
});

test('a menu item missing label or url fails validation', () => {
  const missingLabel = { schemaVersion: 1, items: [{ url: '/' }] };
  assert.equal(validateMenu(missingLabel).valid, false);

  const missingUrl = { schemaVersion: 1, items: [{ label: 'Home' }] };
  assert.equal(validateMenu(missingUrl).valid, false);
});

test('a menu is rejected if it carries page-shaped fields (additionalProperties false)', () => {
  const result = validateMenu({ schemaVersion: 1, items: [], title: 'Main Menu' });
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.keyword === 'additionalProperties');
  assert.ok(error, 'expected an additionalProperties error');
});

test('a menu missing schemaVersion fails validation', () => {
  const result = validateMenu({ items: [] });
  assert.equal(result.valid, false);
});

test('validateContent dispatches to validateMenu for a menus/ relative path', () => {
  const menu = { schemaVersion: 1, items: [{ label: 'Home', url: '/' }] };
  const result = validateContent('menus/main.json', menu, themeSchemas);
  assert.equal(result.valid, true);

  // A page-shaped document (title/type/layout/published/sections) is
  // invalid as a menu, proving the dispatch actually picked the menu
  // schema, not silently falling back to the page schema.
  const pageShaped = { schemaVersion: 4, title: 'X', type: 'page', layout: 'theme', published: true, sections: [] };
  assert.equal(validateContent('menus/main.json', pageShaped, themeSchemas).valid, false);
});
