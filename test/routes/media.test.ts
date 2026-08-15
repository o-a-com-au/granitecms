import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

const MEDIA_TOKEN = 'media-test-token';
const NON_MEDIA_TOKEN = 'content-only-test-token';

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function buildMediaTestServer(siteConfigOverrides: Record<string, unknown> = {}) {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'vhost/site.config.json', {
    tokens: [
      { hash: hashOf(MEDIA_TOKEN), scopes: ['media'] },
      { hash: hashOf(NON_MEDIA_TOKEN), scopes: ['content'] },
    ],
    ...siteConfigOverrides,
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup };
}

// Hand-builds a minimal, valid multipart/form-data body - light-my-
// request's own .inject() accepts an arbitrary raw payload/headers, so
// there's no higher-level form-building helper needed, just the exact
// bytes a real browser upload would send.
function buildMultipartBody(
  filename: string,
  mimetype: string,
  bytes: Buffer,
): { payload: Buffer; contentType: string } {
  const boundary = '----cmsAgentTestBoundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

test('GET /v1/media lists uploaded files', async () => {
  const { app, cleanup } = buildMediaTestServer();
  try {
    const { payload, contentType } = buildMultipartBody('photo.jpg', 'image/jpeg', Buffer.from('hello'));
    await app.inject({
      method: 'POST',
      url: '/v1/media',
      headers: { authorization: `Bearer ${MEDIA_TOKEN}`, 'content-type': contentType },
      payload,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/media',
      headers: { authorization: `Bearer ${MEDIA_TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as Array<{ name: string }>;
    assert.equal(body.length, 1);
    assert.match(body[0]?.name ?? '', /\.jpg$/);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/media with no token is rejected with 401', async () => {
  const { app, cleanup } = buildMediaTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/media' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/media with a token missing the media scope is rejected with 403', async () => {
  const { app, cleanup } = buildMediaTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/media',
      headers: { authorization: `Bearer ${NON_MEDIA_TOKEN}` },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/media with a valid image returns 201 with {name, size, url}, and the file is fetchable at that url', async () => {
  const { app, cleanup } = buildMediaTestServer();
  try {
    const { payload, contentType } = buildMultipartBody('photo.jpg', 'image/jpeg', Buffer.from('hello'));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/media',
      headers: { authorization: `Bearer ${MEDIA_TOKEN}`, 'content-type': contentType },
      payload,
    });

    assert.equal(response.statusCode, 201);
    const body = response.json() as { name: string; size: number; url: string };
    assert.match(body.name, /^[0-9a-f]{12}-photo\.jpg$/);
    assert.equal(body.size, 5);
    assert.equal(body.url, `/media/${body.name}`);

    const fetched = await app.inject({ method: 'GET', url: body.url });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.body, 'hello');
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/media with an .svg file is rejected with 415, and nothing is written to disk', async () => {
  const { app, cleanup } = buildMediaTestServer();
  try {
    const { payload, contentType } = buildMultipartBody(
      'icon.svg',
      'image/svg+xml',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/media',
      headers: { authorization: `Bearer ${MEDIA_TOKEN}`, 'content-type': contentType },
      payload,
    });
    assert.equal(response.statusCode, 415);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/media',
      headers: { authorization: `Bearer ${MEDIA_TOKEN}` },
    });
    assert.deepEqual(list.json(), []);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/media over the configured size limit is rejected with 413', async () => {
  const { app, cleanup } = buildMediaTestServer({ media: { maxUploadBytes: 10 } });
  try {
    const { payload, contentType } = buildMultipartBody(
      'photo.jpg',
      'image/jpeg',
      Buffer.from('this is definitely more than ten bytes'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/media',
      headers: { authorization: `Bearer ${MEDIA_TOKEN}`, 'content-type': contentType },
      payload,
    });
    assert.equal(response.statusCode, 413);
  } finally {
    await app.close();
    cleanup();
  }
});

test('DELETE /v1/media/:name removes an existing file, and a repeat delete 404s', async () => {
  const { app, cleanup } = buildMediaTestServer();
  try {
    const { payload, contentType } = buildMultipartBody('photo.jpg', 'image/jpeg', Buffer.from('hello'));
    const uploadResponse = await app.inject({
      method: 'POST',
      url: '/v1/media',
      headers: { authorization: `Bearer ${MEDIA_TOKEN}`, 'content-type': contentType },
      payload,
    });
    const { name } = uploadResponse.json() as { name: string };

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/v1/media/${name}`,
      headers: { authorization: `Bearer ${MEDIA_TOKEN}` },
    });
    assert.equal(deleteResponse.statusCode, 204);

    const repeatDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/media/${name}`,
      headers: { authorization: `Bearer ${MEDIA_TOKEN}` },
    });
    assert.equal(repeatDelete.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('DELETE /v1/media/:name with a missing file returns 404', async () => {
  const { app, cleanup } = buildMediaTestServer();
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/media/never-existed.jpg',
      headers: { authorization: `Bearer ${MEDIA_TOKEN}` },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt against DELETE /v1/media/:path fails safely, never a 500', async () => {
  const { app, cleanup } = buildMediaTestServer();
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/media/..%2f..%2f..%2fetc%2fpasswd',
      headers: { authorization: `Bearer ${MEDIA_TOKEN}` },
    });
    assert.ok(response.statusCode === 400 || response.statusCode === 404);
  } finally {
    await app.close();
    cleanup();
  }
});
