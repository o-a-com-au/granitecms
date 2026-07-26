import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

const CONTENT_TOKEN = 'drafts-test-token';

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function page(title: string, type: string, published = true): object {
  return { schemaVersion: 3, title, type, published, sections: [] };
}

function buildDraftsTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup };
}

test('D2: GET /v1/drafts/:path returns the draft file content and an ETag header', async () => {
  const { app, siteRoot, cleanup } = buildDraftsTestServer();
  try {
    writeJson(siteRoot, 'drafts/pages/about.json', page('Draft About', 'page'));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/drafts/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.headers.etag);
    const body = response.json() as { title: string };
    assert.equal(body.title, 'Draft About');
  } finally {
    await app.close();
    cleanup();
  }
});

test('D2: GET /v1/drafts/:path returns 404 for a missing draft', async () => {
  const { app, cleanup } = buildDraftsTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/drafts/pages/never-existed.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt against GET /v1/drafts/:path fails safely, never a 500', async () => {
  const { app, cleanup } = buildDraftsTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/drafts/..%2f..%2f..%2fetc%2fpasswd',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.ok(response.statusCode === 400 || response.statusCode === 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/drafts/:path with no token is rejected with 401', async () => {
  const { app, siteRoot, cleanup } = buildDraftsTestServer();
  try {
    writeJson(siteRoot, 'drafts/pages/about.json', page('Draft About', 'page'));
    const response = await app.inject({ method: 'GET', url: '/v1/drafts/pages/about.json' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});
