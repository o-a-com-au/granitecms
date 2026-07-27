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
  return { schemaVersion: 4, title, type, layout: 'theme', published, sections: [] };
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

test('E1: PUT /v1/drafts/:path without an If-Match header is rejected with 428', async () => {
  const { app, cleanup } = buildDraftsTestServer();
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/drafts/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: page('About', 'page'),
    });
    assert.equal(response.statusCode, 428);
  } finally {
    await app.close();
    cleanup();
  }
});

test('E3 (route wiring): PUT /v1/drafts/:path with a matching If-Match succeeds and writes the draft', async () => {
  const { app, cleanup } = buildDraftsTestServer();
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/drafts/pages/about.json',
      headers: {
        authorization: `Bearer ${CONTENT_TOKEN}`,
        'content-type': 'application/json',
        'if-match': 'no-prior-file',
      },
      payload: page('About', 'page'),
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.headers.etag);

    const read = await app.inject({
      method: 'GET',
      url: '/v1/drafts/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(read.statusCode, 200);
  } finally {
    await app.close();
    cleanup();
  }
});

test('E2 (route wiring): PUT /v1/drafts/:path with a stale If-Match returns 409', async () => {
  const { app, cleanup } = buildDraftsTestServer();
  try {
    await app.inject({
      method: 'PUT',
      url: '/v1/drafts/pages/about.json',
      headers: {
        authorization: `Bearer ${CONTENT_TOKEN}`,
        'content-type': 'application/json',
        'if-match': 'no-prior-file',
      },
      payload: page('About', 'page'),
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/drafts/pages/about.json',
      headers: {
        authorization: `Bearer ${CONTENT_TOKEN}`,
        'content-type': 'application/json',
        'if-match': '"stale-etag"',
      },
      payload: page('About Changed', 'page'),
    });
    assert.equal(response.statusCode, 409);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt against PUT /v1/drafts/:path fails safely, never a 500', async () => {
  const { app, cleanup } = buildDraftsTestServer();
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/drafts/..%2f..%2f..%2fetc%2fpasswd',
      headers: {
        authorization: `Bearer ${CONTENT_TOKEN}`,
        'content-type': 'application/json',
        'if-match': 'irrelevant',
      },
      payload: page('X', 'page'),
    });
    assert.ok(response.statusCode === 400 || response.statusCode === 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('E5: DELETE /v1/drafts/:path discards the draft', async () => {
  const { app, siteRoot, cleanup } = buildDraftsTestServer();
  try {
    writeJson(siteRoot, 'drafts/pages/about.json', page('Draft About', 'page'));

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/drafts/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 204);

    const read = await app.inject({
      method: 'GET',
      url: '/v1/drafts/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(read.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('DELETE /v1/drafts/:path discarding a draft that does not exist is idempotent', async () => {
  const { app, cleanup } = buildDraftsTestServer();
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/drafts/pages/never-existed.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 204);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt against DELETE /v1/drafts/:path fails safely, never a 500', async () => {
  const { app, cleanup } = buildDraftsTestServer();
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/drafts/..%2f..%2f..%2fetc%2fpasswd',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.ok(response.statusCode === 400 || response.statusCode === 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('PUT/DELETE /v1/drafts/:path with no token are rejected with 401', async () => {
  const { app, cleanup } = buildDraftsTestServer();
  try {
    const putResponse = await app.inject({
      method: 'PUT',
      url: '/v1/drafts/pages/about.json',
      headers: { 'content-type': 'application/json', 'if-match': 'x' },
      payload: page('About', 'page'),
    });
    assert.equal(putResponse.statusCode, 401);

    const deleteResponse = await app.inject({ method: 'DELETE', url: '/v1/drafts/pages/about.json' });
    assert.equal(deleteResponse.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

// E6 is proven for real at the service layer (test/services/drafts.test.ts),
// where the outcome is deterministic by construction (the If-Match check
// runs inside the queued job). This is a supplementary end-to-end sanity
// check that the real HTTP route is wired the same way - not the
// regression proof itself, since HTTP request-dispatch overhead was
// empirically shown (during design review) to sometimes mask a broken
// implementation that a direct service-layer call would reliably catch.
test('E6 (HTTP wiring sanity, not the regression proof): two concurrent PUTs racing with the same If-Match value resolve to exactly one success', async () => {
  const { app, cleanup } = buildDraftsTestServer();
  try {
    await app.inject({
      method: 'PUT',
      url: '/v1/drafts/pages/about.json',
      headers: {
        authorization: `Bearer ${CONTENT_TOKEN}`,
        'content-type': 'application/json',
        'if-match': 'no-prior-file',
      },
      payload: page('About', 'page'),
    });
    const read = await app.inject({
      method: 'GET',
      url: '/v1/drafts/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    const startingEtag = read.headers.etag as string;

    const [r1, r2] = await Promise.all([
      app.inject({
        method: 'PUT',
        url: '/v1/drafts/pages/about.json',
        headers: {
          authorization: `Bearer ${CONTENT_TOKEN}`,
          'content-type': 'application/json',
          'if-match': startingEtag,
        },
        payload: page('From A', 'page'),
      }),
      app.inject({
        method: 'PUT',
        url: '/v1/drafts/pages/about.json',
        headers: {
          authorization: `Bearer ${CONTENT_TOKEN}`,
          'content-type': 'application/json',
          'if-match': startingEtag,
        },
        payload: page('From B', 'page'),
      }),
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort();
    assert.deepEqual(statuses, [200, 409]);
  } finally {
    await app.close();
    cleanup();
  }
});
