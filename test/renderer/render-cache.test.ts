import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderCache } from '../../src/renderer/render-cache.ts';

test('a fresh cache has no entry for any path', () => {
  const cache = createRenderCache();
  assert.equal(cache.get('pages/about.json'), undefined);
});

test('set then get returns the exact entry stored', () => {
  const cache = createRenderCache();
  const entry = { html: '<p>About</p>', pageMtimeMs: 100, menusMtimeMs: 50 };
  cache.set('pages/about.json', entry);
  assert.deepEqual(cache.get('pages/about.json'), entry);
});

test('two different paths are stored independently', () => {
  const cache = createRenderCache();
  cache.set('pages/about.json', { html: 'about', pageMtimeMs: 1, menusMtimeMs: 1 });
  cache.set('pages/contact.json', { html: 'contact', pageMtimeMs: 2, menusMtimeMs: 1 });
  assert.equal(cache.get('pages/about.json')?.html, 'about');
  assert.equal(cache.get('pages/contact.json')?.html, 'contact');
});

test('setting the same path again replaces the previous entry', () => {
  const cache = createRenderCache();
  cache.set('pages/about.json', { html: 'old', pageMtimeMs: 1, menusMtimeMs: 1 });
  cache.set('pages/about.json', { html: 'new', pageMtimeMs: 2, menusMtimeMs: 1 });
  assert.equal(cache.get('pages/about.json')?.html, 'new');
});

// Two independent instances (mirroring two separate bootSite() calls,
// e.g. two tests in the same process) never share state - the whole
// point of createRenderCache() being a factory, not a module-level
// singleton (see the file's own comment for why).
test('two separately-created caches never share entries', () => {
  const cacheA = createRenderCache();
  const cacheB = createRenderCache();
  cacheA.set('pages/about.json', { html: 'from A', pageMtimeMs: 1, menusMtimeMs: 1 });
  assert.equal(cacheB.get('pages/about.json'), undefined);
});
