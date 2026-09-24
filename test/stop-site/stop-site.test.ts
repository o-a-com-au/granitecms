import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { pidFilePath, readPidFile } from '../../src/services/pid-file.ts';
import { stopSite, type StopSiteDeps } from '../../src/stop-site/stop-site.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

const RECORD = { pid: 4242, serverPid: 4243, port: 3600, startedAt: '2026-09-24T00:00:00.000Z' };

function fakeDeps(overrides: Partial<StopSiteDeps> = {}): StopSiteDeps & { signalled: number[] } {
  const signalled: number[] = [];
  return {
    signalled,
    isAlive: () => true,
    signal: (pid) => signalled.push(pid),
    isSiteListening: async () => true,
    sleep: async () => {},
    timeoutMs: 1_000,
    ...overrides,
  };
}

function siteWithRecord() {
  const site = createTmpSiteRoot({ contentDirs: true });
  writeJson(site.siteRoot, 'vhost/data/server.pid', RECORD);
  return { ...site, config: loadSiteConfig(site.siteRoot) };
}

test('stopSite: no record means the site is not running, and nothing is signalled', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const deps = fakeDeps();
    assert.deepEqual(await stopSite(loadSiteConfig(siteRoot), deps), { outcome: 'not-running' });
    assert.deepEqual(deps.signalled, []);
  } finally {
    cleanup();
  }
});

test('stopSite: a record of a process that has already ended is removed, and nothing is signalled', async () => {
  const { config, cleanup } = siteWithRecord();
  try {
    const deps = fakeDeps({ isAlive: () => false });
    assert.deepEqual(await stopSite(config, deps), { outcome: 'removed-stale', pid: 4242 });
    assert.equal(existsSync(pidFilePath(config)), false);
    assert.deepEqual(deps.signalled, []);
  } finally {
    cleanup();
  }
});

test('stopSite: a live process that is not answering as a site is never signalled (its id may have been reused)', async () => {
  const { config, cleanup } = siteWithRecord();
  try {
    const deps = fakeDeps({ isSiteListening: async () => false });
    assert.deepEqual(await stopSite(config, deps), { outcome: 'not-a-site', pid: 4242, port: 3600 });
    assert.deepEqual(deps.signalled, []);
    assert.equal(existsSync(pidFilePath(config)), true);
  } finally {
    cleanup();
  }
});

test('stopSite: signals the recorded process, then waits for it and the server to exit', async () => {
  const { config, cleanup } = siteWithRecord();
  try {
    let polls = 0;
    const deps = fakeDeps({
      isAlive: () => polls < 3,
      sleep: async () => {
        polls += 1;
      },
    });
    assert.deepEqual(await stopSite(config, deps), { outcome: 'stopped', port: 3600 });
    assert.deepEqual(deps.signalled, [4242]);
    assert.equal(existsSync(pidFilePath(config)), false);
  } finally {
    cleanup();
  }
});

test('stopSite: reports a site still shutting down after the timeout', async () => {
  const { config, cleanup } = siteWithRecord();
  try {
    assert.deepEqual(await stopSite(config, fakeDeps()), { outcome: 'still-stopping', pid: 4242 });
  } finally {
    cleanup();
  }
});

// --- For real: a site started in its own process, stopped from this one ---

const FIXTURE_SITE = join(import.meta.dirname, '..', 'fixtures', 'site');
const SERVER_MODULE = join(import.meta.dirname, '..', '..', 'src', 'server.ts');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') {
    throw new Error('expected a port');
  }
  return address.port;
}

function startSiteProcess(siteRoot: string, port: number): { child: ChildProcess; output: () => string } {
  let output = '';
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--eval', `import(${JSON.stringify(SERVER_MODULE)}).then((m) => m.startServer(process.argv[1], { logger: false }))`, siteRoot],
    { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return { child, output: () => output };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('a real site: records itself on start, says it is already running on a second start, and stopSite stops it gracefully', async () => {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-stop-site-'));
  cpSync(FIXTURE_SITE, siteRoot, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: siteRoot });
  const config = loadSiteConfig(siteRoot);
  const port = await freePort();
  const first = startSiteProcess(siteRoot, port);
  try {
    await waitFor(() => readPidFile(config) !== null, 'the pid file');
    assert.equal(readPidFile(config)?.pid, first.child.pid);
    assert.equal(readPidFile(config)?.port, port);

    const second = startSiteProcess(siteRoot, port);
    const secondCode = await new Promise<number | null>((resolve) => second.child.on('exit', resolve));
    assert.equal(secondCode, 1);
    assert.match(second.output(), new RegExp(`already running on port ${port} \\(process ${first.child.pid}\\)`));
    assert.match(second.output(), /npm run stop/);

    const exited = new Promise<number | null>((resolve) => first.child.on('exit', resolve));
    const result = await stopSite(config);
    assert.deepEqual(result, { outcome: 'stopped', port });
    // A graceful exit (the SIGTERM handler closed the server), not a kill.
    assert.equal(await exited, 0);
    assert.equal(existsSync(pidFilePath(config)), false);
  } finally {
    first.child.kill('SIGKILL');
    rmSync(siteRoot, { recursive: true, force: true });
  }
});
