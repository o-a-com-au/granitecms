import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaFilename } from '../../src/media/filename.ts';

test('same bytes produce the same hash regardless of the original filename', () => {
  const bytes = Buffer.from('identical content');
  const a = buildMediaFilename('photo.jpg', bytes);
  const b = buildMediaFilename('completely-different-name.jpg', bytes);
  const hashOf = (filename: string) => filename.split('-')[0];
  assert.equal(hashOf(a), hashOf(b));
});

test('different bytes produce different hashes', () => {
  const a = buildMediaFilename('photo.jpg', Buffer.from('one'));
  const b = buildMediaFilename('photo.jpg', Buffer.from('two'));
  assert.notEqual(a, b);
});

test('the slug strips unsafe characters, spaces, and unicode, and lowercases', () => {
  const name = buildMediaFilename('My Summer Photo (2026)! café.jpg', Buffer.from('x'));
  assert.match(name, /^[0-9a-f]{64}-my-summer-photo-2026-caf\.jpg$/);
});

test('the extension is preserved and lowercased', () => {
  const name = buildMediaFilename('PHOTO.JPG', Buffer.from('x'));
  assert.ok(name.endsWith('.jpg'));
});

test('an all-punctuation original filename falls back to a non-empty slug', () => {
  const name = buildMediaFilename('!!!.jpg', Buffer.from('x'));
  assert.match(name, /^[0-9a-f]{64}-file\.jpg$/);
});
