import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootSite } from '../../src/boot.ts';
import { queryIndex } from '../../src/search/query-index.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

const CONTENT_TOKEN = 'search-test-token';

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function page(title: string, heading: string): object {
  return {
    schemaVersion: 4,
    title,
    type: 'page',
    layout: 'theme',
    published: true,
    sections: [{ id: 'sec-1', type: 'hero', settings: { heading } }],
  };
}

function buildSearchTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, config: booted.config, cleanup };
}

test('H1: POST /v1/search/rebuild rebuilds the index and returns success', async () => {
  const { app, siteRoot, config, cleanup } = buildSearchTestServer();
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('About', 'aardvarks'));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/search/rebuild',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true });
    assert.deepEqual(queryIndex(config.searchIndexPath, 'aardvarks'), [{ url: '/about', title: 'About' }]);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/search/rebuild with no token is rejected with 401', async () => {
  const { app, cleanup } = buildSearchTestServer();
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/search/rebuild' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});
