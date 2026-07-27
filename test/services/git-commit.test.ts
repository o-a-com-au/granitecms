import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { commitWorkingTreeChanges } from '../../src/services/git-commit.ts';
import { createTmpSiteRoot, writeAndCommit } from '../helpers/tmp-site.ts';

const author = { name: 'Jane Editor', email: 'jane@example.com' };

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

test('G5: a dirty working tree is committed with the supplied author', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeFileSync(join(siteRoot, 'content', 'pages', 'manual-edit.json'), '{"out":"of band"}');
    const config = loadSiteConfig(siteRoot);

    const result = await commitWorkingTreeChanges(config, 'manual fix', author);

    assert.equal(result, 'committed');
    assert.equal(commitCount(siteRoot), 1);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: siteRoot }).toString('utf-8').trim();
    assert.equal(status, '', 'working tree must be clean after commit');
  } finally {
    cleanup();
  }
});

test('a clean working tree returns "clean" and creates no commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', '{}', 'seed');
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    const result = await commitWorkingTreeChanges(config, 'no-op', author);

    assert.equal(result, 'clean');
    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test('a change under a gitignored path is correctly excluded from the commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, '.gitignore', 'data/\n');
    mkdirSync(join(siteRoot, 'data'), { recursive: true });
    writeFileSync(join(siteRoot, 'data', 'search-index.sqlite'), 'binary-ish');
    writeFileSync(join(siteRoot, 'content', 'pages', 'real-change.json'), '{"real":true}');
    const config = loadSiteConfig(siteRoot);

    const result = await commitWorkingTreeChanges(config, 'commit real change only', author);

    assert.equal(result, 'committed');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: siteRoot }).toString('utf-8').trim();
    assert.equal(status, '', 'the gitignored data/ file must never surface as untracked or staged');
  } finally {
    cleanup();
  }
});
