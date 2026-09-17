import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRange } from '../../src/routes/media-public.ts';

// The Range parsing behind /media/*, unit-tested directly rather than
// only through the route: the semantics here are easy to get subtly
// wrong in ways that still return a plausible-looking 206 (serving the
// wrong region of a file), so each form is pinned on its own.

const SIZE = 1000;

test('no Range header at all means "send the whole file"', () => {
  assert.equal(resolveRange(undefined, SIZE), null);
});

test('Safari/iOS open a video with bytes=0-1 - the probe that has to work, or the video never plays', () => {
  assert.deepEqual(resolveRange('bytes=0-1', SIZE), { start: 0, end: 1 });
});

test('an ordinary closed range is inclusive at both ends', () => {
  // bytes=0-499 is 500 bytes, not 499 - the off-by-one that makes a
  // player stall at the very end of a file.
  assert.deepEqual(resolveRange('bytes=0-499', SIZE), { start: 0, end: 499 });
});

test('an open-ended range runs to the last byte', () => {
  assert.deepEqual(resolveRange('bytes=500-', SIZE), { start: 500, end: 999 });
});

test('a suffix range means the LAST n bytes, not the first n', () => {
  // The classic misreading. Read as "0 to 500" it silently serves the
  // wrong half of the file with a 206 that looks perfectly healthy.
  assert.deepEqual(resolveRange('bytes=-500', SIZE), { start: 500, end: 999 });
});

test('a suffix longer than the file clamps to the whole file rather than a negative start', () => {
  assert.deepEqual(resolveRange('bytes=-5000', SIZE), { start: 0, end: 999 });
});

test('an end past the last byte is clamped, not rejected - browsers routinely overshoot', () => {
  assert.deepEqual(resolveRange('bytes=0-999999', SIZE), { start: 0, end: 999 });
});

test('a start at or past the end is unsatisfiable, which has its own 416 response', () => {
  assert.equal(resolveRange('bytes=1000-', SIZE), 'unsatisfiable');
  assert.equal(resolveRange('bytes=1500-1600', SIZE), 'unsatisfiable');
});

test('a zero-length suffix is unsatisfiable', () => {
  assert.equal(resolveRange('bytes=-0', SIZE), 'unsatisfiable');
});

test('an inverted range is unsatisfiable', () => {
  assert.equal(resolveRange('bytes=500-100', SIZE), 'unsatisfiable');
});

test('a multi-range request falls back to the whole file rather than a wrong multipart body', () => {
  // Answering multipart/byteranges incorrectly is worse than ignoring
  // Range, which a server is always permitted to do.
  assert.equal(resolveRange('bytes=0-99,200-299', SIZE), null);
});

test('malformed or non-bytes units fall back to the whole file', () => {
  for (const header of ['bytes=abc-def', 'items=0-10', 'bytes=', 'bytes=-', 'nonsense']) {
    assert.equal(resolveRange(header, SIZE), null, `expected ${header} to be ignored`);
  }
});

test('surrounding whitespace is tolerated', () => {
  assert.deepEqual(resolveRange('  bytes=0-1  ', SIZE), { start: 0, end: 1 });
});
