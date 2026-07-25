import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StartupCheckError, runStartupChecks } from '../../src/services/startup-checks.ts';
import { createTmpSiteRoot } from '../helpers/tmp-site.ts';

test('B2: startup fails with a clear, specific error when the Node version is too old', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true });
  try {
    assert.throws(
      () => runStartupChecks(siteRoot, { nodeVersion: 'v20.0.0' }),
      (error: unknown) =>
        error instanceof StartupCheckError && error.reason === 'node-version-too-low',
    );
  } finally {
    cleanup();
  }
});

test('B2: startup fails with a clear, specific error when the site root is missing', () => {
  const missingRoot = join(tmpdir(), 'cms-agent-test-does-not-exist');
  assert.throws(
    () => runStartupChecks(missingRoot),
    (error: unknown) => error instanceof StartupCheckError && error.reason === 'site-root-missing',
  );
});

test('B2: startup fails with a clear, specific error when the git binary is absent', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  const emptyPathDir = mkdtempSync(join(tmpdir(), 'cms-agent-test-empty-path-'));
  try {
    assert.throws(
      () => runStartupChecks(siteRoot, { env: { PATH: emptyPathDir } }),
      (error: unknown) =>
        error instanceof StartupCheckError && error.reason === 'git-binary-absent',
    );
  } finally {
    cleanup();
    rmSync(emptyPathDir, { recursive: true, force: true });
  }
});

test('B2: startup fails with a clear, specific error when the site root is not a git repo', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    assert.throws(
      () => runStartupChecks(siteRoot),
      (error: unknown) => error instanceof StartupCheckError && error.reason === 'not-a-git-repo',
    );
  } finally {
    cleanup();
  }
});

test('startup succeeds against a valid site root: current Node, present git, real git repo', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true });
  try {
    assert.doesNotThrow(() => runStartupChecks(siteRoot));
  } finally {
    cleanup();
  }
});
