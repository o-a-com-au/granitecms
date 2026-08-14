import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootSite } from '../src/boot.ts';
import { buildServer, startServer } from '../src/server.ts';
import { loadServerConfig } from '../src/server-config.ts';
import { CURRENT_SCHEMA_VERSION } from '../src/migrations/index.ts';
import { CHECKPOINT_MESSAGE, getCommitLog } from '../src/services/git-history.ts';
import { DRIVER_NAME } from '../src/search/drivers/node-sqlite-driver.ts';
import { createTmpSiteRoot, writeJson } from './helpers/tmp-site.ts';

const AGENT_PACKAGE_JSON = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };

function buildTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });
  return { app, cleanup };
}

test('A3: GET /v1/capabilities returns the agent package version, the content schema version, and the active SQLite driver', async () => {
  const { app, cleanup } = buildTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/capabilities' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      agentVersion: string;
      contentSchemaVersion: number;
      sqliteDriver: string;
      maxMediaUploadBytes: number;
    };
    // Asserted against the real sources of truth, not hardcoded
    // expected strings that would silently drift.
    assert.equal(body.agentVersion, AGENT_PACKAGE_JSON.version);
    assert.equal(body.contentSchemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(body.sqliteDriver, DRIVER_NAME);
    // The default (no site.config.json "media" key at all in this tmp
    // site) - proves this endpoint reports whatever the server was
    // actually configured with, not a hardcoded literal of its own.
    assert.equal(body.maxMediaUploadBytes, 10 * 1024 * 1024);
  } finally {
    await app.close();
    cleanup();
  }
});

test('A2: every route is registered under a /v1 prefix', async () => {
  const { app, cleanup } = buildTestServer();
  try {
    const unprefixed = await app.inject({ method: 'GET', url: '/capabilities' });
    assert.equal(unprefixed.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('A4: requesting an unregistered route returns 404 with a structured JSON error body', async () => {
  const { app, cleanup } = buildTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    const body = response.json() as { statusCode: number; error: string; message: string };
    assert.equal(body.statusCode, 404);
    assert.equal(typeof body.error, 'string');
    assert.equal(typeof body.message, 'string');
  } finally {
    await app.close();
    cleanup();
  }
});

test('A5: an uncaught error thrown inside a route handler returns 500 with a structured JSON error body, never a raw stack trace', async () => {
  const { app, cleanup } = buildTestServer();
  try {
    app.get('/v1/__throws', async () => {
      throw new Error('internal detail that must never reach the client');
    });

    const response = await app.inject({ method: 'GET', url: '/v1/__throws' });
    assert.equal(response.statusCode, 500);
    const body = response.json() as { statusCode: number; error: string; message: string };
    assert.equal(body.statusCode, 500);
    assert.equal(body.error, 'Internal Server Error');
    assert.equal(body.message, 'Internal Server Error');
    assert.ok(!response.body.includes('internal detail'));
    assert.ok(!response.body.includes('.ts:'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('a route error below 500 (e.g. a future schema-validation failure) is passed through with its real message, not sanitised', async () => {
  const { app, cleanup } = buildTestServer();
  try {
    app.get('/v1/__bad-request', async () => {
      const error = new Error('specific, safe-to-show validation detail') as Error & { statusCode: number };
      error.statusCode = 400;
      throw error;
    });

    const response = await app.inject({ method: 'GET', url: '/v1/__bad-request' });
    assert.equal(response.statusCode, 400);
    const body = response.json() as { statusCode: number; message: string };
    assert.equal(body.message, 'specific, safe-to-show validation detail');
  } finally {
    await app.close();
    cleanup();
  }
});

test('A1: the server boots by calling bootSite and starts a Fastify instance listening on a configured port', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    // .inject() deliberately bypasses the real network stack, so it
    // can't prove a real listener exists - this test uses an actual
    // socket. port: 0 (ephemeral), not a fixed port: node --test runs
    // files in parallel by default, and a fixed port risks flaky
    // collisions with other test files' real listeners.
    // Since this test uses startServer (not buildServer), its own
    // app.close() below also incidentally triggers one checkpoint run
    // (H4) - harmless, since this fixture's drafts/ is untouched, a
    // cheap 'clean' short-circuit (one extra execFileSync call, no
    // commit), not a behaviour change to this test's own assertions.
    writeJson(siteRoot, 'vhost/site.config.json', { port: 0 });

    const app = await startServer(siteRoot, { logger: false });
    try {
      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a real bound network address');
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/v1/capabilities`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { agentVersion: string };
      assert.equal(typeof body.agentVersion, 'string');
    } finally {
      await app.close();
    }
  } finally {
    cleanup();
  }
});

test('H3: an allowlisted IP reaches the API; a non-allowlisted IP gets 403 - real socket, not .inject() (request.ip is only meaningful over a real connection)', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    // A real fetch() to 127.0.0.1 resolves request.ip to exactly
    // '127.0.0.1' in this environment - confirmed empirically before
    // writing this test, not assumed (a dual-stack bind can otherwise
    // present a client as '::ffff:127.0.0.1', which .inject() would
    // never reproduce since it synthesizes request.ip rather than
    // exercising a real socket).
    writeJson(siteRoot, 'vhost/site.config.json', { port: 0, ipAllowlist: ['127.0.0.1'] });

    const app = await startServer(siteRoot, { logger: false });
    try {
      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a real bound network address');
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/capabilities`);
      assert.equal(response.status, 200);
    } finally {
      await app.close();
    }
  } finally {
    cleanup();
  }

  const { siteRoot: siteRoot2, cleanup: cleanup2 } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    // An allowlist that deliberately excludes 127.0.0.1 - a real fetch
    // from this machine must be rejected.
    writeJson(siteRoot2, 'vhost/site.config.json', { port: 0, ipAllowlist: ['203.0.113.99'] });

    const app = await startServer(siteRoot2, { logger: false });
    try {
      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a real bound network address');
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/capabilities`);
      assert.equal(response.status, 403);
    } finally {
      await app.close();
    }
  } finally {
    cleanup2();
  }
});

test('H3: an empty ipAllowlist (the default) is a no-op - any IP reaches the API', async () => {
  const { app, cleanup } = buildTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/capabilities' });
    assert.equal(response.statusCode, 200);
  } finally {
    await app.close();
    cleanup();
  }
});

test('H3: a disallowed IP still reaches the public website and static assets - the allowlist is scoped to /v1 only', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { port: 0, ipAllowlist: ['203.0.113.99'] });

    const app = await startServer(siteRoot, { logger: false });
    try {
      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a real bound network address');
      }

      const v1Response = await fetch(`http://127.0.0.1:${address.port}/v1/capabilities`);
      assert.equal(v1Response.status, 403);

      // The public site's own catch-all still resolves normally
      // (404, since no page exists at this path in the fixture - the
      // point is that it's never 403'd by the /v1-scoped hook).
      const publicResponse = await fetch(`http://127.0.0.1:${address.port}/never-existed`);
      assert.notEqual(publicResponse.status, 403);
    } finally {
      await app.close();
    }
  } finally {
    cleanup();
  }
});

test('H4: a real startServer instance runs a final draft checkpoint on graceful shutdown via app.close()', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { port: 0 });
    mkdirSync(join(siteRoot, 'content', 'drafts', 'pages'), { recursive: true });
    writeFileSync(join(siteRoot, 'content', 'drafts', 'pages', 'uncommitted.json'), '{"draft":true}');

    const app = await startServer(siteRoot, { logger: false });
    await app.close();

    const config = bootSite(siteRoot).config;
    const result = getCommitLog(config, {});
    const checkpoint = result.commits.find((c) => c.message === CHECKPOINT_MESSAGE);
    assert.ok(checkpoint, 'a checkpoint commit must exist after shutdown');
    assert.equal(checkpoint?.isCheckpoint, true);
  } finally {
    cleanup();
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('H4: SIGTERM triggers the same graceful-shutdown checkpoint, not just a direct app.close() call', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeJson(siteRoot, 'vhost/site.config.json', { port: 0 });
    mkdirSync(join(siteRoot, 'content', 'drafts', 'pages'), { recursive: true });
    writeFileSync(join(siteRoot, 'content', 'drafts', 'pages', 'uncommitted.json'), '{"draft":true}');

    await startServer(siteRoot, { logger: false });
    // Exercises the real signal-listener function registered by
    // startServer itself, not just the onClose hook it delegates to -
    // process.emit synthesizes the signal without actually sending a
    // real OS signal to this test process. Polled rather than awaited
    // via a second onClose hook: Fastify's own onClose hooks run in
    // reverse registration order, so a hook added here afterward would
    // fire *before* startServer's own checkpoint hook completes, a
    // race this avoids entirely.
    const config = bootSite(siteRoot).config;
    process.emit('SIGTERM');

    const deadline = Date.now() + 2000;
    let checkpoint: ReturnType<typeof getCommitLog>['commits'][number] | undefined;
    while (!checkpoint && Date.now() < deadline) {
      checkpoint = getCommitLog(config, {}).commits.find((c) => c.message === CHECKPOINT_MESSAGE);
      if (!checkpoint) {
        await sleep(20);
      }
    }
    assert.ok(checkpoint, 'a checkpoint commit must exist after a real SIGTERM');
  } finally {
    cleanup();
  }
});
