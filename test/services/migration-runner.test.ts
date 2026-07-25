import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { runMigrations } from '../../src/services/migration-runner.ts';
import type { MigrationMap } from '../../src/services/migration-runner.ts';
import type { ThemeSchemas } from '../../src/services/validation.ts';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

const themeSchemas: ThemeSchemas = { sections: {}, blocks: {} };
const author = { name: 'Jane Editor', email: 'jane@example.com' };

function page(schemaVersion: number, title: string): object {
  return { schemaVersion, title, published: true, sections: [] };
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
