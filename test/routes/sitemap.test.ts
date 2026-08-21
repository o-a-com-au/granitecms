import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { writeJson } from '../helpers/tmp-site.ts';

const FIXTURE_SITE = join(import.meta.dirname, '..', 'fixtures', 'site');

// Same real-fixture-site pattern as public.test.ts/assets.test.ts -
// the fixture already has a realistic mix (published pages/posts, an
// unpublished page "hidden.json", a nested child page, a 404.json)
// that this route's filtering logic needs to be exercised against.
function buildSitemapTestServer(options: { trustProxy?: boolean } = {}) {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-sitemap-test-'));
  cpSync(FIXTURE_SITE, siteRoot, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: siteRoot });
  if (options.trustProxy) {
    writeJson(siteRoot, 'vhost/site.config.json', { trustProxy: true });
  }

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup: () => rmSync(siteRoot, { recursive: true, force: true }) };
}

test('GET /sitemap.xml returns valid XML with the correct content-type', async () => {
  const { app, cleanup } = buildSitemapTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/sitemap.xml' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/xml; charset=utf-8');
    assert.match(response.body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(response.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  } finally {
    await app.close();
    cleanup();
  }
});

test('includes published pages (root, nested child, and posts) as absolute URLs', async () => {
  const { app, cleanup } = buildSitemapTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/sitemap.xml' });
    // .inject()'s default Host header is "localhost:80" - the port is
    // deliberately expected here too (request.host, not
    // request.hostname, is what this route uses - see its own
    // comment for why the port must never be silently dropped).
    assert.match(response.body, /<loc>http:\/\/localhost:80\/<\/loc>/);
    assert.match(response.body, /<loc>http:\/\/localhost:80\/about<\/loc>/);
    assert.match(response.body, /<loc>http:\/\/localhost:80\/about\/team<\/loc>/);
    assert.match(response.body, /<loc>http:\/\/localhost:80\/blog\/hello-world<\/loc>/);
  } finally {
    await app.close();
    cleanup();
  }
});

test('excludes an unpublished page', async () => {
  const { app, cleanup } = buildSitemapTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/sitemap.xml' });
    assert.doesNotMatch(response.body, /\/hidden</);
  } finally {
    await app.close();
    cleanup();
  }
});

test('excludes 404.json even though it is published - it is a fallback convention, never a real crawlable URL', async () => {
  const { app, cleanup } = buildSitemapTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/sitemap.xml' });
    assert.doesNotMatch(response.body, /\/404</);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a page that exists only as a draft (never published live) is not listed', async () => {
  const { app, cleanup } = buildSitemapTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/sitemap.xml' });
    assert.doesNotMatch(response.body, /draft-only/);
  } finally {
    await app.close();
    cleanup();
  }
});

test('the absolute URL scheme and host reflect the real request, respecting trustProxy when enabled', async () => {
  const { app, cleanup } = buildSitemapTestServer({ trustProxy: true });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/sitemap.xml',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.test' },
    });
    assert.match(response.body, /<loc>https:\/\/example\.test\//);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a non-standard port in the Host header is preserved, never silently dropped', async () => {
  const { app, cleanup } = buildSitemapTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/sitemap.xml', headers: { host: 'example.test:4000' } });
    assert.match(response.body, /<loc>http:\/\/example\.test:4000\//);
  } finally {
    await app.close();
    cleanup();
  }
});
