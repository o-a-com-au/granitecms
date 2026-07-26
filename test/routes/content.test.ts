import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

const CONTENT_TOKEN = 'content-test-token';

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
