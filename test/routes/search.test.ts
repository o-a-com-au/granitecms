import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

function writeProductSectionSchema(siteRoot: string): void {
  mkdirSync(join(siteRoot, 'theme', 'sections'), { recursive: true });
  writeFileSync(
    join(siteRoot, 'theme', 'sections', 'product.liquid'),
    '<div></div>\n{% schema %}\n{"type":"object","properties":{"price":{"type":"number","api":true}}}\n{% endschema %}\n',
  );
}

function productPage(title: string, price: number): object {
  return {
    schemaVersion: 4,
    title,
    type: 'page',
    layout: 'theme',
    published: true,
    sections: [{ id: 'sec-1', type: 'product', settings: { price } }],
  };
}

async function rebuildViaRoute(app: ReturnType<typeof buildSearchTestServer>['app']): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/search/rebuild',
    headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
  });
  assert.equal(response.statusCode, 200);
}

test('GET /v1/search/fields with no op defaults to exact match', async () => {
  const { app, siteRoot, cleanup } = buildSearchTestServer();
  try {
    writeProductSectionSchema(siteRoot);
    writeJson(siteRoot, 'content/pages/widget.json', productPage('Widget', 25));
    await rebuildViaRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/search/fields?field=price&value=25',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), [{ url: '/widget', title: 'Widget', pageType: 'page' }]);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search/fields supports gt/gte/lt/lte for a numeric field', async () => {
  const { app, siteRoot, cleanup } = buildSearchTestServer();
  try {
    writeProductSectionSchema(siteRoot);
    writeJson(siteRoot, 'content/pages/cheap.json', productPage('Cheap', 10));
    writeJson(siteRoot, 'content/pages/pricey.json', productPage('Pricey', 90));
    await rebuildViaRoute(app);

    async function urlsFor(op: string, value: string): Promise<string[]> {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/search/fields?field=price&op=${op}&value=${value}`,
        headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
      });
      assert.equal(response.statusCode, 200);
      return (JSON.parse(response.body) as Array<{ url: string }>).map((entry) => entry.url);
    }

    assert.deepEqual(await urlsFor('lt', '50'), ['/cheap']);
    assert.deepEqual(await urlsFor('lte', '10'), ['/cheap']);
    assert.deepEqual(await urlsFor('gt', '50'), ['/pricey']);
    assert.deepEqual(await urlsFor('gte', '90'), ['/pricey']);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search/fields with pageType filters to just that page type', async () => {
  const { app, siteRoot, cleanup } = buildSearchTestServer();
  try {
    writeProductSectionSchema(siteRoot);
    writeJson(siteRoot, 'content/pages/widget.json', productPage('Widget', 15));
    writeJson(siteRoot, 'content/posts/on-sale.json', {
      schemaVersion: 4,
      title: 'On Sale',
      type: 'post',
      layout: 'theme',
      published: true,
      author: 'Jane Editor',
      publishDate: '2026-07-27',
      tags: [],
      sections: [{ id: 'sec-1', type: 'product', settings: { price: 15 } }],
    });
    await rebuildViaRoute(app);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/search/fields?field=price&value=15&pageType=post',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), [{ url: '/blog/on-sale', title: 'On Sale', pageType: 'post' }]);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search/fields with a missing field or value is rejected with 400', async () => {
  const { app, cleanup } = buildSearchTestServer();
  try {
    const noField = await app.inject({
      method: 'GET',
      url: '/v1/search/fields?value=25',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(noField.statusCode, 400);

    const noValue = await app.inject({
      method: 'GET',
      url: '/v1/search/fields?field=price',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(noValue.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search/fields with an unknown op is rejected with 400', async () => {
  const { app, cleanup } = buildSearchTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/search/fields?field=price&op=contains&value=25',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search/fields with a non-numeric value and a numeric op is rejected with 400', async () => {
  const { app, cleanup } = buildSearchTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/search/fields?field=price&op=lt&value=cheap',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search/fields with no token is rejected with 401', async () => {
  const { app, cleanup } = buildSearchTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/search/fields?field=price&value=25' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});
