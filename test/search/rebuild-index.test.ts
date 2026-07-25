import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { loadSiteConfig } from '../../src/config.ts';
import { rebuildIndex } from '../../src/search/rebuild-index.ts';
import { queryIndex } from '../../src/search/query-index.ts';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

function page(options: {
  title: string;
  published?: boolean;
  heading?: string;
}): object {
  return {
    schemaVersion: 1,
    title: options.title,
    published: options.published ?? true,
    sections: [{ id: 'sec-1', type: 'hero', settings: { heading: options.heading ?? options.title } }],
  };
}

test('G1: rebuild from a clean checkout produces an index; a basic FTS query returns the expected page for a known term', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/about.json', page({ title: 'About', heading: 'aardvarks' }));
    writeJson(siteRoot, 'content/pages/contact.json', page({ title: 'Contact', heading: 'zebras' }));
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    const results = queryIndex(config.searchIndexPath, 'aardvarks');
    assert.deepEqual(results, [{ url: '/about', title: 'About' }]);
  } finally {
    cleanup();
  }
});

test('G2: deleting the index file and rebuilding produces equivalent query results (disposability proven)', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/about.json', page({ title: 'About', heading: 'aardvarks' }));
    writeJson(siteRoot, 'content/pages/contact.json', page({ title: 'Contact', heading: 'zebras' }));
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);
    const first = queryIndex(config.searchIndexPath, 'aardvarks');

    unlinkSync(config.searchIndexPath);
    await rebuildIndex(config);
    const second = queryIndex(config.searchIndexPath, 'aardvarks');

    assert.deepEqual(first, second);
    assert.deepEqual(first, [{ url: '/about', title: 'About' }]);
  } finally {
    cleanup();
  }
});

test('G3: unpublished pages and drafts are absent from the index', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/live.json', page({ title: 'Live', heading: 'controlterm' }));
    writeJson(
      siteRoot,
      'content/pages/hidden.json',
      page({ title: 'Hidden', published: false, heading: 'unpublishedterm' }),
    );
    writeJson(siteRoot, 'drafts/pages/draft-only.json', page({ title: 'Draft', heading: 'draftonlyterm' }));
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.deepEqual(queryIndex(config.searchIndexPath, 'controlterm'), [{ url: '/live', title: 'Live' }]);
    assert.deepEqual(queryIndex(config.searchIndexPath, 'unpublishedterm'), []);
    assert.deepEqual(queryIndex(config.searchIndexPath, 'draftonlyterm'), []);
  } finally {
    cleanup();
  }
});

test('G4: the index file is gitignored and a rebuild creates no git changes', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    // No site-scaffold-template with a real .gitignore exists yet
    // anywhere in this repo (that's Phase 2 scope), so this test seeds
    // a representative one itself, mirroring what the eventual scaffold
    // will ship.
    writeAndCommit(siteRoot, '.gitignore', 'data/\n');
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page({ title: 'About' })));
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.ok(existsSync(config.searchIndexPath));
    assert.ok(statSync(config.searchIndexPath).isFile());

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: siteRoot }).toString('utf-8').trim();
    assert.equal(status, '', 'a rebuild must create no git changes');
  } finally {
    cleanup();
  }
});
