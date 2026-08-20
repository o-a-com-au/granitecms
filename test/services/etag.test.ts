import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEtag, etagsMatch } from '../../src/services/etag.ts';

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

test('etagsMatch treats a strong etag and its weak-prefixed form as equal (RFC 7232 weak comparison)', () => {
  const strong = computeEtag(Buffer.from('hello world'));
  const weak = `W/${strong}`;
  assert.equal(etagsMatch(strong, weak), true);
  assert.equal(etagsMatch(weak, strong), true);
  assert.equal(etagsMatch(weak, weak), true);
});

test('etagsMatch still rejects genuinely different content regardless of weak prefixing', () => {
  const a = computeEtag(Buffer.from('hello world'));
  const b = computeEtag(Buffer.from('hello there'));
  assert.equal(etagsMatch(a, b), false);
  assert.equal(etagsMatch(a, `W/${b}`), false);
});
