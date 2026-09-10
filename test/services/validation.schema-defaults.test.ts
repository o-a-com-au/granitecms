import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredFieldsHaveValidDefaults } from '../../src/services/validation.ts';

// The six documented UI-hint format values are registered as no-op
// ajv formats specifically so a theme using exactly what
// guide-theme-authoring.md/AGENTS.md tells it to use produces zero
// boot noise - checked here (not just "does validation still pass",
// already covered above) because the whole point is the console stays
// quiet for these, while a genuine typo still warns. Routed through
// requiredFieldsHaveValidDefaults since that's what actually compiles
// the property sub-schema via the shared ajv instance - no separate
// export of that instance exists (or should) just for this test.
test('the six documented format values produce no "unknown format" console noise', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    for (const format of ['richtext', 'image', 'textarea', 'color', 'range', 'toggle']) {
      const schema = {
        type: 'object',
        required: ['field'],
        properties: { field: { type: 'string', format, default: 'x' } },
      };
      requiredFieldsHaveValidDefaults(schema);
    }
    assert.equal(warn.mock.calls.length, 0, 'none of the six documented formats should print anything');
  } finally {
    warn.mock.restore();
  }
});

test('an actually-unknown format (e.g. a theme author\'s typo) still warns - this isn\'t a blanket suppression', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const schema = {
      type: 'object',
      required: ['field'],
      properties: { field: { type: 'string', format: 'iamge', default: 'x' } },
    };
    requiredFieldsHaveValidDefaults(schema);
    assert.ok(warn.mock.calls.length >= 1, 'a genuinely unknown format must still warn at least once');
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /unknown format "iamge"/);
  } finally {
    warn.mock.restore();
  }
});

test('L1: a schema with no required array passes trivially', () => {
  assert.equal(requiredFieldsHaveValidDefaults({ type: 'object', properties: {} }), true);
});

test('L1: an empty required array passes trivially', () => {
  assert.equal(requiredFieldsHaveValidDefaults({ type: 'object', required: [], properties: {} }), true);
});

test('L1: every required field with a valid default passes', () => {
  const schema = {
    type: 'object',
    required: ['label', 'url'],
    properties: {
      label: { type: 'string', minLength: 1, default: 'Learn more' },
      url: { type: 'string', minLength: 1, default: '#' },
    },
  };
  assert.equal(requiredFieldsHaveValidDefaults(schema), true);
});

test('L1: a required field with no default at all fails', () => {
  const schema = {
    type: 'object',
    required: ['heading'],
    properties: { heading: { type: 'string', minLength: 1 } },
  };
  assert.equal(requiredFieldsHaveValidDefaults(schema), false);
});

test('L1: a required field missing from properties entirely fails', () => {
  const schema = { type: 'object', required: ['heading'], properties: {} };
  assert.equal(requiredFieldsHaveValidDefaults(schema), false);
});

test('L1: a default that does not satisfy the property\'s own constraint fails - a bare default is not enough', () => {
  const schema = {
    type: 'object',
    required: ['heading'],
    properties: { heading: { type: 'string', minLength: 1, default: '' } },
  };
  assert.equal(requiredFieldsHaveValidDefaults(schema), false);
});

test('L1: an enum-constrained default must be one of the allowed values', () => {
  const validSchema = {
    type: 'object',
    required: ['icon'],
    properties: { icon: { type: 'string', enum: ['bolt', 'block'], default: 'bolt' } },
  };
  const invalidSchema = {
    type: 'object',
    required: ['icon'],
    properties: { icon: { type: 'string', enum: ['bolt', 'block'], default: 'not-a-real-icon' } },
  };
  assert.equal(requiredFieldsHaveValidDefaults(validSchema), true);
  assert.equal(requiredFieldsHaveValidDefaults(invalidSchema), false);
});

// Real-world trigger: a theme author's schema declaring "$defs" at the
// top level and referencing one via "$ref" from inside a required
// property's own sub-schema. ajv.validate(propertySchema, ...) above
// compiles/runs that sub-schema in isolation, detached from the parent
// object the "$defs" entry actually lives on - the "$ref" can't
// resolve there, and Ajv throws (MissingRefError) rather than
// returning false. Confirmed this genuinely threw before the fix (a
// bare try/catch around the ajv.validate call) - this must return
// false, not throw, or the exact same schema crashes the whole boot
// process one layer up in theme-schemas.ts's loadTypeSchemas, which
// has nothing to catch it.
test('L1: a required property whose schema has an unresolvable $ref (e.g. pointing at a parent-level $defs entry) fails gracefully, does not throw', () => {
  const schema = {
    type: 'object',
    '$defs': {
      image: { type: 'object', properties: { url: { type: 'string' } } },
    },
    required: ['poster'],
    properties: {
      poster: { '$ref': '#/$defs/image', default: { url: '/images/a.jpg' } },
    },
  };
  assert.doesNotThrow(() => requiredFieldsHaveValidDefaults(schema));
  assert.equal(requiredFieldsHaveValidDefaults(schema), false);
});

test('L1: an array field\'s default must satisfy its own items/minItems constraints', () => {
  const validSchema = {
    type: 'object',
    required: ['features'],
    properties: {
      features: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, default: ['Feature one'] },
    },
  };
  const invalidSchema = {
    type: 'object',
    required: ['features'],
    properties: {
      features: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, default: [] },
    },
  };
  assert.equal(requiredFieldsHaveValidDefaults(validSchema), true);
  assert.equal(requiredFieldsHaveValidDefaults(invalidSchema), false);
});
