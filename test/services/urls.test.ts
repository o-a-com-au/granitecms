import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pagePathToUrl, urlToPagePath } from '../../src/services/urls.ts';

test('E1: a page at content/pages/about/team.json resolves at URL /about/team', () => {
  assert.equal(pagePathToUrl('about/team.json'), '/about/team');
  assert.equal(urlToPagePath('/about/team'), 'about/team.json');
});

test('urlToPagePath and pagePathToUrl round-trip for nested and leaf pages', () => {
  for (const url of ['/about', '/about/team', '/blog/2024/first-post']) {
    assert.equal(pagePathToUrl(urlToPagePath(url)), url);
  }
});

test('the root URL maps to index.json and back', () => {
  assert.equal(urlToPagePath('/'), 'index.json');
  assert.equal(pagePathToUrl('index.json'), '/');
});

test('a trailing slash on a URL does not change the resolved page path', () => {
  assert.equal(urlToPagePath('/about/team/'), 'about/team.json');
});
