import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { writeJson } from '../helpers/tmp-site.ts';

const FIXTURE_SITE = join(import.meta.dirname, '..', 'fixtures', 'site');
const CONTENT_TOKEN = 'preview-test-content-token';

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Same cpSync-a-real-fixture pattern as public.test.ts, plus a
// configured content-scoped token: preview is gated with
// requireScope(tokens, 'content') (a read-only render of draft
// content a content-scoped token can already read raw via
// GET /v1/drafts/:path - no separate "preview" scope exists).
function buildPreviewTestServer() {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-preview-test-'));
  cpSync(FIXTURE_SITE, siteRoot, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: siteRoot });
  writeJson(siteRoot, 'site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup: () => rmSync(siteRoot, { recursive: true, force: true }) };
}

test('C5: previewing a page that only exists as a draft renders the draft', async () => {
  const { app, siteRoot, cleanup } = buildPreviewTestServer();
  try {
    writeJson(siteRoot, 'drafts/pages/draft-only-page.json', {
      schemaVersion: 1,
      title: 'Draft Only',
      published: true,
      sections: [{ id: 'sec-1', type: 'hero', settings: { heading: 'Draft only heading' } }],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/preview/draft-only-page',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('Draft only heading'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('C5: previewing a page with a draft overlays the draft over the live version', async () => {
  const { app, siteRoot, cleanup } = buildPreviewTestServer();
  try {
    writeJson(siteRoot, 'drafts/pages/about.json', {
      schemaVersion: 1,
      title: 'About',
      published: true,
      sections: [{ id: 'sec-hero', type: 'hero', settings: { heading: 'Draft version of About' } }],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/preview/about',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('Draft version of About'));
    assert.ok(!response.body.includes('About Us'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('C5: previewing a page with no draft falls back to the live version', async () => {
  const { app, cleanup } = buildPreviewTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/preview/about',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('About Us'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('a preview request with no token is rejected with 401', async () => {
  const { app, cleanup } = buildPreviewTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/preview/about' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

test('C6: a path traversal attempt against the preview route fails safely, never a 500 or leaked content', async () => {
  const { app, cleanup } = buildPreviewTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/preview/..%2f..%2f..%2fetc%2fpasswd',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.ok(
      response.statusCode === 400 || response.statusCode === 404,
      `expected 400 or 404, got ${response.statusCode}`,
    );
    assert.ok(!response.body.includes('root:'));
  } finally {
    await app.close();
    cleanup();
  }
});
