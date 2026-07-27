import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { BatchError, runBatch } from '../../src/services/batch.ts';
import { loadRedirects } from '../../src/services/redirects.ts';
import type { ThemeSchemas } from '../../src/services/validation.ts';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

const themeSchemas: ThemeSchemas = { sections: {}, blocks: {} };
const author = { name: 'Jane Editor', email: 'jane@example.com' };
const NO_PRIOR_FILE_ETAG = 'no-prior-file';

function page(title: string, published = true): object {
  return { schemaVersion: 4, title, type: 'page', layout: 'theme', published, sections: [] };
}

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

test('a batch mixing every operation type plus a trailing publish succeeds as one commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/keep.json', JSON.stringify(page('Keep')));
    writeAndCommit(siteRoot, 'content/pages/old-name.json', JSON.stringify(page('Old Name')));
    writeAndCommit(siteRoot, 'content/pages/to-delete.json', JSON.stringify(page('To Delete')));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await runBatch(
      config,
      themeSchemas,
      [
        { type: 'draft-write', path: 'pages/new-page.json', content: page('New Page'), expectedEtag: NO_PRIOR_FILE_ETAG },
        { type: 'move', from: '/old-name', to: '/new-name' },
        { type: 'content-delete', path: 'pages/to-delete.json', redirectTo: '/keep' },
      ],
      { relativePaths: ['pages/new-page.json'] },
      'bulk batch operation',
      author,
    );

    // draft-write: the draft existed only transiently, then got
    // promoted live by the trailing publish step.
    assert.equal(existsSync(join(config.draftsRoot, 'pages', 'new-page.json')), false);
    assert.ok(existsSync(join(config.pagesRoot, 'new-page.json')));

    // move
    assert.equal(existsSync(join(config.pagesRoot, 'old-name.json')), false);
    assert.ok(existsSync(join(config.pagesRoot, 'new-name.json')));

    // content-delete with redirect
    assert.equal(existsSync(join(config.pagesRoot, 'to-delete.json')), false);
    assert.equal(loadRedirects(config)['/to-delete'], '/keep');

    // Exactly one commit for the whole batch, not one per operation.
    assert.equal(commitCount(siteRoot), before + 1);
  } finally {
    cleanup();
  }
});

test('a batch of pure draft-write/draft-discard operations produces zero git paths and no spurious commit-failed', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'README.md', 'seed');
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await runBatch(
      config,
      themeSchemas,
      [{ type: 'draft-write', path: 'pages/only-a-draft.json', content: page('Only A Draft'), expectedEtag: NO_PRIOR_FILE_ETAG }],
      undefined,
      'draft-only batch',
      author,
    );

    assert.ok(existsSync(join(config.draftsRoot, 'pages', 'only-a-draft.json')));
    assert.equal(commitCount(siteRoot), before, 'a draft-only batch must not create any commit');
  } finally {
    cleanup();
  }
});

test('a draft-write conflict (stale If-Match) fails the batch, rolling back everything before it', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/mover.json', JSON.stringify(page('Mover')));
    writeAndCommit(siteRoot, 'content/pages/conflicted.json', JSON.stringify(page('Conflicted')));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await assert.rejects(
      runBatch(
        config,
        themeSchemas,
        [
          { type: 'move', from: '/mover', to: '/moved' },
          { type: 'draft-write', path: 'pages/conflicted.json', content: page('X'), expectedEtag: '"wrong-etag"' },
        ],
        undefined,
        'batch with a conflict',
        author,
      ),
      (error: unknown) => error instanceof BatchError && error.reason === 'conflict' && error.stage === 'operation' && error.operationIndex === 1,
    );

    // The move (operation 0) must have been rolled back.
    assert.ok(existsSync(join(config.pagesRoot, 'mover.json')), 'the earlier move must be undone');
    assert.equal(existsSync(join(config.pagesRoot, 'moved.json')), false);
    assert.equal(commitCount(siteRoot), before, 'no commit should be created');
  } finally {
    cleanup();
  }
});

test("a move's destination-exists fails the batch, rolling back an earlier successful operation", async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/source.json', JSON.stringify(page('Source')));
    writeAndCommit(siteRoot, 'content/pages/taken.json', JSON.stringify(page('Taken')));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await assert.rejects(
      runBatch(
        config,
        themeSchemas,
        [
          { type: 'draft-write', path: 'pages/side-effect.json', content: page('Side Effect'), expectedEtag: NO_PRIOR_FILE_ETAG },
          { type: 'move', from: '/source', to: '/taken' },
        ],
        undefined,
        'batch with a destination conflict',
        author,
      ),
      (error: unknown) => error instanceof BatchError && error.reason === 'destination-exists' && error.operationIndex === 1,
    );

    assert.equal(existsSync(join(config.draftsRoot, 'pages', 'side-effect.json')), false, 'the earlier draft write must be undone');
    assert.ok(existsSync(join(config.pagesRoot, 'source.json')));
    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test('a content-delete has-children failure fails the batch', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/parent.json', JSON.stringify(page('Parent')));
    writeAndCommit(siteRoot, 'content/pages/parent/child.json', JSON.stringify(page('Child')));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await assert.rejects(
      runBatch(
        config,
        themeSchemas,
        [{ type: 'content-delete', path: 'pages/parent.json' }],
        undefined,
        'batch deleting a page with children',
        author,
      ),
      (error: unknown) => error instanceof BatchError && error.reason === 'has-children',
    );

    assert.ok(existsSync(join(config.pagesRoot, 'parent.json')));
    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test("the trailing publish step's own draft-not-found failure fails the whole batch, rolling back every prior operation", async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/mover.json', JSON.stringify(page('Mover')));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await assert.rejects(
      runBatch(
        config,
        themeSchemas,
        [{ type: 'move', from: '/mover', to: '/moved' }],
        { relativePaths: ['pages/never-existed.json'] },
        'batch with a publish that fails',
        author,
      ),
      (error: unknown) => error instanceof BatchError && error.reason === 'draft-not-found' && error.stage === 'publish',
    );

    assert.ok(existsSync(join(config.pagesRoot, 'mover.json')), 'the move must be rolled back');
    assert.equal(existsSync(join(config.pagesRoot, 'moved.json')), false);
    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test('reverse-order rollback: a move then a content-delete of the moved page, where the delete fails, correctly unwinds the move too', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/original.json', JSON.stringify(page('Original')));
    writeAndCommit(siteRoot, 'content/pages/moved/child.json', JSON.stringify(page('Child')));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    // moved/child.json already exists, so moving original -> moved
    // succeeds (moved.json itself doesn't exist yet as a *page* file),
    // but then deleting moved.json (now with a real child at
    // moved/child.json) fails has-children - proving the earlier
    // move's rename is correctly reversed by the batch's reverse-order
    // rollback, not just the failing operation's own local state.
    await assert.rejects(
      runBatch(
        config,
        themeSchemas,
        [
          { type: 'move', from: '/original', to: '/moved' },
          { type: 'content-delete', path: 'pages/moved.json' },
        ],
        undefined,
        'move then delete, delete fails',
        author,
      ),
      (error: unknown) => error instanceof BatchError && error.reason === 'has-children' && error.operationIndex === 1,
    );

    assert.ok(existsSync(join(config.pagesRoot, 'original.json')), 'the move must be reversed');
    assert.equal(existsSync(join(config.pagesRoot, 'moved.json')), false);
    assert.ok(existsSync(join(config.pagesRoot, 'moved', 'child.json')), 'the untouched child page must remain');
    assert.equal(loadRedirects(config)['/original'], undefined, 'the move redirect must be reversed too');
    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test('rollback-on-commit-failure: a real git failure after every operation succeeds rolls back everything, no commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/mover.json', JSON.stringify(page('Mover')));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    const lockPath = join(siteRoot, '.git', 'index.lock');
    writeFileSync(lockPath, '');
    try {
      await assert.rejects(
        runBatch(
          config,
          themeSchemas,
          [{ type: 'move', from: '/mover', to: '/moved' }],
          undefined,
          'batch with a commit failure',
          author,
        ),
        (error: unknown) => error instanceof BatchError && error.reason === 'commit-failed',
      );
    } finally {
      execFileSync('rm', ['-f', lockPath]);
    }

    assert.ok(existsSync(join(config.pagesRoot, 'mover.json')), 'the move must be rolled back');
    assert.equal(existsSync(join(config.pagesRoot, 'moved.json')), false);
    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test('a draft-discard operation is included and rolled back correctly alongside a later failure', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'README.md', 'seed');
    const config = loadSiteConfig(siteRoot);
    const draftContent = page('Draft To Discard');
    writeJson(siteRoot, 'drafts/pages/discard-me.json', draftContent);
    const before = commitCount(siteRoot);

    await assert.rejects(
      runBatch(
        config,
        themeSchemas,
        [
          { type: 'draft-discard', path: 'pages/discard-me.json' },
          { type: 'content-delete', path: 'pages/never-existed.json' },
        ],
        undefined,
        'discard then a failing delete',
        author,
      ),
      (error: unknown) => error instanceof BatchError && error.reason === 'page-not-found',
    );

    assert.deepEqual(
      JSON.parse(readFileSync(join(config.draftsRoot, 'pages', 'discard-me.json'), 'utf-8')),
      draftContent,
      'the discarded draft must be restored',
    );
    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});
