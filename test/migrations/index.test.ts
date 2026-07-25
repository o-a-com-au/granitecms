import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_SCHEMA_VERSION, migrations } from '../../src/migrations/index.ts';
import { validatePage } from '../../src/services/validation.ts';
import type { ThemeSchemas } from '../../src/services/validation.ts';

const themeSchemas: ThemeSchemas = { sections: {}, blocks: {} };

const migrateV1ToV2 = migrations[1];
assert.ok(migrateV1ToV2, 'expected a migration registered for schemaVersion 1');

test('CURRENT_SCHEMA_VERSION is 2', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 2);
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

test('a migrated v1 page validates against page.schema.json', () => {
  const input = { schemaVersion: 1, title: 'About', published: true, sections: [] };
  const migrated = migrateV1ToV2(input);

  const result = validatePage(migrated, themeSchemas);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});
