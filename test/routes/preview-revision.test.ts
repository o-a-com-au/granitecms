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
import { writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

const FIXTURE_SITE = join(import.meta.dirname, '..', 'fixtures', 'site');
const CONTENT_TOKEN = 'preview-revision-test-content-token';

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Same cpSync-a-real-fixture pattern as preview.test.ts, but with real
// commits layered on top via writeAndCommit - this route's whole job is
// rendering a specific historical revision, so (unlike preview.test.ts)
// tests here need real git history, not just an uncommitted working tree.
function buildPreviewRevisionTestServer() {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-preview-revision-test-'));
  cpSync(FIXTURE_SITE, siteRoot, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: siteRoot });
  writeJson(siteRoot, 'vhost/site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup: () => rmSync(siteRoot, { recursive: true, force: true }) };
}

function pageWithHeading(heading: string): object {
  return {
    schemaVersion: 1,
    title: 'About',
    published: true,
    sections: [{ id: 'sec-hero', type: 'hero', settings: { heading } }],
  };
}

test('renders a page always at the requested revision, regardless of current draft/live content', async () => {
  const { app, siteRoot, cleanup } = buildPreviewRevisionTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(pageWithHeading('Version A')), 'v1');
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot }).toString('utf-8').trim();
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(pageWithHeading('Version B')), 'v2');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/preview-revision/${hash}/about`,
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('Version A'));
    assert.ok(!response.body.includes('Version B'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('returns 400 for an invalid ref', async () => {
  const { app, siteRoot, cleanup } = buildPreviewRevisionTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(pageWithHeading('Version A')), 'v1');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/preview-revision/not-a-real-ref/about',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('returns 404 for a page that never existed at a valid ref', async () => {
  const { app, siteRoot, cleanup } = buildPreviewRevisionTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(pageWithHeading('Version A')), 'v1');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/preview-revision/HEAD/never-existed',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt fails safely, never a 500 or leaked content', async () => {
  const { app, siteRoot, cleanup } = buildPreviewRevisionTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(pageWithHeading('Version A')), 'v1');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/preview-revision/HEAD/..%2f..%2f..%2fetc%2fpasswd',
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

test('returns 422 when the revision references a section type absent from the current theme', async () => {
  const { app, siteRoot, cleanup } = buildPreviewRevisionTestServer();
  try {
    const extinctPage = {
      schemaVersion: 1,
      title: 'About',
      published: true,
      sections: [{ id: 'sec-extinct', type: 'no-longer-in-theme', settings: {} }],
    };
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(extinctPage), 'extinct section type');
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot }).toString('utf-8').trim();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/preview-revision/${hash}/about`,
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 422);
    const body = JSON.parse(response.body) as { reason: string };
    assert.equal(body.reason, 'missing-section-type');
  } finally {
    await app.close();
    cleanup();
  }
});

test('renders a post revision at /v1/preview-revision/:ref/blog/<slug>', async () => {
  const { app, siteRoot, cleanup } = buildPreviewRevisionTestServer();
  try {
    const post = {
      schemaVersion: 4,
      title: 'Hello World',
      type: 'post',
      layout: 'theme',
      published: true,
      author: 'Jane Editor',
      publishDate: '2026-07-27',
      tags: [],
      sections: [{ id: 'sec-1', type: 'hero', settings: { heading: 'Historical post heading' } }],
    };
    writeAndCommit(siteRoot, 'content/posts/hello-world.json', JSON.stringify(post), 'add post revision');
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot }).toString('utf-8').trim();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/preview-revision/${hash}/blog/hello-world`,
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('Historical post heading'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('a request with no token is rejected with 401', async () => {
  const { app, siteRoot, cleanup } = buildPreviewRevisionTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(pageWithHeading('Version A')), 'v1');

    const response = await app.inject({ method: 'GET', url: '/v1/preview-revision/HEAD/about' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});
