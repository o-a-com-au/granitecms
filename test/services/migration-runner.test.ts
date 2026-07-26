import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { MigrationError, runMigrations } from '../../src/services/migration-runner.ts';
import type { MigrationMap } from '../../src/services/migration-runner.ts';
import type { ThemeSchemas } from '../../src/services/validation.ts';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

const themeSchemas: ThemeSchemas = { sections: {}, blocks: {} };
const author = { name: 'Jane Editor', email: 'jane@example.com' };

function page(schemaVersion: number, title: string): object {
  return { schemaVersion, title, type: 'page', published: true, sections: [] };
}

const identityMigration: MigrationMap = {
  1: (content) => ({ ...content, schemaVersion: 2 }),
};

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

function statusesInLastCommit(siteRoot: string): string[] {
  // git show, not git diff HEAD~1 HEAD: this also works for a repo's
  // very first (root) commit, which has no parent to diff against.
  return execFileSync('git', ['show', '--no-renames', '--name-status', '--format=', 'HEAD'], {
    cwd: siteRoot,
  })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean);
}

test('F1: the runner walks content and drafts, migrating any file below current schemaVersion, as a single commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page(1, 'About')));
    writeJson(siteRoot, 'drafts/pages/about-draft.json', page(1, 'Draft About'));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await runMigrations(config, themeSchemas, identityMigration, 2, author);

    const migratedContent = JSON.parse(
      readFileSync(join(config.pagesRoot, 'about.json'), 'utf-8'),
    ) as { schemaVersion: number };
    const migratedDraft = JSON.parse(
      readFileSync(join(config.draftsRoot, 'pages', 'about-draft.json'), 'utf-8'),
    ) as { schemaVersion: number };

    assert.equal(migratedContent.schemaVersion, 2);
    assert.equal(migratedDraft.schemaVersion, 2);
    assert.equal(commitCount(siteRoot), before + 1);
  } finally {
    cleanup();
  }
});

test('F1: when nothing is below current version the runner writes nothing and creates no commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page(2, 'About')));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);
    const beforeBytes = readFileSync(join(config.pagesRoot, 'about.json'));

    await runMigrations(config, themeSchemas, identityMigration, 2, author);

    assert.equal(commitCount(siteRoot), before);
    assert.ok(beforeBytes.equals(readFileSync(join(config.pagesRoot, 'about.json'))));
  } finally {
    cleanup();
  }
});

test('F1: a migrated draft file, never before committed, is included in the migration commit without error', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeJson(siteRoot, 'drafts/pages/new-draft.json', page(1, 'New draft'));
    const config = loadSiteConfig(siteRoot);

    await runMigrations(config, themeSchemas, identityMigration, 2, author);

    const statuses = statusesInLastCommit(siteRoot);
    assert.ok(
      statuses.some((line) => line.startsWith('A') && line.includes('new-draft.json')),
      `expected the never-before-tracked draft to be staged as added, got: ${statuses.join(', ')}`,
    );
  } finally {
    cleanup();
  }
});

test('F3: a file already at current version is untouched (byte-identical)', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    // Deliberately non-canonical formatting: catches an implementation
    // that re-serialises even skipped files.
    const raw = '{"schemaVersion":2,"title":"X",   "published":true,"sections":[]}';
    writeAndCommit(siteRoot, 'content/pages/about.json', raw);
    const config = loadSiteConfig(siteRoot);

    await runMigrations(config, themeSchemas, identityMigration, 2, author);

    const after = readFileSync(join(config.pagesRoot, 'about.json'), 'utf-8');
    assert.equal(after, raw);
  } finally {
    cleanup();
  }
});

test('F2: migrations apply in order for a multi-step chain', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    // Each step's transform depends on the previous step having already
    // run (appending to title), so the final result only makes sense if
    // both steps ran in the correct sequence, not just that "some
    // migration" happened. Uses already-schema-allowed fields
    // (title/schemaVersion) rather than a synthetic marker field, since
    // page.schema.json has additionalProperties: false and the runner
    // validates migrated content before writing it.
    const orderedMigrations: MigrationMap = {
      1: (content) => ({ ...content, schemaVersion: 2, title: `${content.title as string}-step2` }),
      2: (content) => ({ ...content, schemaVersion: 3, title: `${content.title as string}-step3` }),
    };
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page(1, 'Original')));
    const config = loadSiteConfig(siteRoot);

    await runMigrations(config, themeSchemas, orderedMigrations, 3, author);

    const migrated = JSON.parse(readFileSync(join(config.pagesRoot, 'about.json'), 'utf-8')) as {
      schemaVersion: number;
      title: string;
    };
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.title, 'Original-step2-step3');
  } finally {
    cleanup();
  }
});

test('F2: a migration function does not mutate its input and produces the same output when run twice', () => {
  const migrate = (content: Record<string, unknown>): Record<string, unknown> => ({
    ...content,
    schemaVersion: 2,
  });
  const input = Object.freeze({ schemaVersion: 1, title: 'X', published: true, sections: [] });

  const first = migrate(input);
  const second = migrate(input);

  assert.deepEqual(first, second);
  // The frozen input itself must be untouched: a migration wrongly
  // written as in-place mutation (content.schemaVersion = 2; return
  // content) would throw a TypeError against a frozen object in strict
  // mode before this assertion is even reached.
  assert.deepEqual(input, { schemaVersion: 1, title: 'X', published: true, sections: [] });
});

test('F2 (error path): the runner throws migration-failed when no migration is registered for an intermediate version', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page(1, 'About')));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);

    await assert.rejects(
      runMigrations(config, themeSchemas, {}, 2, author),
      (error: unknown) => error instanceof MigrationError && error.reason === 'migration-failed',
    );

    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test('F2 (error path): the runner throws migration-failed when a migration fails to advance the schemaVersion', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page(1, 'About')));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);
    const stuckMigration: MigrationMap = { 1: (content) => ({ ...content, schemaVersion: 1 }) };

    await assert.rejects(
      runMigrations(config, themeSchemas, stuckMigration, 2, author),
      (error: unknown) => error instanceof MigrationError && error.reason === 'migration-failed',
    );

    assert.equal(commitCount(siteRoot), before);
  } finally {
    cleanup();
  }
});

test('F4: a failed migration aborts the whole run with a clean working tree', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/a.json', JSON.stringify(page(1, 'A')));
    writeAndCommit(siteRoot, 'content/pages/b.json', JSON.stringify(page(1, 'B')));
    const config = loadSiteConfig(siteRoot);
    const before = commitCount(siteRoot);
    const aBefore = readFileSync(join(config.pagesRoot, 'a.json'));
    const bBefore = readFileSync(join(config.pagesRoot, 'b.json'));

    // A migration registered for version 1, but the function itself
    // throws for one specific file - a "broken migration" scenario, not
    // just a missing registration (already covered by F2's error-path
    // tests). Whichever file the walk happens to compute first, the
    // whole compute phase happens before any writes, so this proves no
    // partial writes regardless of processing order.
    const failingMigration: MigrationMap = {
      1: (content) => {
        if (content.title === 'B') {
          throw new Error('deliberate migration failure');
        }
        return { ...content, schemaVersion: 2 };
      },
    };

    await assert.rejects(runMigrations(config, themeSchemas, failingMigration, 2, author));

    assert.equal(commitCount(siteRoot), before);
    assert.ok(aBefore.equals(readFileSync(join(config.pagesRoot, 'a.json'))));
    assert.ok(bBefore.equals(readFileSync(join(config.pagesRoot, 'b.json'))));
  } finally {
    cleanup();
  }
});

test('F4 (write-phase): a real failure after files are written rolls back cleanly, no partial writes, no staged-but-uncommitted state', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/a.json', JSON.stringify(page(1, 'A')));
    writeAndCommit(siteRoot, 'content/pages/b.json', JSON.stringify(page(1, 'B')));
    const config = loadSiteConfig(siteRoot);
    const aBefore = readFileSync(join(config.pagesRoot, 'a.json'));
    const bBefore = readFileSync(join(config.pagesRoot, 'b.json'));
    const before = commitCount(siteRoot);

    // A real, deterministic git failure, not a mock: a stray
    // .git/index.lock makes `git add` fail exactly as it would during a
    // genuine concurrent git operation. This is deliberately a
    // commit-phase failure rather than a write-phase one: an earlier
    // attempt used chmod to force a write failure on one file, but that
    // technique is self-defeating for proving *rollback* specifically -
    // a read-only file blocks both the bad write AND rollback's own
    // attempt to restore that same file's original bytes back onto the
    // same read-only path. This way, both files are written
    // successfully first (proving the write phase itself works), then
    // the commit fails, so rollback's plain writeFileSync calls are
    // genuinely unobstructed and prove the restore path cleanly.
    const lockPath = join(siteRoot, '.git', 'index.lock');
    writeFileSync(lockPath, '');
    try {
      await assert.rejects(
        runMigrations(config, themeSchemas, identityMigration, 2, author),
        (error: unknown) => error instanceof MigrationError && error.reason === 'commit-failed',
      );
    } finally {
      rmSync(lockPath, { force: true });
    }

    assert.equal(commitCount(siteRoot), before, 'no commit should be created');
    assert.ok(aBefore.equals(readFileSync(join(config.pagesRoot, 'a.json'))), 'a.json must be rolled back');
    assert.ok(bBefore.equals(readFileSync(join(config.pagesRoot, 'b.json'))), 'b.json must be rolled back');

    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: siteRoot })
      .toString('utf-8')
      .trim();
    assert.equal(staged, '', 'nothing should be left staged after rollback');
  } finally {
    cleanup();
  }
});
