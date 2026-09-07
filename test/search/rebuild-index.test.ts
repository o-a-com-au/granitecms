import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { rebuildIndex } from '../../src/search/rebuild-index.ts';
import { queryContent, type FieldOp } from '../../src/search/query-content.ts';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

// Thin wrappers over queryContent (query-content.ts), matching the
// shape the now-retired queryIndex/queryFields each had - keeps every
// existing call site below unchanged in shape, since queryContent
// itself now covers what both of them did (and more; its own fuller
// response shape - filters/sort/pagination/fields - gets its own
// dedicated coverage in test/routes/search.test.ts instead).
function searchText(searchIndexPath: string, q: string): Array<{ url: string; title: string }> {
  return queryContent(searchIndexPath, { q, filters: [], limit: 100, offset: 0 }).results.map(({ url, title }) => ({
    url,
    title,
  }));
}

function searchField(
  searchIndexPath: string,
  params: { fieldKey: string; op: FieldOp; value: string; pageType?: string },
): Array<{ url: string; title: string; pageType: string }> {
  return queryContent(searchIndexPath, {
    filters: [{ field: params.fieldKey, op: params.op, value: params.value }],
    pageType: params.pageType,
    limit: 100,
    offset: 0,
  }).results.map(({ url, title, pageType }) => ({ url, title, pageType }));
}

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

    const results = searchText(config.searchIndexPath, 'aardvarks');
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
    const first = searchText(config.searchIndexPath, 'aardvarks');

    unlinkSync(config.searchIndexPath);
    await rebuildIndex(config);
    const second = searchText(config.searchIndexPath, 'aardvarks');

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

    assert.deepEqual(searchText(config.searchIndexPath, 'controlterm'), [{ url: '/live', title: 'Live' }]);
    assert.deepEqual(searchText(config.searchIndexPath, 'unpublishedterm'), []);
    assert.deepEqual(searchText(config.searchIndexPath, 'draftonlyterm'), []);
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

    assert.deepEqual(searchText(config.searchIndexPath, 'postsearchterm'), [
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

    assert.deepEqual(searchText(config.searchIndexPath, 'unpublishedpostterm'), []);
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

    assert.deepEqual(searchText(config.searchIndexPath, 'menuindexterm'), []);
    assert.deepEqual(searchText(config.searchIndexPath, 'controlterm2'), [{ url: '/about', title: 'About' }]);
  } finally {
    cleanup();
  }
});

test('a rebuild swaps the index atomically via a temp file + rename - no leftover temp file, and a second rebuild fully replaces rather than merges', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/about.json', page({ title: 'About', heading: 'aardvarks' }));
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);
    assert.deepEqual(searchText(config.searchIndexPath, 'aardvarks'), [{ url: '/about', title: 'About' }]);

    // A genuinely different second page, not just an edit of the first -
    // proves the real index file is a full replacement of the previous
    // build's contents, not an accumulation on top of it.
    writeJson(siteRoot, 'content/pages/about.json', page({ title: 'About', heading: 'bumblebees' }));
    await rebuildIndex(config);

    assert.deepEqual(searchText(config.searchIndexPath, 'aardvarks'), []);
    assert.deepEqual(searchText(config.searchIndexPath, 'bumblebees'), [{ url: '/about', title: 'About' }]);

    // rebuildIndexJob's own temp file (searchIndexPath + '.tmp-<uuid>')
    // is renamed over the real path on success, not left sitting
    // alongside it - a stray one accumulating on every rebuild would be
    // a real, silent disk leak on a long-running site.
    const leftoverTmpFiles = readdirSync(config.dataRoot).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftoverTmpFiles, []);
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

    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '25' }), [
      { url: '/widget', title: 'Widget', pageType: 'page' },
    ]);
    // description has no "api": true - it's absent from page_fields
    // entirely, not just unqueried.
    assert.deepEqual(
      searchField(config.searchIndexPath, { fieldKey: 'description', op: 'eq', value: 'A fine widget' }),
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

    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'category', op: 'eq', value: 'tools' }), [
      { url: '/widget', title: 'Widget', pageType: 'page' },
    ]);
    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'inStock', op: 'eq', value: 'true' }), [
      { url: '/widget', title: 'Widget', pageType: 'page' },
    ]);
    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'inStock', op: 'eq', value: 'false' }), []);
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

    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '40' }), [
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

    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '10' }), [
      { url: '/shop', title: 'Shop', pageType: 'page' },
    ]);
    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '90' }), [
      { url: '/shop', title: 'Shop', pageType: 'page' },
    ]);
    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '50' }), []);
    // A numeric range only needs ONE instance to qualify - the page
    // still matches once (DISTINCT), it isn't returned twice for its
    // two matching-or-not instances.
    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'price', op: 'lt', value: '50' }), [
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

    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '10' }), []);
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
    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '15' }), [
      { url: '/blog/on-sale', title: 'On Sale', pageType: 'post' },
      { url: '/widget', title: 'Widget', pageType: 'page' },
    ]);
    assert.deepEqual(
      searchField(config.searchIndexPath, { fieldKey: 'price', op: 'eq', value: '15', pageType: 'post' }),
      [{ url: '/blog/on-sale', title: 'On Sale', pageType: 'post' }],
    );
  } finally {
    cleanup();
  }
});

test('a post\'s built-in author/publishDate/tags fields are auto-indexed, no "api": true needed', async () => {
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
      tags: ['design', 'launch'],
      sections: [],
    });
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'author', op: 'eq', value: 'Jane Editor' }), [
      { url: '/blog/hello-world', title: 'Hello World', pageType: 'post' },
    ]);
    // Each tag is independently matchable - a query for either tag
    // finds the same post, proving the array expanded into separate
    // rows rather than being indexed as one opaque blob.
    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'tags', op: 'eq', value: 'design' }), [
      { url: '/blog/hello-world', title: 'Hello World', pageType: 'post' },
    ]);
    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'tags', op: 'eq', value: 'launch' }), [
      { url: '/blog/hello-world', title: 'Hello World', pageType: 'post' },
    ]);
    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'tags', op: 'eq', value: 'unrelated' }), []);
  } finally {
    cleanup();
  }
});

test('publishDate is indexed as a numeric epoch value, so range operators can query it like any other numeric field', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/posts/old-post.json', {
      schemaVersion: 4,
      title: 'Old Post',
      type: 'post',
      layout: 'theme',
      published: true,
      author: 'Jane Editor',
      publishDate: '2020-01-01',
      tags: [],
      sections: [],
    });
    writeJson(siteRoot, 'content/posts/new-post.json', {
      schemaVersion: 4,
      title: 'New Post',
      type: 'post',
      layout: 'theme',
      published: true,
      author: 'Jane Editor',
      publishDate: '2026-01-01',
      tags: [],
      sections: [],
    });
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    const cutoff = Date.parse('2023-01-01').toString();
    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'publishDate', op: 'gt', value: cutoff }), [
      { url: '/blog/new-post', title: 'New Post', pageType: 'post' },
    ]);
    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'publishDate', op: 'lt', value: cutoff }), [
      { url: '/blog/old-post', title: 'Old Post', pageType: 'post' },
    ]);
  } finally {
    cleanup();
  }
});

test('a page (not a post) has no author/publishDate/tags rows - envelope auto-indexing only ever applies to posts', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeJson(siteRoot, 'content/pages/about.json', page({ title: 'About' }));
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'author', op: 'eq', value: 'anyone' }), []);
  } finally {
    cleanup();
  }
});

test('a theme field schema\'d "type": "string", "format": "date" is also indexed as a numeric epoch value, same as publishDate', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    writeSectionSchema(siteRoot, 'event', {
      type: 'object',
      properties: { startsOn: { type: 'string', format: 'date', api: true } },
    });
    writeJson(siteRoot, 'content/pages/conference.json', {
      schemaVersion: 1,
      title: 'Conference',
      type: 'page',
      published: true,
      sections: [{ id: 'sec-1', type: 'event', settings: { startsOn: '2026-09-10' } }],
    });
    const config = loadSiteConfig(siteRoot);

    await rebuildIndex(config);

    const epoch = Date.parse('2026-09-10').toString();
    assert.deepEqual(searchField(config.searchIndexPath, { fieldKey: 'startsOn', op: 'eq', value: epoch }), [
      { url: '/conference', title: 'Conference', pageType: 'page' },
    ]);
  } finally {
    cleanup();
  }
});

test('a rebuild yields periodically to the event loop rather than blocking it for its entire duration', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    // 60 files guarantees the loop crosses YIELD_EVERY_N_FILES (25) at
    // least twice - real, not a single lucky yield.
    for (let i = 0; i < 60; i += 1) {
      writeJson(siteRoot, `content/pages/page-${i}.json`, page({ title: `Page ${i}` }));
    }
    const config = loadSiteConfig(siteRoot);

    const marks: string[] = [];
    const rebuildPromise = rebuildIndex(config).then(() => {
      marks.push('rebuild-done');
    });
    // Scheduled via the real, global setImmediate BEFORE awaiting the
    // rebuild - a fully synchronous rebuild runs its entire body to
    // completion within one microtask turn (see write-queue.ts's own
    // enqueue()), so on the old code NONE of these could ever fire
    // before 'rebuild-done' was already recorded: Node only reaches
    // queued macrotask (setImmediate) callbacks once every already-
    // pending microtask has drained. At least one firing beforehand is
    // direct, deterministic proof the rebuild actually yielded control
    // mid-flight, not a timing-dependent race.
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

    await Promise.all([rebuildPromise, ...immediates]);

    const doneIndex = marks.indexOf('rebuild-done');
    const earlyImmediates = marks.slice(0, doneIndex).filter((mark) => mark.startsWith('immediate-'));
    assert.ok(
      earlyImmediates.length > 0,
      `expected at least one setImmediate to fire before the rebuild finished, got: ${marks.join(', ')}`,
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
