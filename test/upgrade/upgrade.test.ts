import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCAFFOLD_SCRIPTS, SERVER_JS, TEMPLATE_ROOT, scaffoldSite } from '../../src/create-site/generate-site.ts';
import { changesBetween, compareVersions, mayBreak } from '../../src/upgrade/changelog.ts';
import { finishUpgrade } from '../../src/upgrade/finish.ts';
import { refreshOwnedFiles } from '../../src/upgrade/owned-files.ts';
import { TEST_IDENTITY_ENV } from '../helpers/tmp-site.ts';

test('versions compare numerically, and a 0.x minor step (or any major step) may break things', () => {
  assert.equal(compareVersions('0.5.10', '0.5.9'), 1);
  assert.equal(compareVersions('0.6.0', '0.6.0'), 0);
  assert.equal(compareVersions('0.5.5', '1.0.0'), -1);
  assert.equal(mayBreak('0.5.5', '0.5.9'), false);
  assert.equal(mayBreak('0.5.5', '0.6.0'), true);
  assert.equal(mayBreak('1.2.0', '1.9.0'), false);
  assert.equal(mayBreak('1.9.0', '2.0.0'), true);
});

test('changesBetween returns the changelog sections after the old version, up to the new one', () => {
  const changelog = [
    '# Changelog',
    '## [0.6.1] - later',
    'too new',
    '## [0.6.0] - 2026-09-30',
    'theme push',
    '## [0.5.5] - 2026-09-28',
    'push',
    '## [0.5.4] - 2026-09-28',
    'pull',
  ].join('\n');
  assert.deepEqual(changesBetween(changelog, '0.5.4', '0.6.0'), [
    { version: '0.6.0', text: 'theme push' },
    { version: '0.5.5', text: 'push' },
  ]);
});

function scaffolded() {
  const siteRoot = join(mkdtempSync(join(tmpdir(), 'cms-upgrade-')), 'site');
  scaffoldSite(siteRoot);
  return { siteRoot, cleanup: () => rmSync(join(siteRoot, '..'), { recursive: true, force: true }) };
}

const SOURCE = { templateRoot: TEMPLATE_ROOT, serverJs: SERVER_JS, scripts: SCAFFOLD_SCRIPTS };

test('refreshOwnedFiles puts back the CMS\'s own files, keeps the developer\'s own scripts, and touches nothing else', () => {
  const { siteRoot, cleanup } = scaffolded();
  try {
    // As an older site would be: stale files, missing scripts, a script of the developer's own.
    writeFileSync(join(siteRoot, 'vhost/Dockerfile'), 'FROM an-old-image\n');
    writeFileSync(join(siteRoot, 'vhost/docker-entrypoint.sh'), '#!/bin/sh\nold\n');
    const pkgPath = join(siteRoot, 'vhost/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts: Record<string, string>; dependencies: Record<string, string> };
    delete pkg.scripts.push;
    pkg.scripts.lint = 'my-own-linter';
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    const configBefore = readFileSync(join(siteRoot, 'vhost/site.config.json'), 'utf-8');
    const layoutBefore = readFileSync(join(siteRoot, 'theme/layouts/theme.liquid'), 'utf-8');

    const results = refreshOwnedFiles(siteRoot, SOURCE);

    assert.deepEqual(
      Object.fromEntries(results.map((result) => [result.path, result.status])),
      {
        'vhost/Dockerfile': 'updated',
        'vhost/docker-entrypoint.sh': 'updated',
        'vhost/server.js': 'unchanged',
        '.dockerignore': 'unchanged',
        'vhost/package.json': 'updated',
      },
    );
    assert.equal(readFileSync(join(siteRoot, 'vhost/Dockerfile'), 'utf-8'), readFileSync(join(TEMPLATE_ROOT, 'vhost/Dockerfile'), 'utf-8'));
    assert.ok(statSync(join(siteRoot, 'vhost/docker-entrypoint.sh')).mode & 0o111, 'still executable');
    const after = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts: Record<string, string>; dependencies: Record<string, string> };
    assert.equal(after.scripts.push, 'push-site');
    assert.equal(after.scripts.lint, 'my-own-linter');
    assert.deepEqual(after.dependencies, pkg.dependencies, 'the dependency is left as installed');
    assert.equal(readFileSync(join(siteRoot, 'vhost/site.config.json'), 'utf-8'), configBefore, 'tokens untouched');
    assert.equal(readFileSync(join(siteRoot, 'theme/layouts/theme.liquid'), 'utf-8'), layoutBefore, 'theme untouched');

    // Run again: nothing left to change.
    assert.ok(refreshOwnedFiles(siteRoot, SOURCE).every((result) => result.status === 'unchanged'));
  } finally {
    cleanup();
  }
});

test('finishUpgrade updates content to the current format without committing it, and checks the site', async () => {
  const { siteRoot, cleanup } = scaffolded();
  try {
    const pagePath = join(siteRoot, 'content/pages/about.json');
    const page = JSON.parse(readFileSync(pagePath, 'utf-8')) as { schemaVersion: number };
    page.schemaVersion = 6;
    writeFileSync(pagePath, JSON.stringify(page, null, 2));
    const git = (args: string[]) => execFileSync('git', args, { cwd: siteRoot, env: { ...process.env, ...TEST_IDENTITY_ENV } }).toString('utf-8');
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'an older page']);
    const commits = git(['rev-list', '--count', 'HEAD']).trim();

    const result = await finishUpgrade(siteRoot);

    assert.deepEqual(
      result.migrated.map((path) => path.slice(siteRoot.length + 1)),
      ['content/pages/about.json'],
    );
    assert.equal((JSON.parse(readFileSync(pagePath, 'utf-8')) as { schemaVersion: number }).schemaVersion, 7);
    assert.equal(git(['rev-list', '--count', 'HEAD']).trim(), commits, 'nothing committed');
    assert.match(git(['status', '--porcelain']), /content\/pages\/about\.json/);
    assert.equal(result.migrationProblem, null);
    // The check runs; a fresh scaffold has known broken links of its own,
    // so only that it ran is asserted here.
    assert.ok(Array.isArray(result.check.findings));
  } finally {
    cleanup();
  }
});

test('finishUpgrade reports content it can\'t update rather than failing, and changes no content file', async () => {
  const { siteRoot, cleanup } = scaffolded();
  try {
    const pagePath = join(siteRoot, 'content/pages/about.json');
    const page = JSON.parse(readFileSync(pagePath, 'utf-8')) as Record<string, unknown>;
    page.schemaVersion = 6;
    delete page.title;
    writeFileSync(pagePath, JSON.stringify(page, null, 2));
    const before = readFileSync(pagePath, 'utf-8');

    const result = await finishUpgrade(siteRoot);

    assert.match(result.migrationProblem ?? '', /about\.json/);
    assert.deepEqual(result.migrated, []);
    assert.equal(readFileSync(pagePath, 'utf-8'), before);
  } finally {
    cleanup();
  }
});
