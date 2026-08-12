import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateInstance } from '../../src/services/validation.ts';
import { loadThemeSchemas } from '../../src/services/theme-schemas.ts';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');
const themeSchemas = loadThemeSchemas(join(fixturesDir, 'theme'));

function readInstance(filename: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, 'instances', filename), 'utf-8')) as unknown;
}

test('A3: a section instance validates against its section type\'s schema.json from the theme', () => {
  const instance = readInstance('valid-hero-section.json');
  const result = validateInstance(instance, 'section', themeSchemas);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('A4: a section instance with a setting of the wrong type fails validation with a specific error', () => {
  const instance = readInstance('hero-wrong-type-setting.json');
  const result = validateInstance(instance, 'section', themeSchemas);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.path === '/settings/columns');
  assert.ok(error, 'expected a type error at /settings/columns');
  assert.equal(error?.keyword, 'type');
});

test('A5: a section instance referencing a section type that does not exist in the theme fails validation', () => {
  const instance = readInstance('unknown-type-section.json');
  const result = validateInstance(instance, 'section', themeSchemas);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.keyword === 'unknownType');
  assert.ok(error, 'expected an unknownType error');
  assert.match(error?.message ?? '', /does-not-exist/);
});

test('A6: instance validation errors are structured data (path, message, keyword), not just strings', () => {
  const instance = readInstance('unknown-type-section.json');
  const result = validateInstance(instance, 'section', themeSchemas);
  assert.equal(result.valid, false);
  for (const error of result.errors) {
    assert.equal(typeof error.path, 'string');
    assert.equal(typeof error.message, 'string');
    assert.equal(typeof error.keyword, 'string');
  }
});

test('A7: an unknown/extra property on a section instance is rejected (additionalProperties false)', () => {
  const instance = readInstance('extra-property-instance.json');
  const result = validateInstance(instance, 'section', themeSchemas);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.keyword === 'additionalProperties');
  assert.ok(error, 'expected an additionalProperties error');
  assert.equal(error?.path, '/unexpectedField');
});

test('A3: a block instance validates against its block type\'s schema.json from the theme', () => {
  const instance = { id: 'blk-1', type: 'button', settings: { label: 'Learn more', url: '/about' } };
  const result = validateInstance(instance, 'block', themeSchemas);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('K2: a block type declared in its parent\'s allowedBlocks passes', () => {
  const instance = readInstance('hero-allowed-block.json');
  const result = validateInstance(instance, 'section', themeSchemas);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('K2: a block type not declared in its parent\'s allowedBlocks fails with a structured error', () => {
  const instance = readInstance('hero-disallowed-block.json');
  const result = validateInstance(instance, 'section', themeSchemas);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.keyword === 'disallowedBlockType');
  assert.ok(error, 'expected a disallowedBlockType error');
  assert.equal(error?.path, '/blocks/0/type');
});

test('K2: a parent type with no allowedBlocks stays unrestricted (regression)', () => {
  // group.liquid accepts nested blocks and declares no allowedBlocks -
  // any block type must still be allowed underneath it.
  const instance = { id: 'blk-1', type: 'group', settings: {}, blocks: [{ id: 'blk-2', type: 'button', settings: { label: 'Learn more', url: '/about' } }] };
  const result = validateInstance(instance, 'block', themeSchemas);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});
