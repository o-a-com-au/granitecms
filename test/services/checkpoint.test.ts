import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { CHECKPOINT_AUTHOR, runCheckpoint } from '../../src/services/checkpoint.ts';
import { CHECKPOINT_MESSAGE } from '../../src/services/git-history.ts';
import { createTmpSiteRoot, writeAndCommit } from '../helpers/tmp-site.ts';

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

test('runCheckpoint returns "clean" and creates no commit when drafts/ is untouched', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', '{}', 'seed');
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    const result = await runCheckpoint(config, CHECKPOINT_AUTHOR);

    assert.equal(result, 'clean');
    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test('H4: runCheckpoint commits a changed draft with the fixed checkpoint message and author', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', '{}', 'seed');
    const config = loadSiteConfig(siteRoot);
    mkdirSync(join(config.draftsRoot, 'pages'), { recursive: true });
    writeFileSync(join(config.draftsRoot, 'pages', 'about.json'), '{"draft":true}');
    const before = commitCount(siteRoot);

    const result = await runCheckpoint(config, CHECKPOINT_AUTHOR);

    assert.equal(result, 'committed');
    assert.equal(commitCount(siteRoot), before + 1);
    const message = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: siteRoot }).toString('utf-8').trim();
    const authorName = execFileSync('git', ['log', '-1', '--format=%an'], { cwd: siteRoot }).toString('utf-8').trim();
    const authorEmail = execFileSync('git', ['log', '-1', '--format=%ae'], { cwd: siteRoot })
      .toString('utf-8')
      .trim();
    assert.equal(message, CHECKPOINT_MESSAGE);
    assert.equal(authorName, CHECKPOINT_AUTHOR.name);
    assert.equal(authorEmail, CHECKPOINT_AUTHOR.email);
  } finally {
    cleanup();
  }
});

test('a deleted draft is also captured as a checkpoint commit, not silently missed', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    mkdirSync(join(siteRoot, 'content', 'drafts', 'pages'), { recursive: true });
    writeFileSync(join(siteRoot, 'content', 'drafts', 'pages', 'about.json'), '{"draft":true}');
    writeAndCommit(siteRoot, 'content/pages/placeholder.json', '{}', 'seed');
    execFileSync('git', ['add', '-A'], { cwd: siteRoot });
    execFileSync('git', ['commit', '-m', 'seed draft'], {
      cwd: siteRoot,
      env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x.com', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x.com' },
      stdio: 'ignore',
    });
    const config = loadSiteConfig(siteRoot);
    const draftPath = join(config.draftsRoot, 'pages', 'about.json');
    assert.ok(existsSync(draftPath));

    // Discarding a draft is a pure fs removal (drafts.ts's
    // discardDraftJob), no git call - the next checkpoint is the only
    // thing that will ever capture this as a real change.
    execFileSync('rm', [draftPath]);
    const before = commitCount(siteRoot);

    const result = await runCheckpoint(config, CHECKPOINT_AUTHOR);

    assert.equal(result, 'committed');
    assert.equal(commitCount(siteRoot), before + 1);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: siteRoot }).toString('utf-8').trim();
    assert.equal(status, '', 'the deletion must be fully committed, not left dirty');
  } finally {
    cleanup();
  }
});

test('a checkpoint tick with nothing changed does not affect unrelated pre-existing dirty state outside drafts/', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', '{}', 'seed');
    // An unrelated out-of-band change outside drafts/ - checkpoint must
    // not touch it (that's git/commit's escape hatch job, not this
    // one's).
    writeFileSync(join(siteRoot, 'content', 'pages', 'about.json'), '{"manual":"edit"}');
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    const result = await runCheckpoint(config, CHECKPOINT_AUTHOR);

    assert.equal(result, 'clean');
    assert.equal(commitCount(siteRoot), before);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: siteRoot }).toString('utf-8').trim();
    assert.ok(status.includes('about.json'), 'the unrelated dirty file must remain untouched, not swept up');
  } finally {
    cleanup();
  }
});
