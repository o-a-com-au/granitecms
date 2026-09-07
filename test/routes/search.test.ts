import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootSite } from '../../src/boot.ts';
import { queryContent } from '../../src/search/query-content.ts';
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
  writeJson(siteRoot, 'vhost/site.config.json', {
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
    const { results } = queryContent(config.searchIndexPath, { q: 'aardvarks', filters: [], limit: 20, offset: 0 });
    assert.deepEqual(results, [{ url: '/about', title: 'About', pageType: 'page', fields: {} }]);
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

test('POST /v1/search/rebuild yields to the event loop even through the real HTTP route, not just a direct rebuildIndex() call', async () => {
  const { app, siteRoot, cleanup } = buildSearchTestServer();
  try {
    // 60 pages guarantees the loop crosses YIELD_EVERY_N_FILES (25, see
    // rebuild-index.ts) at least twice.
    for (let i = 0; i < 60; i += 1) {
      writeJson(siteRoot, `content/pages/page-${i}.json`, page(`Page ${i}`, `heading ${i}`));
    }

    const marks: string[] = [];
    const rebuildPromise = app
      .inject({ method: 'POST', url: '/v1/search/rebuild', headers: { authorization: `Bearer ${CONTENT_TOKEN}` } })
      .then((response) => {
        marks.push('rebuild-done');
        return response;
      });
    // Same reasoning as rebuild-index.test.ts's own equivalent case -
    // scheduled via the real, global setImmediate before awaiting the
    // rebuild, so on a fully synchronous rebuild none of these could
    // ever fire first. Proves the yield survives being invoked through
    // the actual route handler, not just a direct rebuildIndex() call.
    const immediates = Array.from(
      { length: 5 },
      (_, index) =>
        new Promise<void>((resolve) => {
          setImmediate(() => {
            marks.push(`immediate-${index}`);
            resolve();
          });
        }),
    );

    const [rebuildResponse] = await Promise.all([rebuildPromise, ...immediates]);
    assert.equal(rebuildResponse.statusCode, 200);

    const doneIndex = marks.indexOf('rebuild-done');
    const earlyImmediates = marks.slice(0, doneIndex).filter((mark) => mark.startsWith('immediate-'));
    assert.ok(
      earlyImmediates.length > 0,
      `expected at least one setImmediate to fire before the HTTP rebuild request finished, got: ${marks.join(', ')}`,
    );
  } finally {
    await app.close();
    cleanup();
  }
});
