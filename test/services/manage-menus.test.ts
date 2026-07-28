import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { loadSiteConfig } from '../../src/config.ts';
import { ManageMenuError, saveMenu } from '../../src/services/manage-menus.ts';
import { createTmpSiteRoot } from '../helpers/tmp-site.ts';

const author = { name: 'Jane Editor', email: 'jane@example.com' };

function menu(label: string): object {
  return { schemaVersion: 1, items: [{ label, url: '/' }] };
}

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

test('saveMenu writes the file and commits immediately, no draft step', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    const etag = await saveMenu(config, 'main.json', menu('Home'), 'no-prior-file', 'create main menu', author);

    assert.equal(typeof etag, 'string');
    assert.equal(commitCount(siteRoot), before + 1);
  } finally {
    cleanup();
  }
});

test('saveMenu rejects a stale If-Match with conflict, matching drafts.ts semantics', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);
    await saveMenu(config, 'main.json', menu('Home'), 'no-prior-file', 'create', author);

    await assert.rejects(
      saveMenu(config, 'main.json', menu('Changed'), '"wrong-etag"', 'update', author),
      (error: unknown) => error instanceof ManageMenuError && error.reason === 'conflict',
    );
  } finally {
    cleanup();
  }
});

test('saveMenu rejects invalid content with validation-failed, writes nothing', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await assert.rejects(
      saveMenu(config, 'main.json', { schemaVersion: 1, notItems: 'oops' }, 'no-prior-file', 'create', author),
      (error: unknown) => error instanceof ManageMenuError && error.reason === 'validation-failed',
    );

    assert.equal(commitCount(siteRoot), before, 'no commit should be created on validation failure');
  } finally {
    cleanup();
  }
});

test('saveMenu on a brand-new path skips the ETag comparison regardless of the supplied If-Match value', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot });
    const config = loadSiteConfig(siteRoot);

    // Any non-empty placeholder satisfies it for a wholly new resource,
    // matching saveDraftJob's own established precedent.
    const etag = await saveMenu(config, 'new-menu.json', menu('New'), 'anything-at-all', 'create', author);
    assert.equal(typeof etag, 'string');
  } finally {
    cleanup();
  }
});
