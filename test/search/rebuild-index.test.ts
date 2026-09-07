import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { rebuildIndex } from '../../src/search/rebuild-index.ts';
import { queryIndex } from '../../src/search/query-index.ts';
import { queryFields } from '../../src/search/query-fields.ts';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

function page(options: {
  title: string;
  published?: boolean;
  heading?: string;
}): object {
  return {
    schemaVersion: 1,
    title: options.title,
    published: options.published ?? true,
    sections: [{ id: 'sec-1', type: 'hero', settings: { heading: options.heading ?? options.title } }],
  };
}

// Writes a real theme section file with an embedded {% schema %} block -
// same pattern test/services/theme-schemas.test.ts already uses - so
// rebuild-index.ts's own loadThemeSchemas() call has a real "api": true
// field to find.
function writeSectionSchema(siteRoot: string, type: string, schema: object): void {
  mkdirSync(join(siteRoot, 'theme', 'sections'), { recursive: true });
  writeFileSync(
    join(siteRoot, 'theme', 'sections', `${type}.liquid`),
    `<div></div>\n{% schema %}\n${JSON.stringify(schema)}\n{% endschema %}\n`,
  );
}

function writeBlockSchema(siteRoot: string, type: string, schema: object): void {
  mkdirSync(join(siteRoot, 'theme', 'blocks'), { recursive: true });
  writeFileSync(
    join(siteRoot, 'theme', 'blocks', `${type}.liquid`),
    `<div></div>\n{% schema %}\n${JSON.stringify(schema)}\n{% endschema %}\n`,
  );
}

test('G1: rebuild from a clean checkout produces an index; a basic FTS query returns the expected page for a known term', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/about.json', page({ title: 'About', heading: 'aardvarks' }));
    writeJson(siteRoot, 'content/pages/contact.json', page({ title: 'Contact', heading: 'zebras' }));
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    const results = queryIndex(config.searchIndexPath, 'aardvarks');
    assert.deepEqual(results, [{ url: '/about', title: 'About' }]);
  } finally {
    cleanup();
  }
});

test('G2: deleting the index file and rebuilding produces equivalent query results (disposability proven)', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/about.json', page({ title: 'About', heading: 'aardvarks' }));
    writeJson(siteRoot, 'content/pages/contact.json', page({ title: 'Contact', heading: 'zebras' }));
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);
    const first = queryIndex(config.searchIndexPath, 'aardvarks');

    unlinkSync(config.searchIndexPath);
    await rebuildIndex(config);
    const second = queryIndex(config.searchIndexPath, 'aardvarks');

    assert.deepEqual(first, second);
    assert.deepEqual(first, [{ url: '/about', title: 'About' }]);
  } finally {
    cleanup();
  }
});

test('G3: unpublished pages and drafts are absent from the index', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/live.json', page({ title: 'Live', heading: 'controlterm' }));
    writeJson(
      siteRoot,
      'content/pages/hidden.json',
      page({ title: 'Hidden', published: false, heading: 'unpublishedterm' }),
    );
    writeJson(siteRoot, 'content/drafts/pages/draft-only.json', page({ title: 'Draft', heading: 'draftonlyterm' }));
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.deepEqual(queryIndex(config.searchIndexPath, 'controlterm'), [{ url: '/live', title: 'Live' }]);
    assert.deepEqual(queryIndex(config.searchIndexPath, 'unpublishedterm'), []);
    assert.deepEqual(queryIndex(config.searchIndexPath, 'draftonlyterm'), []);
  } finally {
    cleanup();
  }
});

test('a published post is indexed under its /blog/<slug> URL, same as a page', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/posts/hello-world.json', {
      schemaVersion: 4,
      title: 'Hello World',
      type: 'post',
      layout: 'theme',
      published: true,
      author: 'Jane Editor',
      publishDate: '2026-07-27',
      tags: [],
      sections: [{ id: 'sec-1', type: 'hero', settings: { heading: 'postsearchterm' } }],
    });
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.deepEqual(queryIndex(config.searchIndexPath, 'postsearchterm'), [
      { url: '/blog/hello-world', title: 'Hello World' },
    ]);
  } finally {
    cleanup();
  }
});

test('an unpublished post is absent from the index, same as an unpublished page', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/posts/draft-post.json', {
      schemaVersion: 4,
      title: 'Draft Post',
      type: 'post',
      layout: 'theme',
      published: false,
      author: 'Jane Editor',
      publishDate: '2026-07-27',
      tags: [],
      sections: [{ id: 'sec-1', type: 'hero', settings: { heading: 'unpublishedpostterm' } }],
    });
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.deepEqual(queryIndex(config.searchIndexPath, 'unpublishedpostterm'), []);
  } finally {
    cleanup();
  }
});

test('a menu is never indexed - it has no public URL to point a search result at', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/menus/main.json', {
      schemaVersion: 1,
      items: [{ label: 'menuindexterm', url: '/menuindexterm' }],
    });
    writeJson(siteRoot, 'content/pages/about.json', page({ title: 'About', heading: 'controlterm2' }));
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.deepEqual(queryIndex(config.searchIndexPath, 'menuindexterm'), []);
    assert.deepEqual(queryIndex(config.searchIndexPath, 'controlterm2'), [{ url: '/about', title: 'About' }]);
  } finally {
    cleanup();
  }
});

test('a field flagged "api": true is indexed with its own typed value; a field without it is absent', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeSectionSchema(siteRoot, 'product', {
      type: 'object',
      properties: {
        price: { type: 'number', api: true },
        description: { type: 'string' },
      },
    });
    writeJson(siteRoot, 'content/pages/widget.json', {
      schemaVersion: 1,
      title: 'Widget',
      type: 'page',
      published: true,
      sections: [{ id: 'sec-1', type: 'product', settings: { price: 25, description: 'A fine widget' } }],
    });
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.deepEqual(queryFields(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '25' }), [
      { url: '/widget', title: 'Widget', pageType: 'page' },
    ]);
    // description has no "api": true - it's absent from page_fields
    // entirely, not just unqueried.
    assert.deepEqual(
      queryFields(config.searchIndexPath, { fieldKey: 'description', op: 'eq', value: 'A fine widget' }),
      [],
    );
  } finally {
    cleanup();
  }
});

test('a string field and a boolean field are each queryable by their own typed value', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeSectionSchema(siteRoot, 'product', {
      type: 'object',
      properties: {
        category: { type: 'string', api: true },
        inStock: { type: 'boolean', api: true },
      },
    });
    writeJson(siteRoot, 'content/pages/widget.json', {
      schemaVersion: 1,
      title: 'Widget',
      type: 'page',
      published: true,
      sections: [{ id: 'sec-1', type: 'product', settings: { category: 'tools', inStock: true } }],
    });
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.deepEqual(queryFields(config.searchIndexPath, { fieldKey: 'category', op: 'eq', value: 'tools' }), [
      { url: '/widget', title: 'Widget', pageType: 'page' },
    ]);
    assert.deepEqual(queryFields(config.searchIndexPath, { fieldKey: 'inStock', op: 'eq', value: 'true' }), [
      { url: '/widget', title: 'Widget', pageType: 'page' },
    ]);
    assert.deepEqual(queryFields(config.searchIndexPath, { fieldKey: 'inStock', op: 'eq', value: 'false' }), []);
  } finally {
    cleanup();
  }
});

test('an exposed field nested inside a block (not just a top-level section) is indexed, using the block schema map', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeSectionSchema(siteRoot, 'shelf', { type: 'object', properties: {} });
    writeBlockSchema(siteRoot, 'product-card', {
      type: 'object',
      properties: { price: { type: 'number', api: true } },
    });
    writeJson(siteRoot, 'content/pages/shelf.json', {
      schemaVersion: 1,
      title: 'Shelf',
      type: 'page',
      published: true,
      sections: [
        {
          id: 'sec-1',
          type: 'shelf',
          settings: {},
          blocks: [{ id: 'blk-1', type: 'product-card', settings: { price: 40 } }],
        },
      ],
    });
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.deepEqual(queryFields(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '40' }), [
      { url: '/shelf', title: 'Shelf', pageType: 'page' },
    ]);
  } finally {
    cleanup();
  }
});

test('multiple instances of the same exposed field on one page each keep their own independent value', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeSectionSchema(siteRoot, 'product', {
      type: 'object',
      properties: { price: { type: 'number', api: true } },
    });
    writeJson(siteRoot, 'content/pages/shop.json', {
      schemaVersion: 1,
      title: 'Shop',
      type: 'page',
      published: true,
      sections: [
        { id: 'sec-1', type: 'product', settings: { price: 10 } },
        { id: 'sec-2', type: 'product', settings: { price: 90 } },
      ],
    });
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.deepEqual(queryFields(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '10' }), [
      { url: '/shop', title: 'Shop', pageType: 'page' },
    ]);
    assert.deepEqual(queryFields(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '90' }), [
      { url: '/shop', title: 'Shop', pageType: 'page' },
    ]);
    assert.deepEqual(queryFields(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '50' }), []);
    // A numeric range only needs ONE instance to qualify - the page
    // still matches once (DISTINCT), it isn't returned twice for its
    // two matching-or-not instances.
    assert.deepEqual(queryFields(config.searchIndexPath, { fieldKey: 'price', op: 'lt', value: '50' }), [
      { url: '/shop', title: 'Shop', pageType: 'page' },
    ]);
  } finally {
    cleanup();
  }
});

test('an unpublished page produces no page_fields rows either, same as its full-text body', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeSectionSchema(siteRoot, 'product', {
      type: 'object',
      properties: { price: { type: 'number', api: true } },
    });
    writeJson(siteRoot, 'content/pages/hidden.json', {
      schemaVersion: 1,
      title: 'Hidden',
      type: 'page',
      published: false,
      sections: [{ id: 'sec-1', type: 'product', settings: { price: 10 } }],
    });
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.deepEqual(queryFields(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '10' }), []);
  } finally {
    cleanup();
  }
});

test('pageType filters a field query to just that page type', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeSectionSchema(siteRoot, 'product', {
      type: 'object',
      properties: { price: { type: 'number', api: true } },
    });
    writeJson(siteRoot, 'content/pages/widget.json', {
      schemaVersion: 1,
      title: 'Widget',
      type: 'page',
      published: true,
      sections: [{ id: 'sec-1', type: 'product', settings: { price: 15 } }],
    });
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
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    // Ordered by url ascending (queryFields' own ORDER BY) - /blog/...
    // sorts before /widget.
    assert.deepEqual(queryFields(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '15' }), [
      { url: '/blog/on-sale', title: 'On Sale', pageType: 'post' },
      { url: '/widget', title: 'Widget', pageType: 'page' },
    ]);
    assert.deepEqual(
      queryFields(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '15', pageType: 'post' }),
      [{ url: '/blog/on-sale', title: 'On Sale', pageType: 'post' }],
    );
  } finally {
    cleanup();
  }
});

test('G4: the index file is gitignored and a rebuild creates no git changes', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    // No site-scaffold-template with a real .gitignore exists yet
    // anywhere in this repo (that's Phase 2 scope), so this test seeds
    // a representative one itself, mirroring what the eventual scaffold
    // will ship.
    writeAndCommit(siteRoot, '.gitignore', 'data/\n');
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page({ title: 'About' })));
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.ok(existsSync(config.searchIndexPath));
    assert.ok(statSync(config.searchIndexPath).isFile());

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: siteRoot }).toString('utf-8').trim();
    assert.equal(status, '', 'a rebuild must create no git changes');
  } finally {
    cleanup();
  }
});
