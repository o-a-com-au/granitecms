import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

const CONTENT_TOKEN = 'redirects-test-token';
const author = { name: 'Jane Editor', email: 'jane@example.com' };

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function buildRedirectsTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup };
}

test('GET /v1/redirects lists all entries', async () => {
  const { app, siteRoot, cleanup } = buildRedirectsTestServer();
  try {
    writeAndCommit(siteRoot, 'redirects.json', JSON.stringify({ '/old': '/new' }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { schemaVersion: number; entries: Array<{ from: string; to: string }> };
    assert.deepEqual(body.entries, [{ from: '/old', to: '/new' }]);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/redirects with no token is rejected with 401', async () => {
  const { app, cleanup } = buildRedirectsTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/redirects' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/redirects creates a new entry and commits immediately', async () => {
  const { app, cleanup } = buildRedirectsTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/summer-promo', to: '/pages/new-offer', note: 'campaign', message: 'create redirect', author },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { entry: { from: string; to: string; note?: string } };
    assert.deepEqual(body.entry, { from: '/summer-promo', to: '/pages/new-offer', note: 'campaign' });

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    const listedBody = listed.json() as { entries: Array<{ from: string }> };
    assert.equal(listedBody.entries.length, 1);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/redirects rejects a malformed body with 400', async () => {
  const { app, cleanup } = buildRedirectsTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/a' },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/redirects maps an external target to 400', async () => {
  const { app, cleanup } = buildRedirectsTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/a', to: 'https://example.com', message: 'create', author },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/redirects maps a duplicate from to 409', async () => {
  const { app, cleanup } = buildRedirectsTestServer();
  try {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/a', to: '/b', message: 'create', author },
    });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/a', to: '/c', message: 'create again', author },
    });
    assert.equal(second.statusCode, 409);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/redirects maps a from that already has live content to 409', async () => {
  const { app, siteRoot, cleanup } = buildRedirectsTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify({ schemaVersion: 1, title: 'About', published: true, sections: [] }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/about', to: '/company', message: 'create', author },
    });
    assert.equal(response.statusCode, 409);
  } finally {
    await app.close();
    cleanup();
  }
});

test('PUT /v1/redirects updates an existing entry', async () => {
  const { app, cleanup } = buildRedirectsTestServer();
  try {
    await app.inject({
      method: 'POST',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/a', to: '/b', message: 'create', author },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/a', to: '/c', message: 'update', author },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { entry: { from: string; to: string } };
    assert.deepEqual(body.entry, { from: '/a', to: '/c' });
  } finally {
    await app.close();
    cleanup();
  }
});

test('PUT /v1/redirects maps not-found to 404', async () => {
  const { app, cleanup } = buildRedirectsTestServer();
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/does-not-exist', to: '/b', message: 'update', author },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('DELETE /v1/redirects removes an entry', async () => {
  const { app, cleanup } = buildRedirectsTestServer();
  try {
    await app.inject({
      method: 'POST',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/a', to: '/b', message: 'create', author },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/a', message: 'delete', author },
    });

    assert.equal(response.statusCode, 204);

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    const listedBody = listed.json() as { entries: unknown[] };
    assert.equal(listedBody.entries.length, 0);
  } finally {
    await app.close();
    cleanup();
  }
});

test('DELETE /v1/redirects maps not-found to 404', async () => {
  const { app, cleanup } = buildRedirectsTestServer();
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/redirects',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { from: '/does-not-exist', message: 'delete', author },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST/PUT/DELETE /v1/redirects with no token are rejected with 401', async () => {
  const { app, cleanup } = buildRedirectsTestServer();
  try {
    const post = await app.inject({ method: 'POST', url: '/v1/redirects', payload: {} });
    const put = await app.inject({ method: 'PUT', url: '/v1/redirects', payload: {} });
    const del = await app.inject({ method: 'DELETE', url: '/v1/redirects', payload: {} });
    assert.equal(post.statusCode, 401);
    assert.equal(put.statusCode, 401);
    assert.equal(del.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});
