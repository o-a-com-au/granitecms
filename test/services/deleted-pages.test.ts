import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { deleteContent } from '../../src/services/delete-content.ts';
import { movePage } from '../../src/services/move.ts';
import { revertPaths } from '../../src/services/git-revert.ts';
import { listDeletedPages } from '../../src/services/deleted-pages.ts';
import { createTmpSiteRoot, writeAndCommit } from '../helpers/tmp-site.ts';

const author = { name: 'Jane Editor', email: 'jane@example.com' };
const page = (title: string) => JSON.stringify({ schemaVersion: 7, name: title, title, type: 'page', layout: 'theme', published: true, sections: [] });

test('deleted pages are listed newest first with who deleted them, never moved or re-created ones, and restore from the listed ref', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    for (const [slug, title] of [['offers', 'Old Offers'], ['spring', 'Spring Sale'], ['about', 'About'], ['team', 'Team']]) {
      writeAndCommit(siteRoot, `content/pages/${slug}.json`, page(title as string));
    }
    const config = loadSiteConfig(siteRoot);
    assert.deepEqual(listDeletedPages(config), []);

    await deleteContent(config, 'pages/offers.json', undefined, 'Delete Old Offers', author);
    await deleteContent(config, 'pages/spring.json', undefined, 'Delete Spring Sale', author);
    await movePage(config, '/about', '/company', 'Move About', author);
    await deleteContent(config, 'pages/team.json', undefined, 'Delete Team', author);
    writeAndCommit(siteRoot, 'content/pages/team.json', page('Team again'));

    const deleted = listDeletedPages(config);
    assert.deepEqual(
      deleted.map(({ path, url, title, deletedBy }) => ({ path, url, title, deletedBy })),
      [
        { path: 'pages/spring.json', url: '/spring', title: 'Spring Sale', deletedBy: 'Jane Editor' },
        { path: 'pages/offers.json', url: '/offers', title: 'Old Offers', deletedBy: 'Jane Editor' },
      ],
      'a moved page and a re-created one are not listed',
    );

    const offers = deleted[1]!;
    await revertPaths(config, offers.ref, [`content/${offers.path}`], 'Restore Old Offers', author);
    assert.ok(existsSync(join(config.pagesRoot, 'offers.json')));
    assert.equal(JSON.parse(readFileSync(join(config.pagesRoot, 'offers.json'), 'utf-8')).title, 'Old Offers');
    assert.deepEqual(listDeletedPages(config).map((entry) => entry.path), ['pages/spring.json']);
  } finally {
    cleanup();
  }
});

test('only deletions from the last 90 days are listed', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  const before = { author: process.env.GIT_AUTHOR_DATE, committer: process.env.GIT_COMMITTER_DATE };
  try {
    writeAndCommit(siteRoot, 'content/pages/ancient.json', page('Ancient'));
    writeAndCommit(siteRoot, 'content/pages/recent.json', page('Recent'));
    const config = loadSiteConfig(siteRoot);
    const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    process.env.GIT_AUTHOR_DATE = longAgo;
    process.env.GIT_COMMITTER_DATE = longAgo;
    await deleteContent(config, 'pages/ancient.json', undefined, 'Delete Ancient', author);
    delete process.env.GIT_AUTHOR_DATE;
    delete process.env.GIT_COMMITTER_DATE;
    await deleteContent(config, 'pages/recent.json', undefined, 'Delete Recent', author);

    assert.deepEqual(listDeletedPages(config).map((entry) => entry.title), ['Recent']);
  } finally {
    process.env.GIT_AUTHOR_DATE = before.author;
    process.env.GIT_COMMITTER_DATE = before.committer;
    if (before.author === undefined) delete process.env.GIT_AUTHOR_DATE;
    if (before.committer === undefined) delete process.env.GIT_COMMITTER_DATE;
    cleanup();
  }
});
