import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredFieldsHaveValidDefaults } from '../../src/services/validation.ts';

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
