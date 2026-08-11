import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

const CONTENT_TOKEN = 'batch-test-token';
const author = { name: 'Jane Editor', email: 'jane@example.com' };
const NO_PRIOR_FILE_ETAG = 'no-prior-file';

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function page(title: string, published = true): object {
  return { schemaVersion: 4, name: title, title, type: 'page', layout: 'theme', published, sections: [] };
}

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

function buildBatchTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'vhost/site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup };
}

test('POST /v1/batch runs a mixed set of operations plus a trailing publish as one commit', async () => {
  const { app, siteRoot, cleanup } = buildBatchTestServer();
  try {
    const config = bootSite(siteRoot).config;
    writeAndCommit(siteRoot, 'content/pages/old-name.json', JSON.stringify(page('Old Name')));
    const before = commitCount(siteRoot);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: {
        operations: [
          { type: 'draft-write', path: 'pages/new-page.json', content: page('New Page'), expectedEtag: NO_PRIOR_FILE_ETAG },
          { type: 'move', from: '/old-name', to: '/new-name' },
        ],
        publish: { paths: ['pages/new-page.json'] },
        message: 'bulk batch via route',
        author,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(existsSync(join(config.pagesRoot, 'new-page.json')));
    assert.ok(existsSync(join(config.pagesRoot, 'new-name.json')));
    assert.equal(commitCount(siteRoot), before + 1);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/batch rejects a malformed body with 400', async () => {
  const { app, cleanup } = buildBatchTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { operations: [{ type: 'not-a-real-type' }], message: 'x', author },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/batch rejects a body missing operations entirely with 400', async () => {
  const { app, cleanup } = buildBatchTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: 'x', author },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/batch maps a content-delete has-children failure to 409', async () => {
  const { app, siteRoot, cleanup } = buildBatchTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/parent.json', JSON.stringify(page('Parent')));
    writeAndCommit(siteRoot, 'content/pages/parent/child.json', JSON.stringify(page('Child')));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: {
        operations: [{ type: 'content-delete', path: 'pages/parent.json' }],
        message: 'x',
        author,
      },
    });
    assert.equal(response.statusCode, 409);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/batch maps a move destination-exists failure to 409', async () => {
  const { app, siteRoot, cleanup } = buildBatchTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/source.json', JSON.stringify(page('Source')));
    writeAndCommit(siteRoot, 'content/pages/taken.json', JSON.stringify(page('Taken')));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: {
        operations: [{ type: 'move', from: '/source', to: '/taken' }],
        message: 'x',
        author,
      },
    });
    assert.equal(response.statusCode, 409);
  } finally {
    await app.close();
    cleanup();
  }
});

test("POST /v1/batch maps the trailing publish step's own draft-not-found failure to 404", async () => {
  const { app, cleanup } = buildBatchTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: {
        operations: [],
        publish: { paths: ['pages/never-existed.json'] },
        message: 'x',
        author,
      },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt inside a batch operation fails safely, never a 500', async () => {
  const { app, cleanup } = buildBatchTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: {
        operations: [{ type: 'content-delete', path: '../../../etc/passwd' }],
        message: 'x',
        author,
      },
    });
    assert.ok(response.statusCode === 400 || response.statusCode === 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/batch with no token is rejected with 401', async () => {
  const { app, cleanup } = buildBatchTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { 'content-type': 'application/json' },
      payload: { operations: [], message: 'x', author },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});
