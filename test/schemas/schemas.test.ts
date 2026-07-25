import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';

const schemasDir = join(import.meta.dirname, '..', '..', 'src', 'schemas');

function readSchema(filename: string): object {
  return JSON.parse(readFileSync(join(schemasDir, filename), 'utf-8')) as object;
}

test('page.schema.json and instance.schema.json are valid JSON Schema documents Ajv can compile together', () => {
  const ajv = new Ajv({ strict: false });
  const instanceSchema = readSchema('instance.schema.json');
  const pageSchema = readSchema('page.schema.json');

  ajv.addSchema(instanceSchema);
  const validatePage = ajv.compile(pageSchema);

  assert.equal(typeof validatePage, 'function');
});
