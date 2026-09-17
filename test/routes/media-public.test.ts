import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootSite } from '../../src/boot.ts';
import { loadSiteConfig } from '../../src/config.ts';
import { putMedia } from '../../src/media/manage-media.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot } from '../helpers/tmp-site.ts';

async function buildMediaPublicTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });
  const config = loadSiteConfig(siteRoot);
  return { app, config, cleanup };
}

test('a real uploaded file is served with the correct Content-Type and body bytes', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'photo.jpg', Buffer.from('hello'));

    const response = await app.inject({ method: 'GET', url: `/media/${name}` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/jpeg');
    assert.equal(response.body, 'hello');
  } finally {
    await app.close();
    cleanup();
  }
});

test('the response carries an immutable, one-year Cache-Control - safe because filenames are content-addressed, so a given URL\'s bytes never change', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'photo.jpg', Buffer.from('hello'));
    const response = await app.inject({ method: 'GET', url: `/media/${name}` });
    assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
  } finally {
    await app.close();
    cleanup();
  }
});

test('the response carries X-Content-Type-Options: nosniff', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'photo.jpg', Buffer.from('hello'));
    const response = await app.inject({ method: 'GET', url: `/media/${name}` });
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  } finally {
    await app.close();
    cleanup();
  }
});

test('the response carries Access-Control-Allow-Origin: * - the admin\'s preview route makes genuinely cross-origin requests for this path', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'photo.jpg', Buffer.from('hello'));
    const response = await app.inject({ method: 'GET', url: `/media/${name}` });
    assert.equal(response.headers['access-control-allow-origin'], '*');
  } finally {
    await app.close();
    cleanup();
  }
});

test('a missing media file 404s', async () => {
  const { app, cleanup } = await buildMediaPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/media/does-not-exist.jpg' });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt against /media/:path fails safely, never a 500', async () => {
  const { app, cleanup } = await buildMediaPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/media/..%2f..%2f..%2fetc%2fpasswd' });
    assert.ok(response.statusCode === 400 || response.statusCode === 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a ?width= query suffix is silently ignored - same status and bytes as without it', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'photo.jpg', Buffer.from('hello'));
    const response = await app.inject({ method: 'GET', url: `/media/${name}?width=1500` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'hello');
  } finally {
    await app.close();
    cleanup();
  }
});

test('/media/* requires no token: a request with no Authorization header still succeeds', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'photo.jpg', Buffer.from('hello'));
    const response = await app.inject({ method: 'GET', url: `/media/${name}` });
    assert.equal(response.statusCode, 200);
  } finally {
    await app.close();
    cleanup();
  }
});

// Range support. Not an optimisation: Safari and iOS open a <video>
// with "Range: bytes=0-1" and refuse to play at all if answered with a
// plain 200, so these cases are what make video work in those browsers.
// It also lets preload="metadata" read a duration without pulling the
// whole file down.

// A body long enough that every slice below is independently
// recognisable - a 5-byte payload would make an off-by-one or a
// wrong-region bug pass unnoticed.
const RANGE_BODY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

test('Accept-Ranges is advertised on every media response, not just ranged ones - it is how a client learns to ask', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'clip.mp4', Buffer.from(RANGE_BODY));
    const response = await app.inject({ method: 'GET', url: `/media/${name}` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['accept-ranges'], 'bytes');
  } finally {
    await app.close();
    cleanup();
  }
});

test('a video is served as video/mp4 - without it the browser downloads rather than plays, and nosniff blocks any rescue', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'clip.mp4', Buffer.from(RANGE_BODY));
    const response = await app.inject({ method: 'GET', url: `/media/${name}` });
    assert.equal(response.headers['content-type'], 'video/mp4');
  } finally {
    await app.close();
    cleanup();
  }
});

test("Safari's opening bytes=0-1 probe gets a 206 with exactly those two bytes", async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'clip.mp4', Buffer.from(RANGE_BODY));
    const response = await app.inject({
      method: 'GET',
      url: `/media/${name}`,
      headers: { range: 'bytes=0-1' },
    });

    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-range'], `bytes 0-1/${RANGE_BODY.length}`);
    // The actual bytes, not just the length: proves the slice is the
    // requested region rather than merely the right size.
    assert.equal(response.body, 'AB');
  } finally {
    await app.close();
    cleanup();
  }
});

test('a mid-file range returns that exact region', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'clip.mp4', Buffer.from(RANGE_BODY));
    const response = await app.inject({
      method: 'GET',
      url: `/media/${name}`,
      headers: { range: 'bytes=10-14' },
    });

    assert.equal(response.statusCode, 206);
    assert.equal(response.body, 'KLMNO');
    assert.equal(response.headers['content-range'], `bytes 10-14/${RANGE_BODY.length}`);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a suffix range returns the end of the file, not the beginning', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'clip.mp4', Buffer.from(RANGE_BODY));
    const response = await app.inject({
      method: 'GET',
      url: `/media/${name}`,
      headers: { range: 'bytes=-6' },
    });

    assert.equal(response.statusCode, 206);
    assert.equal(response.body, '456789');
  } finally {
    await app.close();
    cleanup();
  }
});

test('an unsatisfiable range is a 416 carrying the real size, so a client can correct itself', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'clip.mp4', Buffer.from(RANGE_BODY));
    const response = await app.inject({
      method: 'GET',
      url: `/media/${name}`,
      headers: { range: 'bytes=9999-' },
    });

    assert.equal(response.statusCode, 416);
    assert.equal(response.headers['content-range'], `bytes */${RANGE_BODY.length}`);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a multi-range request is answered with the whole file and a 200, never a malformed multipart body', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'clip.mp4', Buffer.from(RANGE_BODY));
    const response = await app.inject({
      method: 'GET',
      url: `/media/${name}`,
      headers: { range: 'bytes=0-4,10-14' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, RANGE_BODY);
  } finally {
    await app.close();
    cleanup();
  }
});

test('ranged responses still carry the cache and security headers the plain response does', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'clip.mp4', Buffer.from(RANGE_BODY));
    const response = await app.inject({
      method: 'GET',
      url: `/media/${name}`,
      headers: { range: 'bytes=0-1' },
    });

    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['access-control-allow-origin'], '*');
    assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
  } finally {
    await app.close();
    cleanup();
  }
});

test('an image still answers a range too - nothing here is video-specific', async () => {
  const { app, config, cleanup } = await buildMediaPublicTestServer();
  try {
    const { name } = await putMedia(config, 'photo.jpg', Buffer.from(RANGE_BODY));
    const response = await app.inject({
      method: 'GET',
      url: `/media/${name}`,
      headers: { range: 'bytes=0-3' },
    });

    assert.equal(response.statusCode, 206);
    assert.equal(response.body, 'ABCD');
  } finally {
    await app.close();
    cleanup();
  }
});
