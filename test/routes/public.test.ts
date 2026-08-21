import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
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

test('C2: a request for a nonexistent page URL returns 404, rendering the themed content/pages/404.json through the full layout/section/block pipeline', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/never-existed' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.ok(response.body.includes('Page not found'));
    // Proves the layout actually wrapped it (the same site-name snippet
    // every other page gets via the layout), not a bare section render.
    assert.ok(response.body.includes('site-name'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('a nonexistent page URL still returns a plain JSON 404 when no content/pages/404.json exists', async () => {
  const { app, siteRoot, cleanup } = buildPublicTestServer();
  try {
    unlinkSync(join(siteRoot, 'content', 'pages', '404.json'));
    const response = await app.inject({ method: 'GET', url: '/never-existed' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  } finally {
    await app.close();
    cleanup();
  }
});

test('an unpublished content/pages/404.json falls back to the plain JSON 404 rather than a 500', async () => {
  const { app, siteRoot, cleanup } = buildPublicTestServer();
  try {
    writeJson(siteRoot, 'content/pages/404.json', {
      schemaVersion: 4,
      title: 'Page Not Found',
      type: 'page',
      layout: 'theme',
      published: false,
      sections: [],
    });
    const response = await app.inject({ method: 'GET', url: '/never-existed' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  } finally {
    await app.close();
    cleanup();
  }
});

test('/blog/<slug> serves a live, published post', async () => {
  const { app, siteRoot, cleanup } = buildPublicTestServer();
  try {
    writeJson(siteRoot, 'content/posts/hello-world.json', {
      schemaVersion: 4,
      title: 'Hello World',
      type: 'post',
      layout: 'theme',
      published: true,
      author: 'Jane Editor',
      publishDate: '2026-07-27',
      tags: ['news'],
      sections: [{ id: 'sec-1', type: 'hero', settings: { heading: 'Hello World' } }],
    });

    const response = await app.inject({ method: 'GET', url: '/blog/hello-world' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.ok(response.body.includes('Hello World'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('/blog is a permanently reserved namespace: a page at content/pages/blog/x.json is unreachable at /blog/x', async () => {
  const { app, siteRoot, cleanup } = buildPublicTestServer();
  try {
    writeJson(siteRoot, 'content/pages/blog/x.json', {
      schemaVersion: 4,
      title: 'Shadowed Page',
      type: 'page',
      layout: 'theme',
      published: true,
      sections: [],
    });

    const response = await app.inject({ method: 'GET', url: '/blog/x' });
    assert.equal(response.statusCode, 404);
    assert.ok(!response.body.includes('Shadowed Page'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('a /blog/<slug> URL with no matching post renders the themed 404, same as a missing page', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/blog/never-existed' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.ok(response.body.includes('Page not found'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('the root URL / serves content/pages/index.json', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('Fixture Site'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('C3: a URL with a redirects.json entry and no live page returns a 301 to the target', async () => {
  const { app, siteRoot, cleanup } = buildPublicTestServer();
  try {
    writeJson(siteRoot, 'content/redirects.json', { '/old-page': '/about' });
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
    writeJson(siteRoot, 'content/redirects.json', { '/about': '/somewhere-else' });
    const response = await app.inject({ method: 'GET', url: '/about' });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('About Us'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('C6: a path traversal attempt against the public route fails safely, never a 500 or leaked content (and renders the themed 404, not just a plain error)', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/..%2f..%2f..%2fetc%2fpasswd' });
    assert.equal(response.statusCode, 404);
    assert.ok(!response.body.includes('root:'));
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.ok(response.body.includes('Page not found'));
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

test('theme/root/robots.txt is mirrored verbatim at the bare /robots.txt path', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/robots.txt' });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /User-agent: \*/);
  } finally {
    await app.close();
    cleanup();
  }
});

test('theme/root/ subfolders are preserved - .well-known/security.txt is reachable at /.well-known/security.txt', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/.well-known/security.txt' });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /security@example\.test/);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a root-mirror miss falls straight through to normal page lookup, never a spurious 404', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    // /about is real published page content, not a theme/root/ file -
    // proves the miss path doesn't swallow or otherwise interfere with
    // ordinary page resolution.
    const response = await app.inject({ method: 'GET', url: '/about' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  } finally {
    await app.close();
    cleanup();
  }
});

test('the bare site root ("/") still resolves to content/pages/index.json, not theme/root/ (a directory, never a file)', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt against the theme/root/ mirror fails safely, never a 500', async () => {
  const { app, cleanup } = buildPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/..%2f..%2f..%2fetc%2fpasswd' });
    assert.notEqual(response.statusCode, 500);
  } finally {
    await app.close();
    cleanup();
  }
});
