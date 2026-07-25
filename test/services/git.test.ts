import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitPaths, resetPaths } from '../../src/services/git.ts';
import { createTmpSiteRoot } from '../helpers/tmp-site.ts';

function log(cwd: string, format: string): string {
  return execFileSync('git', ['log', '-1', `--format=${format}`], { cwd }).toString('utf-8').trim();
}

test('commitPaths produces exactly one commit with the supplied author, not a fixed agent identity', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true });
  try {
    writeFileSync(join(siteRoot, 'page.json'), '{"hello":"world"}');

    commitPaths(siteRoot, ['page.json'], 'add page', { name: 'Jane Editor', email: 'jane@example.com' });

    assert.equal(log(siteRoot, '%an'), 'Jane Editor');
    assert.equal(log(siteRoot, '%ae'), 'jane@example.com');
    assert.equal(log(siteRoot, '%cn'), 'Jane Editor');
    assert.equal(log(siteRoot, '%ce'), 'jane@example.com');
    assert.equal(execFileSync('git', ['log', '--oneline'], { cwd: siteRoot }).toString('utf-8').trim().split('\n').length, 1);
  } finally {
    cleanup();
  }
});

test('commitPaths succeeds even with no host git identity configured (HOME redirected to an empty dir)', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true });
  const emptyHome = mkdtempSync(join(tmpdir(), 'cms-agent-test-empty-home-'));
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = emptyHome;
    writeFileSync(join(siteRoot, 'page.json'), '{}');

    assert.doesNotThrow(() =>
      commitPaths(siteRoot, ['page.json'], 'add page', { name: 'Jane Editor', email: 'jane@example.com' }),
    );
    assert.equal(log(siteRoot, '%an'), 'Jane Editor');
  } finally {
    process.env.HOME = originalHome;
    cleanup();
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test('resetPaths unstages a path without touching working tree content', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true });
  try {
    writeFileSync(join(siteRoot, 'page.json'), '{"staged":true}');
    execFileSync('git', ['add', 'page.json'], { cwd: siteRoot });

    resetPaths(siteRoot, ['page.json']);

    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: siteRoot })
      .toString('utf-8')
      .trim();
    assert.equal(staged, '');
    assert.equal(readFileSync(join(siteRoot, 'page.json'), 'utf-8'), '{"staged":true}');
  } finally {
    cleanup();
  }
});
