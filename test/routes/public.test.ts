import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { writeJson } from '../helpers/tmp-site.ts';

const FIXTURE_SITE = join(import.meta.dirname, '..', 'fixtures', 'site');

// Reuses portability.test.ts's established pattern: a writable,
// isolated copy of the full fixture site (real theme, real published/
// unpublished/child pages), not a hand-authored tmp site - rendering a
// real page needs a real working theme, not just content dirs. Startup
// checks require a real git repo, hence the plain `git init` (no
// commit needed: public/preview routes only ever read the working
// tree, never git history).
function buildPublicTestServer() {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-public-test-'));
  cpSync(FIXTURE_SITE, siteRoot, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: siteRoot });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup: () => rmSync(siteRoot, { recursive: true, force: true }) };
}

test('C1: a request for a published page URL serves the rendered live HTML', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/about' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.ok(response.body.includes('About Us'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('C1: a nested child page URL serves the rendered live HTML', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/about/team' });
    assert.equal(response.statusCode, 200);
  } finally {
    await app.close();
    cleanup();
  }
});

test('C2: a request for an unpublished page URL returns 404', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/hidden' });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('C2: a request for a nonexistent page URL returns 404', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/never-existed' });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('C3: a URL with a redirects.json entry and no live page returns a 301 to the target', async () => {
  const { app, siteRoot, cleanup } = buildPublicTestServer();
  try {
    writeJson(siteRoot, 'redirects.json', { '/old-page': '/about' });
    const response = await app.inject({ method: 'GET', url: '/old-page' });
    assert.equal(response.statusCode, 301);
    assert.equal(response.headers.location, '/about');
  } finally {
    await app.close();
    cleanup();
  }
});

test('C4: a live page always wins over a redirect recorded at the same URL, at the HTTP layer', async () => {
  const { app, siteRoot, cleanup } = buildPublicTestServer();
  try {
    // /about is a real, live, published page - a redirect entry
    // colliding with it must never be served (extends Phase 1's E6
    // renderer-level proof to the HTTP layer).
    writeJson(siteRoot, 'redirects.json', { '/about': '/somewhere-else' });
    const response = await app.inject({ method: 'GET', url: '/about' });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('About Us'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('C6: a path traversal attempt against the public route fails safely, never a 500 or leaked content', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/..%2f..%2f..%2fetc%2fpasswd' });
    assert.ok(
      response.statusCode === 400 || response.statusCode === 404,
      `expected 400 or 404, got ${response.statusCode}`,
    );
    assert.ok(!response.body.includes('root:'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('a HEAD request against a published page URL returns 200 with an empty body (Fastify auto-generates HEAD from GET)', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'HEAD', url: '/about' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '');
  } finally {
    await app.close();
    cleanup();
  }
});

test('an unmatched /v1/* path is never swallowed by the public catch-all as a page lookup', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  } finally {
    await app.close();
    cleanup();
  }
});
