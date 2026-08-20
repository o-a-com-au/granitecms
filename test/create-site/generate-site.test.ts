import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScaffoldError, scaffoldSite } from '../../src/create-site/generate-site.ts';
import { CHECKPOINT_AUTHOR } from '../../src/services/checkpoint.ts';

function tmpTargetDir(): { targetDir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), 'create-site-test-'));
  const targetDir = join(parent, 'new-site');
  return { targetDir, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

test('N: scaffoldSite produces content/(pages,menus,drafts,redirects.json), theme/, vhost/(site.config.json,package.json,server.js)', () => {
  const { targetDir, cleanup } = tmpTargetDir();
  try {
    scaffoldSite(targetDir);

    assert.ok(existsSync(join(targetDir, 'content', 'pages', 'index.json')));
    assert.ok(existsSync(join(targetDir, 'content', 'pages', '404.json')));
    assert.ok(existsSync(join(targetDir, 'content', 'menus', 'main.json')));
    assert.ok(existsSync(join(targetDir, 'content', 'drafts')));
    assert.ok(existsSync(join(targetDir, 'content', 'redirects.json')));
    assert.ok(existsSync(join(targetDir, 'theme', 'layouts', 'theme.liquid')));
    assert.ok(existsSync(join(targetDir, 'theme', 'sections', 'hero.liquid')));
    assert.ok(existsSync(join(targetDir, 'theme', 'blocks', 'button.liquid')));
    assert.ok(existsSync(join(targetDir, 'theme', 'snippets', 'site-name.liquid')));
    assert.ok(existsSync(join(targetDir, 'theme', 'assets', 'style.css')));
    // The old subfolder-per-component shape must be genuinely gone
    // (Group O flattened sections/blocks to one file each), not just
    // superseded by an addition alongside it.
    assert.equal(existsSync(join(targetDir, 'theme', 'sections', 'hero')), false);
    assert.equal(existsSync(join(targetDir, 'theme', 'blocks', 'button')), false);
    assert.ok(existsSync(join(targetDir, 'vhost', 'site.config.json')));
    assert.ok(existsSync(join(targetDir, 'vhost', 'package.json')));
    assert.ok(existsSync(join(targetDir, 'vhost', 'server.js')));
    assert.ok(existsSync(join(targetDir, 'media')), 'media/ is a real top-level folder, sibling to content/theme/vhost');
    assert.ok(existsSync(join(targetDir, '.gitignore')));
    // The template's own "gitignore" (no dot) must never leak into the
    // scaffold verbatim - only the renamed .gitignore should exist.
    assert.equal(existsSync(join(targetDir, 'gitignore')), false);
    assert.ok(existsSync(join(targetDir, 'vhost', 'Dockerfile')));
    assert.ok(existsSync(join(targetDir, 'vhost', 'docker-entrypoint.sh')));
    assert.ok(existsSync(join(targetDir, '.dockerignore')));
    assert.equal(existsSync(join(targetDir, 'dockerignore')), false);
    // Deliberately not at the site root - see vhost/Dockerfile's own
    // comment for why (keeps the top level to content/theme/media/vhost).
    assert.equal(existsSync(join(targetDir, 'Dockerfile')), false);
    assert.equal(existsSync(join(targetDir, 'docker-entrypoint.sh')), false);
    // The old top-level locations must be genuinely gone, not just
    // duplicated - proves the move, not an addition.
    assert.equal(existsSync(join(targetDir, 'drafts')), false);
    assert.equal(existsSync(join(targetDir, 'redirects.json')), false);
    assert.equal(existsSync(join(targetDir, 'site.config.json')), false);
    assert.equal(existsSync(join(targetDir, 'package.json')), false);
    assert.equal(existsSync(join(targetDir, 'server.js')), false);
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

    const config = JSON.parse(readFileSync(join(targetDir, 'vhost', 'site.config.json'), 'utf-8')) as {
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
    const pkg = JSON.parse(readFileSync(join(targetDir, 'vhost', 'package.json'), 'utf-8')) as {
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

test('docker-entrypoint.sh is scaffolded with the executable bit set', () => {
  const { targetDir, cleanup } = tmpTargetDir();
  try {
    scaffoldSite(targetDir);
    const mode = statSync(join(targetDir, 'vhost', 'docker-entrypoint.sh')).mode;
    assert.ok(mode & 0o111, 'docker-entrypoint.sh must be executable');
  } finally {
    cleanup();
  }
});

test('media/ is genuinely gitignored, not merely empty-by-chance: a file placed there is never committed', () => {
  const { targetDir, cleanup } = tmpTargetDir();
  try {
    scaffoldSite(targetDir);
    writeFileSync(join(targetDir, 'media', 'uploaded.jpg'), 'x');

    // git reports the whole ignored directory, not each file inside it
    // individually, once the directory itself matches a gitignore rule
    // - it doesn't recurse into an ignored directory to list contents.
    const status = execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: targetDir }).toString('utf-8');
    assert.match(status, /!! media\//, 'git itself must report media/ as ignored, not just untracked');

    assert.throws(
      () => execFileSync('git', ['add', '-n', '--', 'media/uploaded.jpg'], { cwd: targetDir, stdio: 'pipe' }),
      /ignored by one of your \.gitignore files/,
    );
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
