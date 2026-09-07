import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

// GET /search.json is fully unauthenticated, but a rebuild still needs
// a real content-scoped token (POST /v1/search/rebuild, unchanged and
// still under /v1) - kept here so this file can seed the index for its
// own tests without depending on test/routes/search.test.ts.
const CONTENT_TOKEN = 'search-public-test-token';

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

function buildSearchPublicTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'vhost/site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, config: booted.config, cleanup };
}

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

async function rebuildViaRoute(app: ReturnType<typeof buildSearchPublicTestServer>['app']): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/search/rebuild',
    headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
  });
  assert.equal(response.statusCode, 200);
}

async function search(
  app: ReturnType<typeof buildSearchPublicTestServer>['app'],
  query: string,
): Promise<{ statusCode: number; body: unknown }> {
  // No Authorization header at all - the whole point of this route.
  const response = await app.inject({ method: 'GET', url: `/search.json${query}` });
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

test('GET /search.json with q does a full-text search and returns each result\'s page type', async () => {
  const { app, siteRoot, cleanup } = buildSearchPublicTestServer();
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

test('GET /search.json with no filter (field:value) op implies "eq"', async () => {
  const { app, siteRoot, cleanup } = buildSearchPublicTestServer();
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

test('GET /search.json ANDs multiple filter params together - a product grid filtering by category and price', async () => {
  const { app, siteRoot, cleanup } = buildSearchPublicTestServer();
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

test('GET /search.json sort=-price and sort=price order a numeric field descending/ascending', async () => {
  const { app, siteRoot, cleanup } = buildSearchPublicTestServer();
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

test('GET /search.json sort=-publishDate orders pages newest first, for a paginated blog listing - author/publishDate/tags are optional page fields, not a distinct post type', async () => {
  const { app, siteRoot, cleanup } = buildSearchPublicTestServer();
  try {
    function blogArticle(slug: string, title: string, publishDate: string): object {
      return {
        schemaVersion: 6,
        name: title,
        title,
        type: 'blog-article',
        layout: 'theme',
        published: true,
        author: 'Jane Editor',
        publishDate,
        tags: [],
        sections: [],
      };
    }
    writeJson(siteRoot, 'content/pages/blog/old.json', blogArticle('old', 'Old Post', '2024-01-01'));
    writeJson(siteRoot, 'content/pages/blog/new.json', blogArticle('new', 'New Post', '2026-01-01'));
    writeJson(siteRoot, 'content/pages/blog/middle.json', blogArticle('middle', 'Middle Post', '2025-01-01'));
    await rebuildViaRoute(app);

    const { statusCode, body } = await search(app, '?pageType=blog-article&sort=-publishDate');
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

test('GET /search.json paginates with limit/offset and reports hasMore', async () => {
  const { app, siteRoot, cleanup } = buildSearchPublicTestServer();
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

test('GET /search.json with an invalid filter (no colon) is rejected with 400', async () => {
  const { app, cleanup } = buildSearchPublicTestServer();
  try {
    const { statusCode } = await search(app, '?filter=notafilter');
    assert.equal(statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /search.json with a non-numeric value and a numeric op is rejected with 400', async () => {
  const { app, cleanup } = buildSearchPublicTestServer();
  try {
    const { statusCode } = await search(app, '?filter=price:lt:cheap');
    assert.equal(statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /search.json with a syntax-breaking q (stray quote, trailing operator) never 500s', async () => {
  const { app, siteRoot, cleanup } = buildSearchPublicTestServer();
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

// Deliberately the opposite of every other route in this file: GET
// /search.json is read-only and only ever surfaces already-published
// data, so a front-end can call it directly with no token at all (see
// routes/search-public.ts's own comment on this route for the full
// reasoning) - a bearer token embedded in public client-side JS
// wouldn't actually be a secret anyway. Rebuilds via the still-
// authenticated /v1/search/rebuild, then queries with zero auth
// header, proving the endpoint works end to end for exactly that use
// case, not just that it doesn't 401.
test('GET /search.json works with no Authorization header at all - the whole point of this route', async () => {
  const { app, siteRoot, cleanup } = buildSearchPublicTestServer();
  try {
    writeJson(siteRoot, 'content/pages/about.json', page('About', 'aardvarks'));
    await app.inject({
      method: 'POST',
      url: '/v1/search/rebuild',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    const response = await app.inject({ method: 'GET', url: '/search.json?q=aardvarks' });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { results: Array<{ url: string; title: string }> };
    assert.deepEqual(body.results, [{ url: '/about', title: 'About', pageType: 'page', fields: {} }]);
  } finally {
    await app.close();
    cleanup();
  }
});

// /search itself stays free for a site's own content page (the whole
// reason this endpoint is /search.json, not /search) - proven by
// confirming a plain GET /search with no matching page 404s through
// the ordinary public page-lookup pipeline, not this route.
test('GET /search (no .json) is not this route - it falls through to ordinary page lookup', async () => {
  const { app, cleanup } = buildSearchPublicTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/search' });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});
