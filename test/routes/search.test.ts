import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

function writeProductSectionSchema(siteRoot: string): void {
  mkdirSync(join(siteRoot, 'theme', 'sections'), { recursive: true });
  writeFileSync(
    join(siteRoot, 'theme', 'sections', 'product.liquid'),
    '<div></div>\n{% schema %}\n{"type":"object","properties":{"price":{"type":"number","api":true},"category":{"type":"string","api":true}}}\n{% endschema %}\n',
  );
}

function productPage(title: string, price: number, category: string): object {
  return {
    schemaVersion: 4,
    title,
    type: 'page',
    layout: 'theme',
    published: true,
    sections: [{ id: 'sec-1', type: 'product', settings: { price, category } }],
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

async function search(
  app: ReturnType<typeof buildSearchTestServer>['app'],
  query: string,
): Promise<{ statusCode: number; body: unknown }> {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/search${query}`,
    headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
  });
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

test('GET /v1/search with q does a full-text search and returns each result\'s page type', async () => {
  const { app, siteRoot, cleanup } = buildSearchTestServer();
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('About', 'trail running shoe'));
    writeJson(siteRoot, 'content/pages/contact.json', page('Contact', 'get in touch'));
    await rebuildViaRoute(app);

    const { statusCode, body } = await search(app, '?q=trail');
    assert.equal(statusCode, 200);
    assert.deepEqual(body, {
      results: [{ url: '/about', title: 'About', pageType: 'page', fields: {} }],
      limit: 20,
      offset: 0,
      hasMore: false,
    });
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search with no filter (field:value) op implies "eq"', async () => {
  const { app, siteRoot, cleanup } = buildSearchTestServer();
  try {
    writeProductSectionSchema(siteRoot);
    writeJson(siteRoot, 'content/pages/widget.json', productPage('Widget', 25, 'tools'));
    await rebuildViaRoute(app);

    const { statusCode, body } = await search(app, '?filter=category:tools');
    assert.equal(statusCode, 200);
    assert.deepEqual((body as { results: unknown[] }).results, [
      { url: '/widget', title: 'Widget', pageType: 'page', fields: { price: 25, category: 'tools' } },
    ]);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search ANDs multiple filter params together - a product grid filtering by category and price', async () => {
  const { app, siteRoot, cleanup } = buildSearchTestServer();
  try {
    writeProductSectionSchema(siteRoot);
    writeJson(siteRoot, 'content/pages/cheap-shoe.json', productPage('Cheap Shoe', 40, 'shoes'));
    writeJson(siteRoot, 'content/pages/pricey-shoe.json', productPage('Pricey Shoe', 200, 'shoes'));
    writeJson(siteRoot, 'content/pages/cheap-hat.json', productPage('Cheap Hat', 20, 'hats'));
    await rebuildViaRoute(app);

    const { statusCode, body } = await search(app, '?filter=category:eq:shoes&filter=price:lt:100');
    assert.equal(statusCode, 200);
    assert.deepEqual((body as { results: Array<{ url: string }> }).results.map((r) => r.url), ['/cheap-shoe']);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search sort=-price and sort=price order a numeric field descending/ascending', async () => {
  const { app, siteRoot, cleanup } = buildSearchTestServer();
  try {
    writeProductSectionSchema(siteRoot);
    writeJson(siteRoot, 'content/pages/a.json', productPage('A', 30, 'shoes'));
    writeJson(siteRoot, 'content/pages/b.json', productPage('B', 10, 'shoes'));
    writeJson(siteRoot, 'content/pages/c.json', productPage('C', 20, 'shoes'));
    await rebuildViaRoute(app);

    const asc = await search(app, '?filter=category:shoes&sort=price');
    assert.deepEqual((asc.body as { results: Array<{ url: string }> }).results.map((r) => r.url), [
      '/b',
      '/c',
      '/a',
    ]);

    const desc = await search(app, '?filter=category:shoes&sort=-price');
    assert.deepEqual((desc.body as { results: Array<{ url: string }> }).results.map((r) => r.url), [
      '/a',
      '/c',
      '/b',
    ]);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search sort=-publishDate orders posts newest first, for a paginated blog listing', async () => {
  const { app, siteRoot, cleanup } = buildSearchTestServer();
  try {
    function post(slug: string, title: string, publishDate: string): object {
      return {
        schemaVersion: 4,
        title,
        type: 'post',
        layout: 'theme',
        published: true,
        author: 'Jane Editor',
        publishDate,
        tags: [],
        sections: [],
      };
    }
    writeJson(siteRoot, 'content/posts/old.json', post('old', 'Old Post', '2024-01-01'));
    writeJson(siteRoot, 'content/posts/new.json', post('new', 'New Post', '2026-01-01'));
    writeJson(siteRoot, 'content/posts/middle.json', post('middle', 'Middle Post', '2025-01-01'));
    await rebuildViaRoute(app);

    const { statusCode, body } = await search(app, '?pageType=post&sort=-publishDate');
    assert.equal(statusCode, 200);
    assert.deepEqual((body as { results: Array<{ url: string }> }).results.map((r) => r.url), [
      '/blog/new',
      '/blog/middle',
      '/blog/old',
    ]);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search paginates with limit/offset and reports hasMore', async () => {
  const { app, siteRoot, cleanup } = buildSearchTestServer();
  try {
    writeProductSectionSchema(siteRoot);
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      writeJson(siteRoot, `content/pages/${name}.json`, productPage(name, 10, 'shoes'));
    }
    await rebuildViaRoute(app);

    const first = await search(app, '?filter=category:shoes&sort=price&limit=2&offset=0');
    assert.deepEqual((first.body as { hasMore: boolean }).hasMore, true);
    assert.equal((first.body as { results: unknown[] }).results.length, 2);

    const last = await search(app, '?filter=category:shoes&sort=price&limit=2&offset=4');
    assert.deepEqual((last.body as { hasMore: boolean }).hasMore, false);
    assert.equal((last.body as { results: unknown[] }).results.length, 1);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search with an invalid filter (no colon) is rejected with 400', async () => {
  const { app, cleanup } = buildSearchTestServer();
  try {
    const { statusCode } = await search(app, '?filter=notafilter');
    assert.equal(statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search with a non-numeric value and a numeric op is rejected with 400', async () => {
  const { app, cleanup } = buildSearchTestServer();
  try {
    const { statusCode } = await search(app, '?filter=price:lt:cheap');
    assert.equal(statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search with a syntax-breaking q (stray quote, trailing operator) never 500s', async () => {
  const { app, siteRoot, cleanup } = buildSearchTestServer();
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('About', 'hello world'));
    await rebuildViaRoute(app);

    for (const q of ['"unbalanced', 'trailing-', 'AND OR NOT', '""""']) {
      const { statusCode } = await search(app, `?q=${encodeURIComponent(q)}`);
      assert.equal(statusCode, 200, `q=${q} should not error`);
    }
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/search with no token is rejected with 401', async () => {
  const { app, cleanup } = buildSearchTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=hello' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});
