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
