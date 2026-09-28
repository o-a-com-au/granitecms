import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { readAgentVersion } from '../../src/routes/capabilities.ts';
import { detectDeployMethod, waitForLiveVersion, type DeployDeps } from '../../src/site-sync/deploy.ts';
import { writeJson } from '../helpers/tmp-site.ts';
import { createLocalSite, git } from './sync-helpers.ts';

function deps(overrides: { files?: Record<string, string>; succeeds?: string[] } = {}): DeployDeps {
  const files = overrides.files ?? {};
  return {
    exists: (path) => Object.keys(files).some((name) => path.endsWith(name)),
    readText: (path) => Object.entries(files).find(([name]) => path.endsWith(name))?.[1] ?? '',
    succeeds: (program) => (overrides.succeeds ?? []).includes(program),
  };
}

test('detectDeployMethod: vhost/deploy.json first, then Railway, then Fly, otherwise by hand', () => {
  assert.deepEqual(
    detectDeployMethod('/site', deps({ files: { 'vhost/deploy.json': '{ "command": "git push" }' }, succeeds: ['railway'] })),
    { kind: 'command', command: 'git push' },
  );
  assert.deepEqual(detectDeployMethod('/site', deps({ succeeds: ['railway', 'fly'], files: { 'fly.toml': '' } })), { kind: 'railway' });
  assert.deepEqual(detectDeployMethod('/site', deps({ succeeds: ['fly'], files: { 'fly.toml': '' } })), { kind: 'fly' });
  // Fly installed, but this site isn't set up for it.
  assert.deepEqual(detectDeployMethod('/site', deps({ succeeds: ['fly'] })), { kind: 'manual' });
  assert.deepEqual(detectDeployMethod('/site', deps()), { kind: 'manual' });
});

test('detectDeployMethod: a deploy.json that is not usable says how to fix it', () => {
  assert.throws(() => detectDeployMethod('/site', deps({ files: { 'vhost/deploy.json': 'not json' } })), /not valid JSON/);
  assert.throws(() => detectDeployMethod('/site', deps({ files: { 'vhost/deploy.json': '{}' } })), /needs a "command"/);
});

// A stand-in live site whose CMS version can be changed mid-test.
function fakeFetch(state: { version: string | null; home: number }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.pathname === '/v1/capabilities') {
      if (state.version === null) {
        throw new TypeError('fetch failed');
      }
      return new Response(JSON.stringify({ agentVersion: state.version, contentSchemaVersion: 7 }), { status: 200 });
    }
    return new Response('home', { status: state.home });
  }) as typeof fetch;
}

test('waitForLiveVersion waits through a restart for the new version, then checks the home page', async () => {
  const state = { version: '0.5.5' as string | null, home: 200 };
  const seen: Array<string | null> = [];
  const result = await waitForLiveVersion('https://live.test', '0.6.0', {
    fetchImpl: fakeFetch(state),
    intervalMs: 1,
    sleep: async () => {
      // The deploy restarts the site, then it comes back upgraded.
      state.version = state.version === '0.5.5' ? null : '0.6.0';
    },
    onPoll: (version) => seen.push(version),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, ['0.5.5', null, '0.6.0']);
});

test('waitForLiveVersion gives up with what it last saw, and fails a home page that does not load', async () => {
  const stuck = await waitForLiveVersion('https://live.test', '0.6.0', {
    fetchImpl: fakeFetch({ version: '0.5.5', home: 200 }),
    intervalMs: 1,
    timeoutMs: 3,
    sleep: async () => {},
  });
  assert.deepEqual(stuck, { ok: false, lastSeen: '0.5.5', reason: 'the live site is still on 0.5.5' });

  const broken = await waitForLiveVersion('https://live.test', '0.6.0', {
    fetchImpl: fakeFetch({ version: '0.6.0', home: 500 }),
    intervalMs: 1,
    sleep: async () => {},
  });
  assert.deepEqual(broken, { ok: false, lastSeen: '0.6.0', reason: 'the live site is on 0.6.0, but its home page returned 500' });
});

// --- The command: a live site that upgrades when the deploy command runs ---

async function fakeLiveSite(marker: string): Promise<{ server: Server; url: string }> {
  const upgraded = readAgentVersion();
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const isUpgraded = existsSync(marker);
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url === '/v1/capabilities') {
      return json({ agentVersion: isUpgraded ? upgraded : '0.0.1', contentSchemaVersion: isUpgraded ? 7 : 6 });
    }
    if (url === '/v1/content' || url === '/v1/media') {
      return json([]);
    }
    if (url === '/v1/redirects') {
      return json({ schemaVersion: 1, entries: [] });
    }
    if (url === '/v1/theme/files') {
      return isUpgraded ? json([]) : json({ message: 'Not Found' }, 404);
    }
    if (url === '/') {
      response.writeHead(200);
      return response.end('home');
    }
    return json({ message: 'Not Found' }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

function runPush(localRoot: string, args: string[], input: string) {
  const cli = join(import.meta.dirname, '..', '..', 'src', 'site-sync', 'push-cli.ts');
  const env = { ...process.env };
  delete env.CMS_TOKEN;
  const child = execFile(process.execPath, ['--experimental-strip-types', cli, ...args], { cwd: join(localRoot, 'vhost'), env });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin?.end(input);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on('exit', (code) => resolve({ code, stdout, stderr })),
  );
}

async function upgradeScenario(deployCommand: (marker: string) => string) {
  const localRoot = createLocalSite();
  const marker = join(localRoot, 'deployed');
  const live = await fakeLiveSite(marker);
  git(localRoot, ['config', 'user.name', 'Dev']);
  git(localRoot, ['config', 'user.email', 'dev@example.com']);
  mkdirSync(join(localRoot, 'vhost', 'data'), { recursive: true });
  writeJson(localRoot, 'vhost/data/sync-record.json', {
    siteUrl: live.url,
    content: { syncedAt: '', files: {}, redirects: [] },
  });
  writeFileSync(join(localRoot, 'vhost', 'deploy.json'), JSON.stringify({ command: deployCommand(marker) }));
  return {
    localRoot,
    marker,
    live,
    cleanup: async () => {
      await new Promise<void>((resolve) => live.server.close(() => resolve()));
      rmSync(localRoot, { recursive: true, force: true });
    },
  };
}

const touch = (marker: string) => `node -e "require('fs').writeFileSync(${JSON.stringify(marker).replace(/"/g, '\\"')}, '')"`;

test('npm run push --cms: deploys with vhost/deploy.json after the address is typed, and waits for the new version', async () => {
  const { localRoot, marker, live, cleanup } = await upgradeScenario(touch);
  try {
    const host = new URL(live.url).host;
    const result = await runPush(localRoot, ['--cms'], `a-token\n${host}\n`);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Step 1: upgrade the live site's CMS from 0\.0\.1 to /);
    assert.match(result.stderr, /the command in vhost\/deploy\.json/);
    assert.ok(existsSync(marker), 'the deploy command ran');
    assert.match(result.stderr, new RegExp(`The live site is now on ${readAgentVersion().replace(/\./g, '\\.')}`));
    assert.match(result.stdout, /Pushed to .*: the CMS upgrade to /);
  } finally {
    await cleanup();
  }
});

test('npm run push --cms: nothing is deployed on a wrong confirmation, and a failed deploy stops everything', async () => {
  const { localRoot, marker, cleanup } = await upgradeScenario(touch);
  try {
    const wrong = await runPush(localRoot, ['--cms'], 'a-token\nnot-the-host\n');
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /Cancelled\. Nothing was pushed\./);
    assert.equal(existsSync(marker), false);
  } finally {
    await cleanup();
  }

  const failing = await upgradeScenario(() => 'node -e "process.exit(3)"');
  try {
    const host = new URL(failing.live.url).host;
    const result = await runPush(failing.localRoot, ['--cms'], `a-token\n${host}\n`);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /The deploy failed, so nothing else was pushed/);
  } finally {
    await failing.cleanup();
  }
});

test('npm run push refuses content for a live site on an older content format unless the CMS upgrade goes with it', async () => {
  const { localRoot, live, cleanup } = await upgradeScenario(touch);
  try {
    const result = await runPush(localRoot, ['--content'], 'a-token\n');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /uses an older content format .* Push the CMS upgrade with it/);
    assert.ok(live.url);
  } finally {
    await cleanup();
  }
});
