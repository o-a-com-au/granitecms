import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScaffoldError, scaffoldSite } from '../../src/create-site/generate-site.ts';
import { CHECKPOINT_AUTHOR } from '../../src/services/checkpoint.ts';

function tmpTargetDir(): { targetDir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), 'create-site-test-'));
  const targetDir = join(parent, 'new-site');
  return { targetDir, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

test('J3: scaffoldSite produces content/, drafts/, theme/, site.config.json, package.json, server.js', () => {
  const { targetDir, cleanup } = tmpTargetDir();
  try {
    scaffoldSite(targetDir);

    assert.ok(existsSync(join(targetDir, 'content', 'pages', 'index.json')));
    assert.ok(existsSync(join(targetDir, 'content', 'pages', '404.json')));
    assert.ok(existsSync(join(targetDir, 'content', 'menus', 'main.json')));
    assert.ok(existsSync(join(targetDir, 'drafts')));
    assert.ok(existsSync(join(targetDir, 'theme', 'layouts', 'theme.liquid')));
    assert.ok(existsSync(join(targetDir, 'theme', 'sections', 'hero', 'template.liquid')));
    assert.ok(existsSync(join(targetDir, 'theme', 'blocks', 'button', 'template.liquid')));
    assert.ok(existsSync(join(targetDir, 'theme', 'snippets', 'site-name.liquid')));
    assert.ok(existsSync(join(targetDir, 'theme', 'assets', 'style.css')));
    assert.ok(existsSync(join(targetDir, 'redirects.json')));
    assert.ok(existsSync(join(targetDir, 'site.config.json')));
    assert.ok(existsSync(join(targetDir, 'package.json')));
    assert.ok(existsSync(join(targetDir, 'server.js')));
    assert.ok(existsSync(join(targetDir, '.gitignore')));
    // The template's own "gitignore" (no dot) must never leak into the
    // scaffold verbatim - only the renamed .gitignore should exist.
    assert.equal(existsSync(join(targetDir, 'gitignore')), false);
  } finally {
    cleanup();
  }
});

test('scaffoldSite generates a real starter token: a valid sha256 hash in site.config.json, the raw value returned once', () => {
  const { targetDir, cleanup } = tmpTargetDir();
  try {
    const { raw } = scaffoldSite(targetDir);

    assert.equal(typeof raw, 'string');
    assert.equal(raw.length, 64);

    const config = JSON.parse(readFileSync(join(targetDir, 'site.config.json'), 'utf-8')) as {
      tokens: Array<{ hash: string; scopes: string[] }>;
    };
    assert.equal(config.tokens.length, 1);
    assert.equal(config.tokens[0]?.hash, createHash('sha256').update(raw).digest('hex'));
    assert.deepEqual(config.tokens[0]?.scopes, ['content', 'theme', 'media']);
  } finally {
    cleanup();
  }
});

test('scaffoldSite pins @oa/cms-agent to the exact installed version, and sets "type": "module"', () => {
  const { targetDir, cleanup } = tmpTargetDir();
  try {
    scaffoldSite(targetDir);
    const pkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf-8')) as {
      type: string;
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.type, 'module');
    assert.ok(pkg.dependencies['@oa/cms-agent']);
    assert.ok(!pkg.dependencies['@oa/cms-agent'].startsWith('^'), 'the dependency must be pinned exact, not a range');
  } finally {
    cleanup();
  }
});

test('scaffoldSite initialises a real git repo with one commit using the fixed checkpoint identity', () => {
  const { targetDir, cleanup } = tmpTargetDir();
  try {
    scaffoldSite(targetDir);

    const log = execFileSync('git', ['log', '--oneline'], { cwd: targetDir }).toString('utf-8').trim().split('\n');
    assert.equal(log.length, 1, 'exactly one initial commit');

    const authorName = execFileSync('git', ['log', '-1', '--format=%an'], { cwd: targetDir })
      .toString('utf-8')
      .trim();
    const authorEmail = execFileSync('git', ['log', '-1', '--format=%ae'], { cwd: targetDir })
      .toString('utf-8')
      .trim();
    assert.equal(authorName, CHECKPOINT_AUTHOR.name);
    assert.equal(authorEmail, CHECKPOINT_AUTHOR.email);

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: targetDir }).toString('utf-8').trim();
    assert.equal(status, '', 'nothing should be left uncommitted');
  } finally {
    cleanup();
  }
});

test('scaffoldSite refuses to run against an existing, non-empty target directory', () => {
  const { targetDir, cleanup } = tmpTargetDir();
  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'already-here.txt'), 'x');

    assert.throws(() => scaffoldSite(targetDir), (error: unknown) => error instanceof ScaffoldError);
  } finally {
    cleanup();
  }
});

test('scaffoldSite succeeds against an existing but empty target directory', () => {
  const { targetDir, cleanup } = tmpTargetDir();
  try {
    mkdirSync(targetDir, { recursive: true });
    assert.doesNotThrow(() => scaffoldSite(targetDir));
  } finally {
    cleanup();
  }
});
