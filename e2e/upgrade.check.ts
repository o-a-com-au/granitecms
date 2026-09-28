import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// npm run upgrade, for real: two real packed versions of this package -
// the current build, and a "next version" made from it with a changed
// Dockerfile and its own changelog entry - served by a stand-in npm
// registry on localhost. A site is scaffolded on the current version,
// then upgraded with the real npm view / pack / install, including the
// hand-over to the newly installed version's own --finish step.

const repoRoot = join(import.meta.dirname, '..');
const run = promisify(execFile);
const MARKER = 'upgrade-check-marker';

function bumpPatch(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  return `${major}.${minor}.${patch + 1}`;
}

function pack(dir: string, destination: string): string {
  const [result] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], { cwd: dir }).toString('utf-8'),
  ) as Array<{ filename: string }>;
  return join(destination, result?.filename as string);
}

function manifestFor(tarball: string, url: string): Record<string, unknown> {
  const scratch = mkdtempSync(join(tmpdir(), 'cms-upgrade-manifest-'));
  execFileSync('tar', ['-xzf', tarball, '-C', scratch, 'package/package.json']);
  const pkg = JSON.parse(readFileSync(join(scratch, 'package', 'package.json'), 'utf-8')) as Record<string, unknown>;
  rmSync(scratch, { recursive: true, force: true });
  const bytes = readFileSync(tarball);
  return {
    ...pkg,
    dist: {
      tarball: url,
      shasum: createHash('sha1').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    },
  };
}

test('npm run upgrade: shows the changelog, installs the next version, and that version puts back its own files', async (t) => {
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' });
  const scratch = mkdtempSync(join(tmpdir(), 'cms-upgrade-check-'));
  let server: Server | undefined;
  try {
    // --- Two versions ---
    const current = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { version: string }).version;
    const next = bumpPatch(current);
    const tarballs = join(scratch, 'tarballs');
    mkdirSync(tarballs);
    const currentTarball = pack(repoRoot, tarballs);

    const nextDir = join(scratch, 'next');
    mkdirSync(nextDir);
    execFileSync('tar', ['-xzf', currentTarball, '-C', nextDir]);
    const nextPackage = join(nextDir, 'package');
    const nextPkgPath = join(nextPackage, 'package.json');
    const nextPkg = JSON.parse(readFileSync(nextPkgPath, 'utf-8')) as { version: string };
    nextPkg.version = next;
    writeFileSync(nextPkgPath, JSON.stringify(nextPkg, null, 2));
    const dockerfile = join(nextPackage, 'dist', 'create-site', 'template', 'vhost', 'Dockerfile');
    writeFileSync(dockerfile, `${readFileSync(dockerfile, 'utf-8')}\n# ${MARKER}\n`);
    const changelogPath = join(nextPackage, 'CHANGELOG.md');
    writeFileSync(
      changelogPath,
      readFileSync(changelogPath, 'utf-8').replace('# Changelog', `# Changelog\n\n## [${next}] - test\n\n- ${MARKER} in the changelog.\n`),
    );
    const nextTarball = pack(nextPackage, tarballs);

    // --- A stand-in npm registry ---
    server = createServer((request, response) => {
      const url = request.url ?? '';
      if (url.endsWith('.tgz')) {
        const file = url.includes(next) ? nextTarball : currentTarball;
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(readFileSync(file));
        return;
      }
      if (decodeURIComponent(url).startsWith('/@o-a/cms-agent')) {
        const address = server?.address() as { port: number };
        const base = `http://127.0.0.1:${address.port}`;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            name: '@o-a/cms-agent',
            'dist-tags': { latest: next },
            versions: {
              [current]: manifestFor(currentTarball, `${base}/cms-agent-${current}.tgz`),
              [next]: manifestFor(nextTarball, `${base}/cms-agent-${next}.tgz`),
            },
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    // Only this package comes from the stand-in; everything else from
    // the real registry. A private cache keeps the stand-in's versions
    // out of the real one.
    const env = {
      ...process.env,
      'npm_config_@o-a:registry': `http://127.0.0.1:${port}/`,
      npm_config_cache: join(scratch, 'npm-cache'),
    };

    // --- A site on the current version ---
    const site = join(scratch, 'site');
    const vhost = join(site, 'vhost');
    // Every npm call that reaches the stand-in registry is asynchronous:
    // the registry runs in this process, and a synchronous call would
    // block it from answering the very request npm is waiting on.
    await t.test('scaffold a site and install the current version from the stand-in registry', async () => {
      execFileSync('node', [join(repoRoot, 'dist', 'create-site', 'cli.js'), site], { stdio: 'ignore' });
      await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: vhost, env });
      const installed = JSON.parse(readFileSync(join(vhost, 'node_modules', '@o-a', 'cms-agent', 'package.json'), 'utf-8')) as {
        version: string;
      };
      assert.equal(installed.version, current);
    });

    const commitsBefore = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: site }).toString().trim();

    await t.test('answering no changes nothing', async () => {
      const child = execFile('npm', ['run', 'upgrade', '--silent'], { cwd: vhost, env });
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stdin?.end('n\n');
      await new Promise((resolve) => child.on('exit', resolve));
      assert.match(stdout, new RegExp(`Upgrading the CMS from ${current.replace(/\./g, '\\.')} to ${next.replace(/\./g, '\\.')}`));
      assert.match(stdout, new RegExp(`${MARKER} in the changelog`), 'the new version\'s changelog is shown before asking');
      assert.match(stdout, /Cancelled\. Nothing was changed\./);
      assert.equal((JSON.parse(readFileSync(join(vhost, 'package.json'), 'utf-8')) as { dependencies: Record<string, string> }).dependencies['@o-a/cms-agent'], current);
    });

    await t.test('upgrading installs the next version, which puts back its own files, and commits nothing', async () => {
      const { stdout } = await run('npm', ['run', 'upgrade', '--silent', '--', '--yes'], { cwd: vhost, env });
      assert.match(stdout, new RegExp(`The CMS here is now ${next.replace(/\./g, '\\.')}`));
      assert.match(stdout, /updated\s+vhost\/Dockerfile/);

      const pkg = JSON.parse(readFileSync(join(vhost, 'package.json'), 'utf-8')) as { dependencies: Record<string, string> };
      assert.equal(pkg.dependencies['@o-a/cms-agent'], next);
      const installed = JSON.parse(readFileSync(join(vhost, 'node_modules', '@o-a', 'cms-agent', 'package.json'), 'utf-8')) as {
        version: string;
      };
      assert.equal(installed.version, next);
      assert.match(readFileSync(join(vhost, 'Dockerfile'), 'utf-8'), new RegExp(MARKER), 'the new version\'s Dockerfile is in place');
      assert.ok(existsSync(join(vhost, 'server.js')));
      assert.equal(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: site }).toString().trim(), commitsBefore, 'nothing committed');
    });

    await t.test('running it again finds nothing to do', async () => {
      const { stdout } = await run('npm', ['run', 'upgrade', '--silent', '--', '--yes', '--force'], { cwd: vhost, env });
      assert.match(stdout, new RegExp(`Already on ${next.replace(/\./g, '\\.')}, the latest`));
    });
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
});
