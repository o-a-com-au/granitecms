// Proves npm run dev's real end-to-end cycle: Node's own --watch-path
// (confirmed empirically, not assumed, before this was written - see
// docs/guide-hosting.md's "Dev-mode theme watching" section) sends a
// real SIGTERM on a theme file change, which server.js's own shutdown
// handling already listens for - this test proves that combination
// actually reloads the new theme content, not just that either half
// works in isolation. Deliberately kept out of the default `npm test`
// run, same reasoning and mechanism as create-site-packaging.check.ts
// (a real npm pack + npm install + real child process, no shortcuts).
//
// This file's own "build" step races create-site-packaging.check.ts's
// identical one if node:test runs the two files concurrently (both
// invoke `npm run build`, which rm -rf's and repopulates dist/ - found
// live, one file's build failing outright when run together without
// this). package.json's own test:packaging script passes
// --test-concurrency=1 to force the two e2e files to run one at a
// time - required when running both together, not needed when running
// this file alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PackResult {
  filename: string;
}

test('npm run dev: a real theme file change triggers a real restart and the new content is what serves next', async (t) => {
  await t.test('build', () => {
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' });
  });

  const scratchParent = mkdtempSync(join(tmpdir(), 'cms-agent-dev-watch-'));
  let child: ChildProcess | undefined;
  try {
    let tarballPath = '';
    await t.test('real npm pack produces a real tarball', () => {
      const packOutput = execFileSync(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', scratchParent],
        { cwd: repoRoot },
      ).toString('utf-8');
      const [result] = JSON.parse(packOutput) as PackResult[];
      assert.ok(result?.filename);
      tarballPath = join(scratchParent, result.filename);
      assert.ok(existsSync(tarballPath));
    });

    const scaffoldDir = join(scratchParent, 'my-site');
    const vhostDir = join(scaffoldDir, 'vhost');
    const layoutPath = join(scaffoldDir, 'theme', 'layouts', 'theme.liquid');
    await t.test('the real compiled create-site CLI scaffolds a site', () => {
      execFileSync('node', [join(repoRoot, 'dist', 'create-site', 'cli.js'), scaffoldDir], {
        cwd: scratchParent,
      });
      assert.ok(existsSync(join(vhostDir, 'server.js')));
      assert.ok(existsSync(layoutPath));
    });

    const port = 40000 + Math.floor(Math.random() * 10000);
    await t.test('patch the scaffold to depend on the real tarball, and pin a concrete port', () => {
      const pkgPath = join(vhostDir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { dependencies: Record<string, string> };
      pkg.dependencies['@o-a/cms-agent'] = `file:${tarballPath}`;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

      const configPath = join(vhostDir, 'site.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      config.port = port;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    });

    await t.test('a real npm install resolves the packed tarball', () => {
      execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: vhostDir, stdio: 'ignore' });
      assert.ok(existsSync(join(vhostDir, 'node_modules', '@o-a', 'cms-agent', 'dist', 'index.js')));
    });

    const marker = 'dev-watch-proof-marker';
    await t.test('npm run dev boots as a real child process and serves the original layout', async () => {
      // Spawns the exact command the scaffold's own "dev" script maps
      // to directly (not via `npm run dev`) - the npm-script wiring
      // itself is already covered by generate-site.test.ts's own
      // assertion on pkg.scripts.dev; going straight to the real
      // command here keeps SIGTERM delivery/child-process cleanup as
      // close as possible to the standalone /tmp experiment this
      // feature was verified against before any of this was written,
      // rather than adding npm's own process-wrapping as an extra,
      // separately-uncertain layer on top of what's actually being
      // proven.
      child = spawn('node', ['--watch-path=../theme', 'server.js'], { cwd: vhostDir, stdio: 'ignore' });

      const deadline = Date.now() + 15000;
      let lastBody = '';
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`);
          if (response.status === 200) {
            lastBody = await response.text();
            assert.ok(!lastBody.includes(marker), 'the marker must not be present before the edit');
            return;
          }
        } catch {
          // not up yet
        }
        await sleep(200);
      }
      assert.fail(`server never became reachable on port ${port}, last body: ${lastBody}`);
    });

    await t.test('editing a theme file triggers a real restart, and the new markup is what serves next', async () => {
      const original = readFileSync(layoutPath, 'utf-8');
      writeFileSync(layoutPath, original.replace('</body>', `<!-- ${marker} --></body>`));

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`);
          if (response.status === 200) {
            const body = await response.text();
            if (body.includes(marker)) {
              return;
            }
          }
        } catch {
          // mid-restart, connection refused for a moment - expected, keep polling
        }
        await sleep(200);
      }
      assert.fail(`the edited layout never showed up in a real response within the deadline`);
    });
  } finally {
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    rmSync(scratchParent, { recursive: true, force: true });
  }
});
