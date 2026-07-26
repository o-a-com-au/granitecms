import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEtag } from '../../src/services/etag.ts';

test('computeEtag is stable for identical bytes', () => {
  const a = computeEtag(Buffer.from('hello world'));
  const b = computeEtag(Buffer.from('hello world'));
  assert.equal(a, b);
});

test('computeEtag differs when the bytes differ', () => {
  const a = computeEtag(Buffer.from('hello world'));
  const b = computeEtag(Buffer.from('hello there'));
  assert.notEqual(a, b);
});

test('computeEtag returns a quoted strong ETag', () => {
  const etag = computeEtag(Buffer.from('hello world'));
  assert.match(etag, /^"[0-9a-f]{64}"$/);
});
