import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

const CONTENT_TOKEN = 'content-test-token';
const author = { name: 'Jane Editor', email: 'jane@example.com' };

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function page(title: string, type: string, published = true): object {
  return { schemaVersion: 3, title, type, published, sections: [] };
}

// No theme needed: D1/D3/D4 never render anything, just read raw JSON.
function buildContentTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup };
}

test('D1: GET /v1/content/:path returns the live file content and an ETag header', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('About', 'page'));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/content/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.headers.etag);
    const body = response.json() as { title: string };
    assert.equal(body.title, 'About');
  } finally {
    await app.close();
    cleanup();
  }
});

test('D1: GET /v1/content/:path returns 404 for a missing file', async () => {
  const { app, cleanup } = buildContentTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/content/pages/never-existed.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt against GET /v1/content/:path fails safely, never a 500', async () => {
  const { app, cleanup } = buildContentTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/content/..%2f..%2f..%2fetc%2fpasswd',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.ok(response.statusCode === 400 || response.statusCode === 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/content/:path with no token is rejected with 401', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('About', 'page'));
    const response = await app.inject({ method: 'GET', url: '/v1/content/pages/about.json' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

test('D4: the ETag is stable across repeated reads when the file has not changed', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('About', 'page'));

    const first = await app.inject({
      method: 'GET',
      url: '/v1/content/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    const second = await app.inject({
      method: 'GET',
      url: '/v1/content/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(first.headers.etag, second.headers.etag);
  } finally {
    await app.close();
    cleanup();
  }
});

test('D4: the ETag changes when the file content changes', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('About', 'page'));
    const before = await app.inject({
      method: 'GET',
      url: '/v1/content/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    writeJson(siteRoot, 'content/pages/about.json', page('About (updated)', 'page'));
    const after = await app.inject({
      method: 'GET',
      url: '/v1/content/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.notEqual(before.headers.etag, after.headers.etag);
  } finally {
    await app.close();
    cleanup();
  }
});

test('D3: GET /v1/content lists content, including a draft-only page', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('About', 'page'));
    writeJson(siteRoot, 'drafts/pages/draft-only.json', page('Draft Only', 'page'));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/content',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as Array<{ path: string; hasDraft: boolean }>;
    const paths = body.map((e) => e.path).sort();
    assert.deepEqual(paths, ['pages/about.json', 'pages/draft-only.json']);
  } finally {
    await app.close();
    cleanup();
  }
});

test('D3: GET /v1/content filters by type, prefix, and draftStatus', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('About', 'page'));
    writeJson(siteRoot, 'content/pages/blog-post.json', page('A Post', 'article'));
    writeJson(siteRoot, 'drafts/pages/draft-only.json', page('Draft Only', 'page'));

    const byType = await app.inject({
      method: 'GET',
      url: '/v1/content?type=article',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.deepEqual(
      (byType.json() as Array<{ path: string }>).map((e) => e.path),
      ['pages/blog-post.json'],
    );

    const byPrefix = await app.inject({
      method: 'GET',
      url: '/v1/content?prefix=pages/about',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.deepEqual(
      (byPrefix.json() as Array<{ path: string }>).map((e) => e.path),
      ['pages/about.json'],
    );

    const byDraftStatus = await app.inject({
      method: 'GET',
      url: '/v1/content?draftStatus=has-draft',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.deepEqual(
      (byDraftStatus.json() as Array<{ path: string }>).map((e) => e.path),
      ['pages/draft-only.json'],
    );
  } finally {
    await app.close();
    cleanup();
  }
});

test('F3: DELETE /v1/content/:path deletes a live page in one commit', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About', 'page')));
    const config = bootSite(siteRoot).config;

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/content/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: 'delete about', author },
    });

    assert.equal(response.statusCode, 204);
    assert.equal(existsSync(join(config.pagesRoot, 'about.json')), false);
  } finally {
    await app.close();
    cleanup();
  }
});

test('F3: DELETE /v1/content/:path with redirectTo records a redirect', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About', 'page')));

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/content/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { redirectTo: '/company', message: 'delete about', author },
    });

    assert.equal(response.statusCode, 204);
    const redirects = JSON.parse(readFileSync(join(siteRoot, 'redirects.json'), 'utf-8')) as Record<
      string,
      string
    >;
    assert.equal(redirects['/about'], '/company');
  } finally {
    await app.close();
    cleanup();
  }
});

test('F3: DELETE /v1/content/:path returns 409 when the page has a real child page', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About', 'page')));
    writeAndCommit(siteRoot, 'content/pages/about/team.json', JSON.stringify(page('Team', 'page')));

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/content/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: 'delete about', author },
    });

    assert.equal(response.statusCode, 409);
  } finally {
    await app.close();
    cleanup();
  }
});

test('F3: DELETE /v1/content/:path returns 404 for a nonexistent page', async () => {
  const { app, cleanup } = buildContentTestServer();
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/content/pages/never-existed.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: 'delete', author },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('F3: DELETE /v1/content/:path rejects a malformed body with 400', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About', 'page')));
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/content/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: '' },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt against DELETE /v1/content/:path fails safely, never a 500', async () => {
  const { app, cleanup } = buildContentTestServer();
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/content/..%2f..%2f..%2fetc%2fpasswd',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: 'x', author },
    });
    assert.ok(response.statusCode === 400 || response.statusCode === 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('DELETE /v1/content/:path with no token is rejected with 401', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About', 'page')));
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/content/pages/about.json',
      headers: { 'content-type': 'application/json' },
      payload: { message: 'x', author },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

test('F4: POST /v1/content/move moves a page', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About', 'page')));
    const config = bootSite(siteRoot).config;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/content/move',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/about', to: '/company', message: 'move about', author },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(existsSync(join(config.pagesRoot, 'about.json')), false);
    assert.ok(existsSync(join(config.pagesRoot, 'company.json')));
  } finally {
    await app.close();
    cleanup();
  }
});

test('F4: POST /v1/content/move returns 404 when the source page does not exist', async () => {
  const { app, cleanup } = buildContentTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/content/move',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/never-existed', to: '/somewhere', message: 'move', author },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('F4: POST /v1/content/move against a /blog/ URL is not extended to posts in this pass - it safely 404s rather than corrupting anything', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeAndCommit(siteRoot, 'content/posts/hello-world.json', JSON.stringify({
      schemaVersion: 4,
      title: 'Hello World',
      type: 'post',
      layout: 'theme',
      published: true,
      author: 'Jane Editor',
      publishDate: '2026-07-27',
      tags: [],
      sections: [],
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/content/move',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/blog/hello-world', to: '/blog/renamed', message: 'move', author },
    });
    // move.ts is pages-only by design (see docs/phase-2-checklist.md's
    // Group L notes) - a /blog/ URL resolves via pages' own
    // urlToPagePath convention, which never finds a page there, so this
    // is a deliberate, harmless 404, not a bug.
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('F4: POST /v1/content/move returns 409 when the destination already exists', async () => {
  const { app, siteRoot, cleanup } = buildContentTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About', 'page')));
    writeAndCommit(siteRoot, 'content/pages/company.json', JSON.stringify(page('Company', 'page')));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/content/move',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/about', to: '/company', message: 'move', author },
    });
    assert.equal(response.statusCode, 409);
  } finally {
    await app.close();
    cleanup();
  }
});

test('F4: POST /v1/content/move rejects a malformed body with 400', async () => {
  const { app, cleanup } = buildContentTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/content/move',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/about', message: 'move', author },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/content/move with no token is rejected with 401', async () => {
  const { app, cleanup } = buildContentTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/content/move',
      headers: { 'content-type': 'application/json' },
      payload: { from: '/about', to: '/company', message: 'move', author },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/content with no token is rejected with 401', async () => {
  const { app, cleanup } = buildContentTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/content' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});
