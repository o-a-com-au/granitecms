import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PathSafetyError, sanitisePath } from '../../src/services/path-safety.ts';
import { createTmpSiteRoot } from '../helpers/tmp-site.ts';

test('B3: a content path containing ".." is rejected before any fs call', () => {
  // A nonexistent root proves rejection happens without touching disk:
  // if this call needed to stat the root, it would throw ENOENT instead.
  assert.throws(
    () => sanitisePath('/nonexistent/root', '../../etc/passwd'),
    (error: unknown) => error instanceof PathSafetyError && error.reason === 'traversal-segment',
  );
});

test('B4: a percent-encoded traversal (%2e%2e%2f) is rejected before any fs call', () => {
  assert.throws(
    () => sanitisePath('/nonexistent/root', '%2e%2e%2fetc%2fpasswd'),
    (error: unknown) => error instanceof PathSafetyError && error.reason === 'traversal-segment',
  );
});

test('B4: an encoded slash disguising a segment boundary is also rejected', () => {
  assert.throws(
    () => sanitisePath('/nonexistent/root', 'a%2f..%2fetc'),
    (error: unknown) => error instanceof PathSafetyError && error.reason === 'traversal-segment',
  );
});

test('B5: an absolute path passed as a content path is rejected', () => {
  assert.throws(
    () => sanitisePath('/nonexistent/root', '/etc/passwd'),
    (error: unknown) => error instanceof PathSafetyError && error.reason === 'absolute-path',
  );
});

test('B5: an encoded absolute path is also rejected as absolute-path', () => {
  assert.throws(
    () => sanitisePath('/nonexistent/root', '%2fetc%2fpasswd'),
    (error: unknown) => error instanceof PathSafetyError && error.reason === 'absolute-path',
  );
});

test('malformed percent-encoding is rejected rather than passed through', () => {
  assert.throws(
    () => sanitisePath('/nonexistent/root', '%E0%A4%A'),
    (error: unknown) => error instanceof PathSafetyError && error.reason === 'malformed-encoding',
  );
});

test('a path resolving to exactly the root is rejected (resolves-to-root hardening)', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    assert.throws(
      () => sanitisePath(siteRoot, '.'),
      (error: unknown) => error instanceof PathSafetyError && error.reason === 'resolves-to-root',
    );
    assert.throws(
      () => sanitisePath(siteRoot, ''),
      (error: unknown) => error instanceof PathSafetyError && error.reason === 'resolves-to-root',
    );
  } finally {
    cleanup();
  }
});

test('B6: a symlink inside the content tree pointing outside the site root is not followed', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  const { siteRoot: outsideRoot, cleanup: cleanupOutside } = createTmpSiteRoot();
  try {
    writeFileSync(join(outsideRoot, 'secret.json'), '{}');
    symlinkSync(join(outsideRoot, 'secret.json'), join(siteRoot, 'escape.json'));

    assert.throws(
      () => sanitisePath(siteRoot, 'escape.json'),
      (error: unknown) => error instanceof PathSafetyError && error.reason === 'symlink-escape',
    );
  } finally {
    cleanup();
    cleanupOutside();
  }
});

test('a symlinked directory inside the content tree pointing outside the site root is not followed', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  const { siteRoot: outsideRoot, cleanup: cleanupOutside } = createTmpSiteRoot();
  try {
    mkdirSync(join(outsideRoot, 'secrets'));
    writeFileSync(join(outsideRoot, 'secrets', 'file.json'), '{}');
    symlinkSync(join(outsideRoot, 'secrets'), join(siteRoot, 'escape-dir'));

    assert.throws(
      () => sanitisePath(siteRoot, 'escape-dir/file.json'),
      (error: unknown) => error instanceof PathSafetyError && error.reason === 'symlink-escape',
    );
  } finally {
    cleanup();
    cleanupOutside();
  }
});

test('a legitimate path inside the site root, including one that does not exist yet, is accepted', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const resolved = sanitisePath(siteRoot, 'pages/about/team.json');
    assert.equal(resolved, join(siteRoot, 'pages', 'about', 'team.json'));
  } finally {
    cleanup();
  }
});
