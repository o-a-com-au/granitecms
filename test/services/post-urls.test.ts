import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlogUrl, postPathToUrl, urlToPostPath } from '../../src/services/post-urls.ts';

test('isBlogUrl recognises both /blog itself and /blog/... URLs', () => {
  assert.equal(isBlogUrl('/blog'), true);
  assert.equal(isBlogUrl('/blog/'), true);
  assert.equal(isBlogUrl('/blog/hello-world'), true);
  assert.equal(isBlogUrl('/blogging'), false);
  assert.equal(isBlogUrl('/about'), false);
});

test('urlToPostPath maps a flat /blog/<slug> URL to <slug>.json', () => {
  assert.equal(urlToPostPath('/blog/hello-world'), 'hello-world.json');
});

test('urlToPostPath returns null for a nested slug (posts are flat only)', () => {
  assert.equal(urlToPostPath('/blog/2026/hello-world'), null);
});

test('urlToPostPath returns null for /blog with no slug at all', () => {
  assert.equal(urlToPostPath('/blog'), null);
  assert.equal(urlToPostPath('/blog/'), null);
});

test('urlToPostPath returns null for a URL not under /blog/', () => {
  assert.equal(urlToPostPath('/about'), null);
});

test('postPathToUrl and urlToPostPath round-trip for a flat slug', () => {
  const url = postPathToUrl('hello-world.json');
  assert.equal(url, '/blog/hello-world');
  assert.equal(urlToPostPath(url), 'hello-world.json');
});
