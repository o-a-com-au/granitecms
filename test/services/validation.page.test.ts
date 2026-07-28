import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validatePage } from '../../src/services/validation.ts';
import type { ThemeSchemas } from '../../src/services/validation.ts';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');

function readJson(...segments: string[]): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, ...segments), 'utf-8')) as unknown;
}

// Inlined rather than read from the theme fixture: this test is about
// page/post envelope validation, not about the theme file format
// (which is theme-component-file.test.ts's job) - decoupling the two
// means a theme fixture restructuring never breaks this test.
const themeSchemas: ThemeSchemas = {
  sections: {
    hero: {
      type: 'object',
      additionalProperties: false,
      required: ['heading'],
      properties: {
        heading: { type: 'string', minLength: 1 },
        subheading: { type: 'string' },
        columns: { type: 'integer', minimum: 1, maximum: 4 },
      },
    },
  },
  blocks: {
    button: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'url'],
      properties: {
        label: { type: 'string', minLength: 1 },
        url: { type: 'string', minLength: 1 },
      },
    },
  },
};

test('A1: a page with all required fields (including schemaVersion and published) validates successfully', () => {
  const page = readJson('pages', 'valid-page.json');
  const result = validatePage(page, themeSchemas);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('A2: a page missing a required field fails validation with an error naming the field and path', () => {
  const page = readJson('pages', 'missing-required.json');
  const result = validatePage(page, themeSchemas);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.path === '/published');
  assert.ok(error, 'expected an error naming the missing "published" field at path /published');
  assert.equal(error?.keyword, 'required');
});

test('A6: page validation errors are structured data (path, message, keyword), not just strings', () => {
  const page = readJson('pages', 'missing-required.json');
  const result = validatePage(page, themeSchemas);
  assert.equal(result.valid, false);
  for (const error of result.errors) {
    assert.equal(typeof error.path, 'string');
    assert.equal(typeof error.message, 'string');
    assert.equal(typeof error.keyword, 'string');
  }
});

test('A7: an unknown/extra property on a page is rejected (additionalProperties false)', () => {
  const page = readJson('pages', 'extra-property.json');
  const result = validatePage(page, themeSchemas);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.keyword === 'additionalProperties');
  assert.ok(error, 'expected an additionalProperties error');
  assert.equal(error?.path, '/unexpectedField');
});
