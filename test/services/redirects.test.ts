import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedirectError, addRedirect, removeRedirectForPath } from '../../src/services/redirects.ts';

test('E4: redirect chains are collapsed at write time: after /a to /b then /b to /c, the stored entry maps /a directly to /c', () => {
  let redirects = addRedirect({}, '/a', '/b');
  assert.deepEqual(redirects, { '/a': '/b' });

  redirects = addRedirect(redirects, '/b', '/c');
  assert.deepEqual(redirects, { '/a': '/c', '/b': '/c' });
});

test('a pre-existing chain unrelated to the newly added entry is left uncollapsed', () => {
  const redirects = addRedirect({ '/x': '/y', '/y': '/z' }, '/w', '/x');
  assert.deepEqual(redirects, { '/x': '/y', '/y': '/z', '/w': '/z' });
});

test('a redirect that would create a direct two-entry cycle is rejected', () => {
  assert.throws(
    () => addRedirect({ '/a': '/b' }, '/b', '/a'),
    (error: unknown) => error instanceof RedirectError && error.reason === 'redirect-cycle',
  );
});

test('a redirect that would create a self-referencing entry is rejected', () => {
  assert.throws(
    () => addRedirect({}, '/a', '/a'),
    (error: unknown) => error instanceof RedirectError && error.reason === 'redirect-cycle',
  );
});

test('removeRedirectForPath removes only the matching entry', () => {
  const redirects = { '/a': '/b', '/c': '/d' };
  assert.deepEqual(removeRedirectForPath(redirects, '/a'), { '/c': '/d' });
});

test('removeRedirectForPath is a no-op when the path has no redirect entry', () => {
  const redirects = { '/a': '/b' };
  assert.deepEqual(removeRedirectForPath(redirects, '/does-not-exist'), redirects);
});
