import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mimeTypeFor } from '../../src/services/mime-types.ts';

test('mimeTypeFor recognises the common theme asset types', () => {
  assert.equal(mimeTypeFor('style.css'), 'text/css; charset=utf-8');
  assert.equal(mimeTypeFor('site.js'), 'text/javascript; charset=utf-8');
  assert.equal(mimeTypeFor('photo.jpg'), 'image/jpeg');
  assert.equal(mimeTypeFor('icon.svg'), 'image/svg+xml');
});

// Found live: robots.txt served as application/octet-stream (the
// DEFAULT_MIME_TYPE fallback) because .txt was never registered -
// every browser treats that as "download this file" rather than
// displaying it, even though the content is plain text. These types
// exist specifically for theme/root/'s broader use case (robots.txt,
// .well-known/* verification files, Google site-verification HTML).
test('mimeTypeFor recognises the theme/root/ mirror\'s file types (robots.txt, .well-known verification files, etc.)', () => {
  assert.equal(mimeTypeFor('robots.txt'), 'text/plain; charset=utf-8');
  assert.equal(mimeTypeFor('security.txt'), 'text/plain; charset=utf-8');
  assert.equal(mimeTypeFor('google1234567890.html'), 'text/html; charset=utf-8');
  assert.equal(mimeTypeFor('legacy.htm'), 'text/html; charset=utf-8');
  assert.equal(mimeTypeFor('custom.xml'), 'application/xml; charset=utf-8');
});

test('mimeTypeFor falls back to application/octet-stream for a genuinely unknown extension', () => {
  assert.equal(mimeTypeFor('archive.zip'), 'application/octet-stream');
});

test('mimeTypeFor is case-insensitive on the extension', () => {
  assert.equal(mimeTypeFor('IMAGE.JPG'), 'image/jpeg');
  assert.equal(mimeTypeFor('ROBOTS.TXT'), 'text/plain; charset=utf-8');
});
