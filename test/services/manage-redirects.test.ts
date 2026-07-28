import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { loadSiteConfig } from '../../src/config.ts';
import {
  ManageRedirectError,
  createRedirect,
  deleteRedirect,
  updateRedirect,
} from '../../src/services/manage-redirects.ts';
import { loadRedirects } from '../../src/services/redirects.ts';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

const author = { name: 'Jane Editor', email: 'jane@example.com' };

function pageJson(title: string): string {
  return JSON.stringify({ schemaVersion: 1, title, published: true, sections: [] });
}

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

test('createRedirect writes a new entry and commits immediately, with no draft step', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    const result = await createRedirect(config, '/summer-promo', '/pages/new-offer', 'summer campaign', 'create redirect', author);

    assert.equal(commitCount(siteRoot), before + 1);
    assert.deepEqual(result?.entry, { from: '/summer-promo', to: '/pages/new-offer', note: 'summer campaign' });
    assert.deepEqual(loadRedirects(config).entries, [
      { from: '/summer-promo', to: '/pages/new-offer', note: 'summer campaign' },
    ]);
  } finally {
    cleanup();
  }
});

test('createRedirect rejects with already-exists when from already has an entry', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);
    await createRedirect(config, '/a', '/b', undefined, 'first', author);

    await assert.rejects(
      createRedirect(config, '/a', '/c', undefined, 'second', author),
      (error: unknown) => error instanceof ManageRedirectError && error.reason === 'already-exists',
    );
  } finally {
    cleanup();
  }
});

test('createRedirect rejects with live-content-exists when a live page already sits at from', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    const config = loadSiteConfig(siteRoot);

    await assert.rejects(
      createRedirect(config, '/about', '/company', undefined, 'create redirect', author),
      (error: unknown) => error instanceof ManageRedirectError && error.reason === 'live-content-exists',
    );
  } finally {
    cleanup();
  }
});

test('createRedirect rejects an external target', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);

    await assert.rejects(
      createRedirect(config, '/a', 'https://example.com', undefined, 'create redirect', author),
      (error: unknown) => error instanceof ManageRedirectError && error.reason === 'invalid-target',
    );
  } finally {
    cleanup();
  }
});

test('createRedirect rejects a from that is not an internal path', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);

    await assert.rejects(
      createRedirect(config, '//example.com', '/somewhere', undefined, 'create redirect', author),
      (error: unknown) => error instanceof ManageRedirectError && error.reason === 'invalid-from'
    );
  } finally {
    cleanup();
  }
});

test('createRedirect rejects a redirect that would create a cycle', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);
    await createRedirect(config, '/a', '/b', undefined, 'first', author);

    await assert.rejects(
      createRedirect(config, '/b', '/a', undefined, 'second', author),
      (error: unknown) => error instanceof ManageRedirectError && error.reason === 'redirect-cycle',
    );
  } finally {
    cleanup();
  }
});

test('updateRedirect changes an existing entry and reuses chain-collapse, in one commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);
    await createRedirect(config, '/a', '/b', 'original note', 'create', author);
    const before = commitCount(siteRoot);

    const result = await updateRedirect(config, '/a', '/c', 'updated note', 'update redirect', author);

    assert.equal(commitCount(siteRoot), before + 1);
    assert.deepEqual(result?.entry, { from: '/a', to: '/c', note: 'updated note' });
    assert.deepEqual(loadRedirects(config).entries, [{ from: '/a', to: '/c', note: 'updated note' }]);
  } finally {
    cleanup();
  }
});

test('createRedirect surfaces retargeted entries when chain-collapse silently repoints another, note-bearing entry', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);
    // /a -> /b already exists, carrying a human-authored note.
    await createRedirect(config, '/a', '/b', 'campaign A', 'create a', author);

    // Adding /b -> /c means /a's existing entry now resolves through an
    // extra hop unless collapsed - it is collapsed immediately, and the
    // rewrite must be surfaced since /a's entry carries a note.
    const result = await createRedirect(config, '/b', '/c', undefined, 'create b', author);

    assert.deepEqual(result?.retargeted, [{ from: '/a', to: '/c', note: 'campaign A' }]);
    assert.deepEqual(loadRedirects(config).entries, [
      { from: '/a', to: '/c', note: 'campaign A' },
      { from: '/b', to: '/c' },
    ]);
  } finally {
    cleanup();
  }
});

test('updateRedirect rejects with not-found when from has no entry', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);

    await assert.rejects(
      updateRedirect(config, '/does-not-exist', '/b', undefined, 'update', author),
      (error: unknown) => error instanceof ManageRedirectError && error.reason === 'not-found',
    );
  } finally {
    cleanup();
  }
});

test('deleteRedirect removes an entry in one commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);
    await createRedirect(config, '/a', '/b', undefined, 'create', author);
    const before = commitCount(siteRoot);

    await deleteRedirect(config, '/a', 'delete redirect', author);

    assert.equal(commitCount(siteRoot), before + 1);
    assert.deepEqual(loadRedirects(config).entries, []);
  } finally {
    cleanup();
  }
});

test('deleteRedirect rejects with not-found when from has no entry', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);

    await assert.rejects(
      deleteRedirect(config, '/does-not-exist', 'delete', author),
      (error: unknown) => error instanceof ManageRedirectError && error.reason === 'not-found',
    );
  } finally {
    cleanup();
  }
});

test('createRedirect refuses a malformed redirects.json rather than silently overwriting it', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeJson(siteRoot, 'redirects.json', { schemaVersion: 1, entries: 'not-an-array' });
    execFileSync('git', ['add', '-A'], { cwd: siteRoot });
    execFileSync('git', ['commit', '-m', 'seed malformed redirects.json'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);

    await assert.rejects(
      createRedirect(config, '/a', '/b', undefined, 'create', author),
      (error: unknown) => error instanceof ManageRedirectError && error.reason === 'malformed-file',
    );
  } finally {
    cleanup();
  }
});
