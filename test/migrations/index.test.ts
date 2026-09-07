import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_SCHEMA_VERSION, migrations } from '../../src/migrations/index.ts';
import { validatePage } from '../../src/services/validation.ts';
import type { ThemeSchemas } from '../../src/services/validation.ts';

const themeSchemas: ThemeSchemas = { sections: {}, blocks: {}, acceptsBlocks: { sections: {}, blocks: {} } };

const migrateV1ToV2 = migrations[1];
assert.ok(migrateV1ToV2, 'expected a migration registered for schemaVersion 1');

const migrateV2ToV3 = migrations[2];
assert.ok(migrateV2ToV3, 'expected a migration registered for schemaVersion 2');

const migrateV3ToV4 = migrations[3];
assert.ok(migrateV3ToV4, 'expected a migration registered for schemaVersion 3');

const migrateV4ToV5 = migrations[4];
assert.ok(migrateV4ToV5, 'expected a migration registered for schemaVersion 4');

const migrateV5ToV6 = migrations[5];
assert.ok(migrateV5ToV6, 'expected a migration registered for schemaVersion 5');

test('CURRENT_SCHEMA_VERSION is 6', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 6);
});

test('migrateV1ToV2 is a trivial identity migration: only schemaVersion changes', () => {
  const input = Object.freeze({
    schemaVersion: 1,
    title: 'About',
    published: true,
    sections: [],
  });

  const migrated = migrateV1ToV2(input);

  assert.deepEqual(migrated, {
    schemaVersion: 2,
    title: 'About',
    published: true,
    sections: [],
  });
  // The frozen input itself must be untouched (purity, same technique
  // as Group F's runner-level tests).
  assert.deepEqual(input, { schemaVersion: 1, title: 'About', published: true, sections: [] });
});

test('migrateV2ToV3 adds a "page" type default: only schemaVersion and type change', () => {
  const input = Object.freeze({
    schemaVersion: 2,
    title: 'About',
    published: true,
    sections: [],
  });

  const migrated = migrateV2ToV3(input);

  assert.deepEqual(migrated, {
    schemaVersion: 3,
    title: 'About',
    published: true,
    sections: [],
    type: 'page',
  });
  assert.deepEqual(input, { schemaVersion: 2, title: 'About', published: true, sections: [] });
});

test('migrateV3ToV4 adds a "theme" layout default: only schemaVersion and layout change', () => {
  const input = Object.freeze({
    schemaVersion: 3,
    title: 'About',
    type: 'page',
    published: true,
    sections: [],
  });

  const migrated = migrateV3ToV4(input);

  assert.deepEqual(migrated, {
    schemaVersion: 4,
    title: 'About',
    type: 'page',
    published: true,
    sections: [],
    layout: 'theme',
  });
  assert.deepEqual(input, { schemaVersion: 3, title: 'About', type: 'page', published: true, sections: [] });
});

test('migrateV4ToV5 adds a "name" default copied from the existing title: only schemaVersion and name change', () => {
  const input = Object.freeze({
    schemaVersion: 4,
    title: 'About',
    type: 'page',
    layout: 'theme',
    published: true,
    sections: [],
  });

  const migrated = migrateV4ToV5(input);

  assert.deepEqual(migrated, {
    schemaVersion: 5,
    title: 'About',
    type: 'page',
    layout: 'theme',
    published: true,
    sections: [],
    name: 'About',
  });
  assert.deepEqual(input, {
    schemaVersion: 4,
    title: 'About',
    type: 'page',
    layout: 'theme',
    published: true,
    sections: [],
  });
});

test('migrateV5ToV6 leaves an already-named page untouched: only schemaVersion changes', () => {
  const input = Object.freeze({
    schemaVersion: 5,
    name: 'About Us',
    title: 'About',
    type: 'page',
    layout: 'theme',
    published: true,
    sections: [],
  });

  const migrated = migrateV5ToV6(input);

  assert.deepEqual(migrated, {
    schemaVersion: 6,
    name: 'About Us',
    title: 'About',
    type: 'page',
    layout: 'theme',
    published: true,
    sections: [],
  });
});

test('migrateV5ToV6 backfills "name" from title for a legacy post file, which never had one', () => {
  const input = Object.freeze({
    schemaVersion: 5,
    title: 'Hello World',
    type: 'post',
    layout: 'theme',
    published: true,
    author: 'Jane Editor',
    publishDate: '2026-07-27',
    tags: ['news'],
    sections: [],
  });

  const migrated = migrateV5ToV6(input);

  assert.deepEqual(migrated, {
    schemaVersion: 6,
    name: 'Hello World',
    title: 'Hello World',
    type: 'post',
    layout: 'theme',
    published: true,
    author: 'Jane Editor',
    publishDate: '2026-07-27',
    tags: ['news'],
    sections: [],
  });
});

test('a migrated v1 page validates against page.schema.json (chained through every step to current)', () => {
  const input = { schemaVersion: 1, title: 'About', published: true, sections: [] };
  const migrated = migrateV5ToV6(migrateV4ToV5(migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(input)))));

  const result = validatePage(migrated, themeSchemas);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});
