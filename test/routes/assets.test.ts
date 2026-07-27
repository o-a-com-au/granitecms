import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';

const FIXTURE_SITE = join(import.meta.dirname, '..', 'fixtures', 'site');

// Same real-fixture-site pattern as public.test.ts.
function buildAssetsTestServer() {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-assets-test-'));
  cpSync(FIXTURE_SITE, siteRoot, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: siteRoot });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, cleanup: () => rmSync(siteRoot, { recursive: true, force: true }) };
}

test('a real asset is served with the correct Content-Type and body bytes', async () => {
  const { app, cleanup } = buildAssetsTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/assets/style.css' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/css; charset=utf-8');
    assert.ok(response.body.includes('.hero'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('a missing asset 404s', async () => {
  const { app, cleanup } = buildAssetsTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/assets/does-not-exist.css' });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt against /assets/:path fails safely, never a 500', async () => {
  const { app, cleanup } = buildAssetsTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/assets/..%2f..%2f..%2fetc%2fpasswd' });
    assert.ok(response.statusCode === 400 || response.statusCode === 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('/assets/* is not swallowed by the public catch-all, and an unrelated path still reaches the catch-all', async () => {
  const { app, cleanup } = buildAssetsTestServer();
  try {
    const assetResponse = await app.inject({ method: 'GET', url: '/assets/style.css' });
    assert.equal(assetResponse.statusCode, 200);
    assert.equal(assetResponse.headers['content-type'], 'text/css; charset=utf-8');

    // A path that merely starts with "assets" as a string, but isn't
    // under the real /assets/ prefix, must still reach the public
    // page-lookup catch-all (and 404 there, since no such page exists) -
    // proving the two routes don't ambiguously overlap. The fixture
    // site ships a themed content/pages/404.json (see public.test.ts's
    // "themed 404" tests), so the catch-all's 404 renders that page as
    // HTML rather than the plain JSON error - still a 404, just no
    // longer the bare JSON shape.
    const unrelatedResponse = await app.inject({ method: 'GET', url: '/assetsfoo' });
    assert.equal(unrelatedResponse.statusCode, 404);
    assert.equal(unrelatedResponse.headers['content-type'], 'text/html; charset=utf-8');
  } finally {
    await app.close();
    cleanup();
  }
});

test('/assets/* requires no token: a request with no Authorization header still succeeds', async () => {
  const { app, cleanup } = buildAssetsTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/assets/style.css' });
    assert.equal(response.statusCode, 200);
  } finally {
    await app.close();
    cleanup();
  }
});
