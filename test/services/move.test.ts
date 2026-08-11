import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { MoveError, movePage } from '../../src/services/move.ts';
import { createTmpSiteRoot, redirectTargetFor, writeAndCommit } from '../helpers/tmp-site.ts';

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

function statusesInLastCommit(siteRoot: string): string[] {
  // --no-renames: git's default rename-detection heuristic would
  // otherwise collapse a delete+add pair into a single "R100" line,
  // which is just a display choice - the underlying commit is still a
  // full delete+add either way. --no-renames forces the literal D/A
  // lines this test actually wants to assert on.
  return execFileSync('git', ['diff', '--no-renames', '--name-status', 'HEAD~1', 'HEAD'], {
    cwd: siteRoot,
  })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean);
}

test('E2: moving a page moves the file (old path gone, new path present), recorded as one commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await movePage(config, '/about', '/company', 'move about to company', author);

    assert.equal(existsSync(join(config.pagesRoot, 'about.json')), false);
    assert.ok(existsSync(join(config.pagesRoot, 'company.json')));
    assert.equal(readFileSync(join(config.pagesRoot, 'company.json'), 'utf-8'), pageJson('About'));
    assert.equal(commitCount(siteRoot), before + 1);

    // The mechanism that would produce a 301 once Phase 2's router
    // exists: requesting the old URL resolves via redirects.json to
    // the new one.
    assert.equal(redirectTargetFor(config, '/about'), '/company');
  } finally {
    cleanup();
  }
});

test('E2/critical fix: the move commit stages both the old path (deleted) and the new path (added), not just the new one', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    const config = loadSiteConfig(siteRoot);

    await movePage(config, '/about', '/company', 'move about to company', author);

    const statuses = statusesInLastCommit(siteRoot);
    assert.ok(statuses.some((line) => line.startsWith('D') && line.includes('about.json')));
    assert.ok(statuses.some((line) => line.startsWith('A') && line.includes('company.json')));
  } finally {
    cleanup();
  }
});

test('createRedirect: false skips writing a redirect entry, without affecting the move itself', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await movePage(config, '/about', '/company', 'move about to company', author, { createRedirect: false });

    assert.equal(existsSync(join(config.pagesRoot, 'about.json')), false);
    assert.ok(existsSync(join(config.pagesRoot, 'company.json')));
    assert.equal(commitCount(siteRoot), before + 1);
    assert.equal(redirectTargetFor(config, '/about'), undefined);
  } finally {
    cleanup();
  }
});

test('createRedirect defaults to true when the option is omitted entirely, not just when explicitly true', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    const config = loadSiteConfig(siteRoot);

    await movePage(config, '/about', '/company', 'move about to company', author);

    assert.equal(redirectTargetFor(config, '/about'), '/company');
  } finally {
    cleanup();
  }
});

test('createRedirect: false still removes a stale redirect that already pointed at the destination', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/original.json', pageJson('Original'));
    const config = loadSiteConfig(siteRoot);
    // Two prior moves leave a redirect FROM "/destination" (see E5's
    // own removeRedirectForPath-runs-before-addRedirect ordering):
    // original->destination records /original->/destination, then
    // destination->original removes that entry (its "from" is the new
    // url, /original) and records /destination->/original instead.
    await movePage(config, '/original', '/destination', 'first move', author);
    await movePage(config, '/destination', '/original', 'move back', author);
    assert.equal(redirectTargetFor(config, '/destination'), '/original');

    await movePage(config, '/original', '/destination', 'second move', author, { createRedirect: false });

    // No new redirect was created (createRedirect: false)...
    assert.equal(redirectTargetFor(config, '/original'), undefined);
    // ...and the stale "/destination" redirect from the move-back is
    // still cleared, even though no new redirect was requested - that
    // cleanup isn't "creating a redirect", it's preventing a real page
    // and a redirect entry from both claiming the same URL.
    assert.equal(redirectTargetFor(config, '/destination'), undefined);
  } finally {
    cleanup();
  }
});

test('E3: moving a subtree moves every descendant, writes one redirect entry per affected page, and is one commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    writeAndCommit(siteRoot, 'content/pages/about/team.json', pageJson('Team'));
    writeAndCommit(siteRoot, 'content/pages/about/history.json', pageJson('History'));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await movePage(config, '/about', '/company', 'move about subtree to company', author);

    assert.ok(existsSync(join(config.pagesRoot, 'company.json')));
    assert.ok(existsSync(join(config.pagesRoot, 'company', 'team.json')));
    assert.ok(existsSync(join(config.pagesRoot, 'company', 'history.json')));
    assert.equal(existsSync(join(config.pagesRoot, 'about.json')), false);
    assert.equal(existsSync(join(config.pagesRoot, 'about')), false);

    assert.equal(commitCount(siteRoot), before + 1);

    assert.equal(redirectTargetFor(config, '/about'), '/company');
    assert.equal(redirectTargetFor(config, '/about/team'), '/company/team');
    assert.equal(redirectTargetFor(config, '/about/history'), '/company/history');

    const statuses = statusesInLastCommit(siteRoot);
    for (const path of ['about.json', 'about/team.json', 'about/history.json']) {
      assert.ok(
        statuses.some((line) => line.startsWith('D') && line.includes(path)),
        `expected ${path} to be staged as deleted`,
      );
    }
    for (const path of ['company.json', 'company/team.json', 'company/history.json']) {
      assert.ok(
        statuses.some((line) => line.startsWith('A') && line.includes(path)),
        `expected ${path} to be staged as added`,
      );
    }
  } finally {
    cleanup();
  }
});

test('E5 (move half): moving a page onto a destination that already had a stale redirect removes that redirect in the same commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/original.json', pageJson('Original'));
    const config = loadSiteConfig(siteRoot);
    // A prior, unrelated move recorded /destination -> /elsewhere.
    await movePage(config, '/original', '/destination', 'first move', author);
    writeAndCommit(siteRoot, 'content/pages/destination.json', pageJson('Destination'));
    await movePage(config, '/destination', '/elsewhere', 'second move', author);

    assert.equal(redirectTargetFor(config, '/destination'), '/elsewhere');

    writeAndCommit(siteRoot, 'content/pages/incoming.json', pageJson('Incoming'));
    await movePage(config, '/incoming', '/destination', 'move onto the stale redirect', author);

    assert.equal(redirectTargetFor(config, '/incoming'), '/destination');
    assert.notEqual(redirectTargetFor(config, '/destination'), '/elsewhere');
  } finally {
    cleanup();
  }
});

test('moving a page that does not exist is rejected', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    await assert.rejects(
      movePage(config, '/does-not-exist', '/somewhere', 'move', author),
      (error: unknown) => error instanceof MoveError && error.reason === 'source-not-found',
    );
  } finally {
    cleanup();
  }
});

test('moving a page onto an existing page is rejected, and nothing changes', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    writeAndCommit(siteRoot, 'content/pages/company.json', pageJson('Company'));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await assert.rejects(
      movePage(config, '/about', '/company', 'move', author),
      (error: unknown) => error instanceof MoveError && error.reason === 'destination-exists',
    );

    assert.equal(commitCount(siteRoot), before);
    assert.ok(existsSync(join(config.pagesRoot, 'about.json')));
    assert.equal(readFileSync(join(config.pagesRoot, 'company.json'), 'utf-8'), pageJson('Company'));
  } finally {
    cleanup();
  }
});

test('rollback-on-commit-failure: a real git failure after the rename rolls back the rename and redirect, no commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About'));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    // A real, deterministic git failure (stray index.lock), matching
    // the established pattern in delete-content.test.ts/publish.test.ts
    // for proving rollback without a mock. This is the commit-failure
    // test move.ts never had before the batch-operations refactor split
    // prepareMovePage (writes) from movePageJob (commit) - added now so
    // that split has something real to verify against.
    const lockPath = join(siteRoot, '.git', 'index.lock');
    writeFileSync(lockPath, '');
    try {
      await assert.rejects(
        movePage(config, '/about', '/company', 'move about to company', author),
        (error: unknown) => error instanceof MoveError && error.reason === 'commit-failed',
      );
    } finally {
      execFileSync('rm', ['-f', lockPath]);
    }

    assert.ok(existsSync(join(config.pagesRoot, 'about.json')), 'the source page must be restored');
    assert.equal(existsSync(join(config.pagesRoot, 'company.json')), false, 'the destination must not exist');
    assert.equal(redirectTargetFor(config, '/about'), undefined, 'no redirect should be left behind');
    assert.equal(commitCount(siteRoot), before, 'no commit should be created');
  } finally {
    cleanup();
  }
});
