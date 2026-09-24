import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { ManageMenuError, renameMenu, saveMenu } from '../../src/services/manage-menus.ts';
import { createTmpSiteRoot, TEST_IDENTITY_ENV } from '../helpers/tmp-site.ts';

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
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot, env: { ...process.env, ...TEST_IDENTITY_ENV } });
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
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot, env: { ...process.env, ...TEST_IDENTITY_ENV } });
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
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot, env: { ...process.env, ...TEST_IDENTITY_ENV } });
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
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: siteRoot, env: { ...process.env, ...TEST_IDENTITY_ENV } });
    const config = loadSiteConfig(siteRoot);

    // Any non-empty placeholder satisfies it for a wholly new resource,
    // matching saveDraftJob's own established precedent.
    const etag = await saveMenu(config, 'new-menu.json', menu('New'), 'anything-at-all', 'create', author);
    assert.equal(typeof etag, 'string');
  } finally {
    cleanup();
  }
});

// --- renameMenu (Group W10) ---

async function seededSite() {
  const site = createTmpSiteRoot({ git: true, contentDirs: true });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: site.siteRoot, env: { ...process.env, ...TEST_IDENTITY_ENV } });
  const config = loadSiteConfig(site.siteRoot);
  const etag = await saveMenu(config, 'main.json', menu('Home'), 'no-prior-file', 'create main menu', author);
  return { ...site, config, etag };
}

test('renameMenu moves the file to its new handle in one commit, contents and etag unchanged', async () => {
  const { siteRoot, config, etag, cleanup } = await seededSite();
  try {
    const before = commitCount(siteRoot);

    const result = await renameMenu(config, 'main', 'header', etag, 'Change menu handle main to header', author);

    assert.equal(result.etag, etag);
    assert.equal(existsSync(join(siteRoot, 'content', 'menus', 'main.json')), false);
    assert.deepEqual(JSON.parse(readFileSync(join(siteRoot, 'content', 'menus', 'header.json'), 'utf-8')), menu('Home'));
    assert.equal(commitCount(siteRoot), before + 1);
    // The commit recorded both sides (deletion staged too), leaving a clean tree.
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: siteRoot }).toString('utf-8').trim(), '');
  } finally {
    cleanup();
  }
});

test('renameMenu reports the theme files that still use the old handle', async () => {
  const { siteRoot, config, etag, cleanup } = await seededSite();
  try {
    mkdirSync(join(siteRoot, 'theme', 'layouts'), { recursive: true });
    writeFileSync(join(siteRoot, 'theme', 'layouts', 'theme.liquid'), '{% for item in menus.main.items %}{% endfor %}');

    const result = await renameMenu(config, 'main', 'header', etag, 'rename', author);

    assert.deepEqual(result.staleThemeReferences, ['theme/layouts/theme.liquid']);
  } finally {
    cleanup();
  }
});

test('renameMenu refuses a handle that is already taken, and changes nothing', async () => {
  const { siteRoot, config, etag, cleanup } = await seededSite();
  try {
    await saveMenu(config, 'footer.json', menu('Privacy'), 'no-prior-file', 'create footer', author);
    const before = commitCount(siteRoot);

    await assert.rejects(
      renameMenu(config, 'main', 'footer', etag, 'rename', author),
      (error: unknown) => error instanceof ManageMenuError && error.reason === 'conflict',
    );
    assert.deepEqual(JSON.parse(readFileSync(join(siteRoot, 'content', 'menus', 'footer.json'), 'utf-8')), menu('Privacy'));
    assert.equal(existsSync(join(siteRoot, 'content', 'menus', 'main.json')), true);
    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test('renameMenu refuses a stale If-Match, a missing menu, an invalid handle, and a no-op', async () => {
  const { config, etag, cleanup } = await seededSite();
  try {
    const reasonIs = (reason: string) => (error: unknown) => error instanceof ManageMenuError && error.reason === reason;
    await assert.rejects(renameMenu(config, 'main', 'header', '"stale"', 'rename', author), reasonIs('conflict'));
    await assert.rejects(renameMenu(config, 'nope', 'header', etag, 'rename', author), reasonIs('not-found'));
    await assert.rejects(renameMenu(config, 'main', '../pages/about', etag, 'rename', author), reasonIs('validation-failed'));
    await assert.rejects(renameMenu(config, 'main', 'has space', etag, 'rename', author), reasonIs('validation-failed'));
    await assert.rejects(renameMenu(config, 'main', 'main', etag, 'rename', author), reasonIs('validation-failed'));
  } finally {
    cleanup();
  }
});
