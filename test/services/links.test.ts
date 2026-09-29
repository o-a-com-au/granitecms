import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { collectLinks, findReferences, linkTarget, rewriteLinks } from '../../src/services/links.ts';
import { movePage } from '../../src/services/move.ts';
import { createTmpSiteRoot, redirectTargetFor, writeAndCommit } from '../helpers/tmp-site.ts';

const author = { name: 'Jane Editor', email: 'jane@example.com' };

test('linkTarget: a page path without query, fragment or trailing slash; nothing else is a page link', () => {
  assert.equal(linkTarget('/about'), '/about');
  assert.equal(linkTarget('/about/'), '/about');
  assert.equal(linkTarget('/about?x=1#team'), '/about');
  assert.equal(linkTarget('/'), '/');
  for (const other of ['https://example.com/about', '//cdn.example.com/a', 'mailto:a@b.c', '#top', '/media/a.jpg', '/assets/style.css', '/robots.txt', 'about', 'a /b', '']) {
    assert.equal(linkTarget(other), null, other);
  }
});

test('collectLinks: a whole-value path (a link field, a menu item) and every href in rich text', () => {
  const content = {
    title: 'Home',
    sections: [
      { settings: { link: '/about#team', heading: 'Welcome', body: '<p>See <a href="/blog/hello">the blog</a> and <a href=\'https://x.com\'>x</a></p>' } },
    ],
  };
  assert.deepEqual(collectLinks(content), ['/about#team', '/blog/hello', 'https://x.com']);
});

test('rewriteLinks: the page and pages under it follow the move, keeping query, fragment and trailing slash; lookalikes and outside links are left', () => {
  const content = {
    a: '/about',
    b: '/about/team?x=1#y',
    c: '/about/',
    d: '/about-us',
    e: 'https://example.com/about',
    f: '<a href="/about#top">About</a> <a href="/aboutx">x</a>',
    g: ['/about/team'],
  };
  const { value, changed } = rewriteLinks(content, '/about', '/company');
  assert.equal(changed, true);
  assert.deepEqual(value, {
    a: '/company',
    b: '/company/team?x=1#y',
    c: '/company/',
    d: '/about-us',
    e: 'https://example.com/about',
    f: '<a href="/company#top">About</a> <a href="/aboutx">x</a>',
    g: ['/company/team'],
  });
  assert.equal(rewriteLinks({ a: '/elsewhere' }, '/about', '/company').changed, false);
});

function pageJson(title: string, sections: unknown[] = []): string {
  return JSON.stringify({ schemaVersion: 1, title, published: true, sections }, null, 2);
}

test('moving a page rewrites links to it (and to pages under it) in live pages, drafts, menus and site settings, in the move commit; its draft moves with it', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About', [{ settings: { link: '/about#self' } }]));
    writeAndCommit(siteRoot, 'content/pages/about/team.json', pageJson('Team'));
    writeAndCommit(
      siteRoot,
      'content/pages/index.json',
      pageJson('Home', [{ settings: { cta: '/about', body: '<p><a href="/about/team">Team</a> and <a href="/about-us">not this</a></p>' } }]),
    );
    writeAndCommit(siteRoot, 'content/menus/main.json', JSON.stringify({ schemaVersion: 1, items: [{ label: 'About', url: '/about/' }] }, null, 2));
    writeAndCommit(siteRoot, 'content/settings.json', `${JSON.stringify({ schemaVersion: 7, settings: { announcement_link: '/about/team' } }, null, 2)}\n`);
    const config = loadSiteConfig(siteRoot);
    mkdirSync(join(config.draftsRoot, 'pages'), { recursive: true });
    writeFileSync(join(config.draftsRoot, 'pages', 'index.json'), pageJson('Home draft', [{ settings: { cta: '/about?from=draft' } }]));
    writeFileSync(join(config.draftsRoot, 'pages', 'about.json'), pageJson('About draft'));

    await movePage(config, '/about', '/company', 'Move About', author);

    const read = (path: string) => readFileSync(join(config.contentRoot, path), 'utf-8');
    assert.match(read('pages/index.json'), /"cta": "\/company"/);
    assert.match(read('pages/index.json'), /href=\\"\/company\/team\\"/);
    assert.match(read('pages/index.json'), /href=\\"\/about-us\\"/);
    assert.match(read('pages/company.json'), /"link": "\/company#self"/, "the moved page's link to itself");
    assert.match(read('menus/main.json'), /"url": "\/company\/"/);
    assert.match(read('settings.json'), /"announcement_link": "\/company\/team"/);
    assert.ok(read('settings.json').endsWith('\n'), 'a file ending in a newline keeps it');
    assert.match(read('drafts/pages/index.json'), /"cta": "\/company\?from=draft"/);

    assert.equal(existsSync(join(config.draftsRoot, 'pages', 'about.json')), false, 'no draft left at the old address');
    assert.equal(JSON.parse(read('drafts/pages/company.json')).title, 'About draft');
    assert.equal(redirectTargetFor(config, '/about'), '/company', 'the redirect stays for links from elsewhere');

    const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: siteRoot }).toString('utf-8');
    for (const path of ['content/pages/index.json', 'content/menus/main.json', 'content/settings.json', 'content/pages/company.json']) {
      assert.ok(committed.includes(path), `${path} is in the move commit`);
    }
    assert.ok(!committed.includes('drafts/'), 'drafts are never committed');
    const status = execFileSync('git', ['status', '--porcelain', '--', 'content/pages', 'content/menus', 'content/settings.json'], { cwd: siteRoot });
    assert.equal(status.toString('utf-8').trim(), '', 'nothing live left uncommitted');
  } finally {
    cleanup();
  }
});

test('findReferences: what links to one page, with where each link is, never a page linking to itself', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', pageJson('About', [{ settings: { link: '/about' } }]));
    writeAndCommit(siteRoot, 'content/pages/index.json', pageJson('Home', [{ settings: { cta: '/about#team' } }]));
    writeAndCommit(siteRoot, 'content/pages/contact.json', pageJson('Contact', [{ settings: { cta: '/about/team' } }]));
    writeAndCommit(siteRoot, 'content/menus/main.json', JSON.stringify({ schemaVersion: 1, name: 'Main menu', items: [{ label: 'About', url: '/about' }] }));
    const config = loadSiteConfig(siteRoot);

    const references = findReferences(config, '/about/');
    assert.deepEqual(
      references.map(({ kind, label, url, hrefs }) => ({ kind, label, url, hrefs })),
      [
        { kind: 'page', label: 'Home', url: '/', hrefs: ['/about#team'] },
        { kind: 'menu', label: 'Main menu', url: undefined, hrefs: ['/about'] },
      ],
    );
    assert.deepEqual(findReferences(config, 'https://example.com'), []);
  } finally {
    cleanup();
  }
});
