import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

// beforeBoot runs after the site root exists but before bootSite() -
// theme layouts (unlike ordinary page content) are read once at boot,
// so a test needing a working layout must write it there, not after.
function buildAdminRedirectTestServer(adminBaseUrl?: string, beforeBoot?: (siteRoot: string) => void) {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  if (adminBaseUrl !== undefined) {
    writeJson(siteRoot, 'vhost/site.config.json', { adminBaseUrl });
  }
  beforeBoot?.(siteRoot);

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup };
}

test('GET /admin redirects to adminBaseUrl with ?site=<host>, no Authorization header needed', async () => {
  const { app, cleanup } = buildAdminRedirectTestServer('https://admin.example.com');
  try {
    const response = await app.inject({ method: 'GET', url: '/admin', headers: { host: 'mysite.example.test' } });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, 'https://admin.example.com/?site=mysite.example.test');
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /admin reflects the requesting host, port included', async () => {
  const { app, cleanup } = buildAdminRedirectTestServer('https://admin.example.com');
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { host: 'mysite.example.test:4000' },
    });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, 'https://admin.example.com/?site=mysite.example.test%3A4000');
  } finally {
    await app.close();
    cleanup();
  }
});

// The whole point of adminBaseUrl being opt-in (server.ts only ever
// registers this route when it's configured): a site that never set
// it can still use "admin" as an ordinary page path, proven here by a
// real page there rendering normally instead of redirecting anywhere.
test('with no adminBaseUrl configured, GET /admin is not this route at all - a real page there renders normally', async () => {
  const { app, cleanup } = buildAdminRedirectTestServer(undefined, (siteRoot) => {
    mkdirSync(join(siteRoot, 'theme', 'layouts'), { recursive: true });
    writeFileSync(join(siteRoot, 'theme', 'layouts', 'theme.liquid'), '{{ content_for_layout | raw }}');
    writeJson(siteRoot, 'content/pages/admin.json', {
      schemaVersion: 6,
      name: 'Admin',
      title: 'Admin',
      type: 'page',
      layout: 'theme',
      published: true,
      sections: [],
    });
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/admin' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  } finally {
    await app.close();
    cleanup();
  }
});

test('with no adminBaseUrl configured and no real page at /admin either, it 404s like any other missing page', async () => {
  const { app, cleanup } = buildAdminRedirectTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/admin' });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});
