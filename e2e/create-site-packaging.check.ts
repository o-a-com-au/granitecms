// J4: on a clean machine (or an equivalent automated proof), git clone
// + npm install + node server.js boots a scaffolded site with no steps
// beyond that. Deliberately kept out of the default `npm test` run
// (see package.json's "test:packaging" script) - verified empirically
// that node --test's bare discovery only picks up files inside a
// directory literally named test/ or matching *.test.*, neither of
// which this file is, so the normal fast suite and the Stop hook's
// gate stay unaffected by this test's real (slower, network-touching)
// npm install and process-spawn steps.
//
// This is also the strongest available proof for J1 (schema copy) and
// J2 (files/exports): a missing schema copy crashes the packed
// process on import before it ever binds a port; a wrong files/exports
// config fails either the pack-contents assertion below or the real
// install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PackFile {
  path: string;
}
interface PackResult {
  filename: string;
  files: PackFile[];
}

test('J4: a real npm pack + npm install + node server.js boots a scaffolded site with no steps beyond that', async (t) => {
  // A real bug, found while manually testing a scaffolded site (Group
  // N): `cp -r` only ever adds/overwrites, it never deletes a
  // destination file whose source no longer exists - so when
  // redirects.json moved from src/create-site/template/redirects.json
  // into src/create-site/template/content/redirects.json, the stale
  // top-level copy in dist/ survived indefinitely across rebuilds,
  // and every scaffold shipped both. Seeded here, before the real
  // build step, to prove the build script's `rm -rf` fix actually
  // removes a stale destination file rather than merely not adding
  // new ones.
  const staleTemplateFile = join(repoRoot, 'dist', 'create-site', 'template', 'this-file-should-not-survive.json');
  const staleSchemaFile = join(repoRoot, 'dist', 'schemas', 'this-file-should-not-survive.json');

  // Build explicitly, once, at the top - this is the one test in the
  // whole suite that depends on fresh dist/ output.
  await t.test('build', () => {
    mkdirSync(join(repoRoot, 'dist', 'create-site', 'template'), { recursive: true });
    mkdirSync(join(repoRoot, 'dist', 'schemas'), { recursive: true });
    writeFileSync(staleTemplateFile, '{}');
    writeFileSync(staleSchemaFile, '{}');

    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' });
  });

  await t.test('the build removes stale dist/ files whose source no longer exists, not just adds new ones', () => {
    assert.equal(existsSync(staleTemplateFile), false, 'a stale template file must not survive a rebuild');
    assert.equal(existsSync(staleSchemaFile), false, 'a stale schema file must not survive a rebuild');
  });

  // A cheap, fast-failing content check before paying for a real
  // install. --ignore-scripts: the build already ran above, and
  // letting `prepack` re-run here would print npm run build's own
  // output onto stdout ahead of the JSON, breaking JSON.parse -
  // verified empirically before writing this.
  await t.test('pack contents include the schema copy (J1) and exclude TypeScript source (J2)', () => {
    const dryRun = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: repoRoot,
    }).toString('utf-8');
    const [result] = JSON.parse(dryRun) as PackResult[];
    const paths = (result?.files ?? []).map((f) => f.path);

    for (const expected of [
      'dist/index.js',
      'dist/create-site/cli.js',
      'dist/schemas/page.schema.json',
      'dist/schemas/post.schema.json',
      'dist/schemas/menu.schema.json',
      'dist/schemas/instance.schema.json',
      'dist/create-site/template/theme/layouts/theme.liquid',
      'dist/create-site/template/content/pages/index.json',
      'dist/create-site/template/gitignore',
    ]) {
      assert.ok(paths.includes(expected), `expected packed tarball to include "${expected}"`);
    }

    const rawTsFiles = paths.filter((p) => p.endsWith('.ts') && !p.endsWith('.d.ts'));
    assert.deepEqual(rawTsFiles, [], 'no raw TypeScript source may be packed');
  });

  const scratchParent = mkdtempSync(join(tmpdir(), 'cms-agent-packaging-'));
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
    await t.test('the real compiled create-site CLI scaffolds a site', () => {
      execFileSync('node', [join(repoRoot, 'dist', 'create-site', 'cli.js'), scaffoldDir], {
        cwd: scratchParent,
      });
      assert.ok(existsSync(join(vhostDir, 'server.js')));
    });

    const port = 40000 + Math.floor(Math.random() * 10000);
    await t.test('patch the scaffold to depend on the real tarball, and pin a concrete port', () => {
      const pkgPath = join(vhostDir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { dependencies: Record<string, string> };
      // The tarball PATH, never a directory path - a file: dependency
      // pointing at a directory symlinks into the source tree and
      // leaks everything (including files "files" is meant to
      // exclude), silently defeating this entire proof while still
      // appearing to pass. Verified empirically before writing this.
      pkg.dependencies['@oa/cms-agent'] = `file:${tarballPath}`;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

      const configPath = join(vhostDir, 'site.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      config.port = port;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    });

    await t.test('a real npm install resolves the packed tarball and its transitive dependencies', () => {
      execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: vhostDir, stdio: 'ignore' });
      assert.ok(existsSync(join(vhostDir, 'node_modules', '@oa', 'cms-agent', 'dist', 'index.js')));
      // Proves the file: dependency really did resolve from the
      // tarball, not a leaked symlink into this repo's own source.
      assert.ok(!existsSync(join(vhostDir, 'node_modules', '@oa', 'cms-agent', 'src')));
    });

    await t.test('node server.js boots as a real, separate OS process and serves a real HTTP response', async () => {
      // A genuine child process, not an in-process dynamic import -
      // faithful to "no steps beyond git clone + npm install +
      // node server.js", matching test/server.test.ts's own A1
      // precedent of proving a real listener rather than trusting
      // .inject().
      child = spawn('node', ['server.js'], { cwd: vhostDir, stdio: 'ignore' });

      // No stdout "ready" marker exists (the generated server.js never
      // configures a logger) - poll with a bounded real fetch retry
      // loop instead of a fixed sleep.
      const deadline = Date.now() + 15000;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/v1/capabilities`);
          assert.equal(response.status, 200);
          const body = (await response.json()) as { agentVersion: string };
          assert.equal(typeof body.agentVersion, 'string');
          return;
        } catch (error) {
          lastError = error;
          await sleep(200);
        }
      }
      assert.fail(`server never became reachable on port ${port}: ${String(lastError)}`);
    });
  } finally {
    if (child && child.exitCode === null && !child.killed) {
      // Also exercises the real H4 graceful-shutdown checkpoint path.
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
