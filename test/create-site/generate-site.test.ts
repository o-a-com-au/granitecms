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
    assert.ok(existsSync(join(targetDir, 'AGENTS.md')), 'onboards AI coding agents to this site\'s own theme/content conventions');
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

test('scaffoldSite writes an explicit port in site.config.json, matching the real default, not left absent', () => {
  const { targetDir, cleanup } = tmpTargetDir();
  try {
    scaffoldSite(targetDir);
    const config = JSON.parse(readFileSync(join(targetDir, 'vhost', 'site.config.json'), 'utf-8')) as { port: number };
    assert.equal(config.port, 3000);
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

test('the scaffolded server.js threads a --tunnel CLI flag through to startServer', () => {
  const { targetDir, cleanup } = tmpTargetDir();
  try {
    scaffoldSite(targetDir);
    const serverJs = readFileSync(join(targetDir, 'vhost', 'server.js'), 'utf-8');
    assert.match(serverJs, /process\.argv\.includes\(['"]--tunnel['"]\)/);
    assert.match(serverJs, /startServer\(/);
  } finally {
    cleanup();
  }
});

test('scaffoldSite pins @o-a/cms-agent to the exact installed version, and sets "type": "module"', () => {
  const { targetDir, cleanup } = tmpTargetDir();
  try {
    scaffoldSite(targetDir);
    const pkg = JSON.parse(readFileSync(join(targetDir, 'vhost', 'package.json'), 'utf-8')) as {
      type: string;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.type, 'module');
    assert.ok(pkg.dependencies['@o-a/cms-agent']);
    assert.ok(!pkg.dependencies['@o-a/cms-agent'].startsWith('^'), 'the dependency must be pinned exact, not a range');
    assert.equal(pkg.scripts.start, 'node server.js');
    assert.equal(pkg.scripts.tunnel, 'node server.js --tunnel');
    assert.equal(pkg.scripts.dev, 'node --watch-path=../theme server.js');
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

// Runs the real scaffolded script under sh, against temporary seed and
// site directories standing in for /seed (the image) and /site (the
// volume). server.js is a stub that exits at once, so the script's
// final exec ends the run.
test('docker-entrypoint.sh seeds an empty volume, then on later boots refreshes only the agent from the image', () => {
  const { targetDir, cleanup } = tmpTargetDir();
  const root = mkdtempSync(join(tmpdir(), 'entrypoint-test-'));
  try {
    scaffoldSite(targetDir);
    const script = join(targetDir, 'vhost', 'docker-entrypoint.sh');
    const seed = join(root, 'seed');
    const site = join(root, 'site');
    mkdirSync(site);

    function writeSeed(agentVersion: string, pageTitle: string): void {
      rmSync(seed, { recursive: true, force: true });
      mkdirSync(join(seed, 'vhost', 'node_modules', '@o-a', 'cms-agent'), { recursive: true });
      mkdirSync(join(seed, 'content', 'pages'), { recursive: true });
      mkdirSync(join(seed, '.git'));
      writeFileSync(join(seed, 'vhost', 'server.js'), 'process.exit(0);\n');
      writeFileSync(join(seed, 'vhost', 'site.config.json'), '{"tokens":[]}');
      writeFileSync(join(seed, 'vhost', 'package.json'), JSON.stringify({ dependencies: { '@o-a/cms-agent': agentVersion } }));
      writeFileSync(join(seed, 'vhost', 'package-lock.json'), JSON.stringify({ version: agentVersion }));
      writeFileSync(join(seed, 'vhost', 'node_modules', '@o-a', 'cms-agent', 'VERSION'), agentVersion);
      writeFileSync(join(seed, 'content', 'pages', 'index.json'), JSON.stringify({ title: pageTitle }));
    }
    const boot = () => execFileSync('sh', [script], { env: { ...process.env, CMS_SEED_DIR: seed, CMS_SITE_DIR: site } });

    // First boot: an empty volume gets everything.
    writeSeed('0.5.0', 'From the image');
    boot();
    assert.equal(readFileSync(join(site, 'vhost', 'node_modules', '@o-a', 'cms-agent', 'VERSION'), 'utf-8'), '0.5.0');

    // The live site is edited, and has a package the new image won't.
    writeFileSync(join(site, 'content', 'pages', 'index.json'), JSON.stringify({ title: 'Edited live' }));
    writeFileSync(join(site, 'vhost', 'site.config.json'), '{"tokens":["live"]}');
    writeFileSync(join(site, 'vhost', 'node_modules', 'stale-package'), 'x');

    // A redeploy built from a newer agent (and older page content).
    writeSeed('0.5.2', 'From the new image');
    boot();

    assert.equal(readFileSync(join(site, 'vhost', 'node_modules', '@o-a', 'cms-agent', 'VERSION'), 'utf-8'), '0.5.2');
    assert.deepEqual(JSON.parse(readFileSync(join(site, 'vhost', 'package.json'), 'utf-8')), { dependencies: { '@o-a/cms-agent': '0.5.2' } });
    assert.equal(JSON.parse(readFileSync(join(site, 'vhost', 'package-lock.json'), 'utf-8')).version, '0.5.2');
    assert.equal(existsSync(join(site, 'vhost', 'node_modules', 'stale-package')), false, 'node_modules is replaced, not merged');
    // Everything that belongs to the live site stays as it was.
    assert.equal(JSON.parse(readFileSync(join(site, 'content', 'pages', 'index.json'), 'utf-8')).title, 'Edited live');
    assert.equal(readFileSync(join(site, 'vhost', 'site.config.json'), 'utf-8'), '{"tokens":["live"]}');
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});
