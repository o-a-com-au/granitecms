import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootSite } from '../src/boot.ts';
import { renderPage } from '../src/renderer/render-page.ts';
import { rebuildIndex } from '../src/search/rebuild-index.ts';
import { queryIndex } from '../src/search/query-index.ts';
import { resolveUrl } from '../src/services/resolve-url.ts';

const FIXTURE_SITE = join(import.meta.dirname, 'fixtures', 'site');

const FIXTURE_IDENTITY_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

test('H1: the full fixture site clones to a temp dir, and the agent boots against it and serves pages with no steps beyond config (portability drill)', async () => {
  const originRoot = mkdtempSync(join(tmpdir(), 'cms-agent-portability-origin-'));
  const cloneParent = mkdtempSync(join(tmpdir(), 'cms-agent-portability-clone-'));

  try {
    // A real git history, not a checked-in fixture repo (a nested .git
    // inside this project's own repo would be its own can of worms):
    // copy the fixture content, then give it a real first commit here,
    // at test time.
    cpSync(FIXTURE_SITE, originRoot, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: originRoot });
    execFileSync('git', ['add', '-A'], { cwd: originRoot });
    execFileSync('git', ['commit', '-m', 'seed fixture site'], {
      cwd: originRoot,
      env: FIXTURE_IDENTITY_ENV,
      stdio: 'ignore',
    });

    // The actual portability proof: a real `git clone`, not a copy.
    const clonedSiteRoot = join(cloneParent, 'site');
    execFileSync('git', ['clone', '--quiet', originRoot, clonedSiteRoot]);

    // "Boots against it... with no steps beyond config": bootSite
    // takes nothing but the cloned site's root path.
    const { config, themeTemplates } = bootSite(clonedSiteRoot);

    // "Serves pages": render real pages through the actual renderer,
    // including the hierarchical child page and the block nested
    // inside its parent section.
    const aboutHtml = await renderPage(config, themeTemplates, 'pages/about.json', 'public');
    assert.ok(aboutHtml.includes('About Us'));
    assert.ok(aboutHtml.includes('Meet the team'));

    const teamHtml = await renderPage(config, themeTemplates, 'pages/about/team.json', 'public');
    assert.ok(teamHtml.includes('Our Team'));

    // Public mode still honours published: false against the cloned copy.
    await assert.rejects(renderPage(config, themeTemplates, 'pages/hidden.json', 'public'));

    // URL resolution works end to end against the clone.
    assert.deepEqual(resolveUrl(config, '/about'), { kind: 'page', relativePath: 'about.json' });

    // The search index rebuilds and queries against the clone, and
    // still excludes the draft-only page shipped in the fixture.
    await rebuildIndex(config);
    const results = queryIndex(config.searchIndexPath, 'Welcome');
    assert.deepEqual(results, [{ url: '/about', title: 'About' }]);
    assert.deepEqual(queryIndex(config.searchIndexPath, 'Draft'), []);
  } finally {
    rmSync(originRoot, { recursive: true, force: true });
    rmSync(cloneParent, { recursive: true, force: true });
  }
});
