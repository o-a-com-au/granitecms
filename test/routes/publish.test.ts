import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

const CONTENT_TOKEN = 'publish-test-token';
const author = { name: 'Jane Editor', email: 'jane@example.com' };

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function page(title: string, type = 'page', published = true): object {
  return { schemaVersion: 4, name: title, title, type, layout: 'theme', published, sections: [] };
}

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

function buildPublishTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'vhost/site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup };
}

test('F1: POST /v1/publish promotes a draft to live and creates one commit', async () => {
  const { app, siteRoot, cleanup } = buildPublishTestServer();
  try {
    const config = bootSite(siteRoot).config;
    writeAndCommit(siteRoot, 'README.md', 'seed');
    writeJson(siteRoot, 'content/drafts/pages/about.json', page('About'));
    const before = commitCount(siteRoot);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { paths: ['pages/about.json'], message: 'publish about', author },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(existsSync(join(config.pagesRoot, 'about.json')));
    assert.equal(existsSync(join(config.draftsRoot, 'pages', 'about.json')), false);
    assert.equal(commitCount(siteRoot), before + 1);
  } finally {
    await app.close();
    cleanup();
  }
});

test('F1: POST /v1/publish rejects a malformed body with 400', async () => {
  const { app, cleanup } = buildPublishTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { paths: [], message: 'x', author },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('F1: POST /v1/publish rejects an author with a control character', async () => {
  const { app, siteRoot, cleanup } = buildPublishTestServer();
  try {
    writeJson(siteRoot, 'content/drafts/pages/about.json', page('About'));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { paths: ['pages/about.json'], message: 'x', author: { name: 'Jane\nEvil', email: 'j@example.com' } },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('F1: POST /v1/publish returns 404 when a draft does not exist', async () => {
  const { app, cleanup } = buildPublishTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { paths: ['pages/never-existed.json'], message: 'x', author },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/publish with no token is rejected with 401', async () => {
  const { app, cleanup } = buildPublishTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      headers: { 'content-type': 'application/json' },
      payload: { paths: ['pages/about.json'], message: 'x', author },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

test('F2: POST /v1/unpublish/:path sets published:false and commits', async () => {
  const { app, siteRoot, cleanup } = buildPublishTestServer();
  try {
    const config = bootSite(siteRoot).config;
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About')));
    const before = commitCount(siteRoot);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/unpublish/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: 'unpublish about', author },
    });

    assert.equal(response.statusCode, 200);
    const updated = JSON.parse(readFileSync(join(config.pagesRoot, 'about.json'), 'utf-8')) as {
      published: boolean;
    };
    assert.equal(updated.published, false);
    assert.equal(commitCount(siteRoot), before + 1);
  } finally {
    await app.close();
    cleanup();
  }
});

test('F2: POST /v1/unpublish/:path returns 404 for a nonexistent page', async () => {
  const { app, cleanup } = buildPublishTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/unpublish/pages/never-existed.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: 'x', author },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('F2: POST /v1/unpublish/:path rejects a malformed body with 400', async () => {
  const { app, siteRoot, cleanup } = buildPublishTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About')));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/unpublish/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: '' },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt against POST /v1/unpublish/:path fails safely, never a 500', async () => {
  const { app, cleanup } = buildPublishTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/unpublish/..%2f..%2f..%2fetc%2fpasswd',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: 'x', author },
    });
    assert.ok(response.statusCode === 400 || response.statusCode === 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/unpublish/:path with no token is rejected with 401', async () => {
  const { app, cleanup } = buildPublishTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/unpublish/pages/about.json',
      headers: { 'content-type': 'application/json' },
      payload: { message: 'x', author },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});
