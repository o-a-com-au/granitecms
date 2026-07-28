import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import {
  RedirectError,
  addRedirect,
  isValidRedirectTarget,
  loadRedirects,
  loadRedirectsStrict,
  removeRedirectForPath,
} from '../../src/services/redirects.ts';

test('E4: redirect chains are collapsed at write time: after /a to /b then /b to /c, the stored entry maps /a directly to /c', () => {
  let entries = addRedirect([], '/a', '/b').entries;
  assert.deepEqual(entries, [{ from: '/a', to: '/b' }]);

  entries = addRedirect(entries, '/b', '/c').entries;
  assert.deepEqual(entries, [
    { from: '/a', to: '/c' },
    { from: '/b', to: '/c' },
  ]);
});

test('addRedirect returns the retargeted entries so a caller can surface them, not just silently rewrite', () => {
  const result = addRedirect([{ from: '/a', to: '/b', note: 'campaign A' }], '/b', '/c');
  assert.deepEqual(result.entries, [
    { from: '/a', to: '/c', note: 'campaign A' },
    { from: '/b', to: '/c' },
  ]);
  assert.deepEqual(result.retargeted, [{ from: '/a', to: '/c', note: 'campaign A' }]);
});

test('a pre-existing chain unrelated to the newly added entry is left uncollapsed', () => {
  const entries = addRedirect(
    [
      { from: '/x', to: '/y' },
      { from: '/y', to: '/z' },
    ],
    '/w',
    '/x',
  ).entries;
  assert.deepEqual(entries, [
    { from: '/x', to: '/y' },
    { from: '/y', to: '/z' },
    { from: '/w', to: '/z' },
  ]);
});

test('a redirect that would create a direct two-entry cycle is rejected', () => {
  assert.throws(
    () => addRedirect([{ from: '/a', to: '/b' }], '/b', '/a'),
    (error: unknown) => error instanceof RedirectError && error.reason === 'redirect-cycle',
  );
});

test('a redirect that would create a self-referencing entry is rejected', () => {
  assert.throws(
    () => addRedirect([], '/a', '/a'),
    (error: unknown) => error instanceof RedirectError && error.reason === 'redirect-cycle',
  );
});

test('addRedirect replaces an existing entry for the same from, rather than duplicating it', () => {
  const entries = addRedirect([{ from: '/a', to: '/b' }], '/a', '/c').entries;
  assert.deepEqual(entries, [{ from: '/a', to: '/c' }]);
});

test('addRedirect attaches an optional note to the new entry', () => {
  const entries = addRedirect([], '/a', '/b', 'why this exists').entries;
  assert.deepEqual(entries, [{ from: '/a', to: '/b', note: 'why this exists' }]);
});

test('removeRedirectForPath removes only the matching entry', () => {
  const entries = [
    { from: '/a', to: '/b' },
    { from: '/c', to: '/d' },
  ];
  assert.deepEqual(removeRedirectForPath(entries, '/a'), [{ from: '/c', to: '/d' }]);
});

test('removeRedirectForPath is a no-op when the path has no redirect entry', () => {
  const entries = [{ from: '/a', to: '/b' }];
  assert.deepEqual(removeRedirectForPath(entries, '/does-not-exist'), entries);
});

test('isValidRedirectTarget accepts an internal path and rejects external/protocol-relative/control-character values', () => {
  assert.equal(isValidRedirectTarget('/pages/new-offer'), true);
  assert.equal(isValidRedirectTarget(''), false);
  assert.equal(isValidRedirectTarget('https://example.com'), false);
  assert.equal(isValidRedirectTarget('//example.com'), false);
  assert.equal(isValidRedirectTarget('/a\r\nSet-Cookie: x'), false);
});

function makeSite(): { siteRoot: string; cleanup: () => void } {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-redirects-test-'));
  return { siteRoot, cleanup: () => rmSync(siteRoot, { recursive: true, force: true }) };
}

test('loadRedirects upgrades the old flat-map shape in memory without requiring a schemaVersion', () => {
  const { siteRoot, cleanup } = makeSite();
  try {
    const config = loadSiteConfig(siteRoot);
    writeFileSync(config.redirectsPath, JSON.stringify({ '/old': '/new' }));
    assert.deepEqual(loadRedirects(config), {
      schemaVersion: 1,
      entries: [{ from: '/old', to: '/new' }],
    });
  } finally {
    cleanup();
  }
});

test('loadRedirects returns empty entries, not a crash, for a missing file', () => {
  const { siteRoot, cleanup } = makeSite();
  try {
    const config = loadSiteConfig(siteRoot);
    assert.deepEqual(loadRedirects(config), { schemaVersion: 1, entries: [] });
  } finally {
    cleanup();
  }
});

test('loadRedirects gracefully returns empty entries for a malformed new-shape file (has entries key, but not a valid array) - never crashes public page serving', () => {
  const { siteRoot, cleanup } = makeSite();
  try {
    const config = loadSiteConfig(siteRoot);
    writeFileSync(config.redirectsPath, JSON.stringify({ schemaVersion: 1, entries: 'not-an-array' }));
    assert.deepEqual(loadRedirects(config), { schemaVersion: 1, entries: [] });
  } finally {
    cleanup();
  }
});

test('loadRedirectsStrict throws on the same malformed new-shape file, rather than silently treating it as empty and risking an overwrite', () => {
  const { siteRoot, cleanup } = makeSite();
  try {
    const config = loadSiteConfig(siteRoot);
    writeFileSync(config.redirectsPath, JSON.stringify({ schemaVersion: 1, entries: 'not-an-array' }));
    assert.throws(
      () => loadRedirectsStrict(config),
      (error: unknown) => error instanceof RedirectError && error.reason === 'malformed-file',
    );
  } finally {
    cleanup();
  }
});

test('loadRedirectsStrict throws on invalid JSON, rather than silently treating it as empty', () => {
  const { siteRoot, cleanup } = makeSite();
  try {
    const config = loadSiteConfig(siteRoot);
    writeFileSync(config.redirectsPath, '{not json');
    assert.throws(
      () => loadRedirectsStrict(config),
      (error: unknown) => error instanceof RedirectError && error.reason === 'malformed-file',
    );
  } finally {
    cleanup();
  }
});

test('loadRedirectsStrict upgrades the old flat-map shape exactly like loadRedirects', () => {
  const { siteRoot, cleanup } = makeSite();
  try {
    const config = loadSiteConfig(siteRoot);
    writeFileSync(config.redirectsPath, JSON.stringify({ '/old': '/new' }));
    assert.deepEqual(loadRedirectsStrict(config), {
      schemaVersion: 1,
      entries: [{ from: '/old', to: '/new' }],
    });
  } finally {
    cleanup();
  }
});

test('loadRedirectsStrict returns empty entries for a missing file, not a throw', () => {
  const { siteRoot, cleanup } = makeSite();
  try {
    const config = loadSiteConfig(siteRoot);
    assert.deepEqual(loadRedirectsStrict(config), { schemaVersion: 1, entries: [] });
  } finally {
    cleanup();
  }
});
