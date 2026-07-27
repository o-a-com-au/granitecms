import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { createEngine } from '../../src/renderer/engine.ts';
import { PageRenderError, renderPage, renderSections } from '../../src/renderer/render-page.ts';
import { loadThemeTemplates } from '../../src/renderer/theme-templates.ts';
import type { PageContent } from '../../src/renderer/render-page.ts';
import type { ThemeTemplates } from '../../src/renderer/theme-templates.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');
const themeTemplates = loadThemeTemplates(join(fixturesDir, 'theme'));
const engine = createEngine({});
const layouts = { theme: '{{ content_for_layout | raw }}' };

function page(sections: PageContent['sections'], published = true): PageContent {
  return { schemaVersion: 1, title: 'Test page', published, layout: 'theme', sections };
}

test('D1: a page JSON plus theme renders to HTML with sections in declared order', async () => {
  const html = await renderSections(
    page([
      { id: 'sec-1', type: 'hero', settings: { heading: 'First' } },
      { id: 'sec-2', type: 'hero', settings: { heading: 'Second' } },
    ]),
    themeTemplates,
    engine,
  );

  assert.ok(html.includes('First'));
  assert.ok(html.includes('Second'));
  assert.ok(html.indexOf('First') < html.indexOf('Second'), 'sections must render in declared order');
});

test('D2: block settings render inside their parent section', async () => {
  const html = await renderSections(
    page([
      {
        id: 'sec-1',
        type: 'hero',
        settings: { heading: 'Welcome' },
        blocks: [{ id: 'blk-1', type: 'button', settings: { label: 'Learn more', url: '/about' } }],
      },
    ]),
    themeTemplates,
    engine,
  );

  const sectionStart = html.indexOf('data-section-id="sec-1"');
  const sectionEnd = html.indexOf('</section>');
  const blockIndex = html.indexOf('data-block-id="blk-1"');

  assert.ok(sectionStart !== -1 && blockIndex !== -1);
  assert.ok(
    blockIndex > sectionStart && blockIndex < sectionEnd,
    'block markup must appear inside its parent section markup',
  );
  assert.ok(html.includes('Learn more'));
  assert.ok(html.includes('href="/about"'));
});

test('D2: a block nested inside another block (blocks-within-blocks) renders correctly', async () => {
  const html = await renderSections(
    page([
      {
        id: 'sec-1',
        type: 'hero',
        settings: { heading: 'Welcome' },
        blocks: [
          {
            id: 'blk-group',
            type: 'group',
            settings: {},
            blocks: [{ id: 'blk-button', type: 'button', settings: { label: 'Nested', url: '/nested' } }],
          },
        ],
      },
    ]),
    themeTemplates,
    engine,
  );

  const groupStart = html.indexOf('data-block-id="blk-group"');
  const buttonIndex = html.indexOf('data-block-id="blk-button"');
  assert.ok(groupStart !== -1 && buttonIndex !== -1);
  assert.ok(buttonIndex > groupStart, 'the nested block must render inside its parent block');
  assert.ok(html.includes('Nested'));
});

test('D3: text settings containing HTML are escaped in output by default', async () => {
  const html = await renderSections(
    page([{ id: 'sec-1', type: 'hero', settings: { heading: '<script>alert(1)</script>' } }]),
    themeTemplates,
    engine,
  );

  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw HTML must not appear unescaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('D4: a template that loops forever is killed by the render timeout and returns an error, not a hung process', async () => {
  // engine.ts sets renderLimit: 50 (ms). A huge finite for-loop, run
  // through the real renderSections/renderInstance path (no {% render %}
  // self-include, no templates-map trickery), proves the mechanism:
  // stock Liquid has no {% while %}, so this is the faithful stand-in
  // for "loops forever" without needing the include machinery this
  // renderer deliberately avoids.
  //
  // 5,000,000 iterations specifically, not 999,999,999: empirically, a
  // range that large hits an unrelated LiquidJS "Invalid array length"
  // internal error rather than the render limit, which would make this
  // test pass for the wrong reason. 5,000,000 reliably trips
  // renderLimit itself (confirmed: LiquidJS throws RenderError
  // "template render limit exceeded" around 50-70ms for this range).
  const runawayThemeTemplates: ThemeTemplates = {
    sections: { runaway: '{% for i in (1..5000000) %}{% endfor %}' },
    blocks: {},
  };

  const start = Date.now();
  await assert.rejects(
    renderSections(page([{ id: 'sec-1', type: 'runaway', settings: {} }]), runawayThemeTemplates, engine),
    PageRenderError,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 50 * 10, `render must be killed near the configured limit, took ${elapsed}ms`);
});

test('D7: rendering a page whose section type is missing from the theme produces a clear error identifying the section, not a crash', async () => {
  await assert.rejects(
    renderSections(page([{ id: 'sec-missing', type: 'does-not-exist', settings: {} }]), themeTemplates, engine),
    (error: unknown) => {
      assert.ok(error instanceof PageRenderError);
      assert.equal(error.reason, 'missing-section-type');
      assert.match(error.message, /does-not-exist/);
      assert.match(error.message, /sec-missing/);
      return true;
    },
  );
});

test('D7: rendering a section whose block type is missing from the theme produces a clear error identifying the block, not a crash', async () => {
  await assert.rejects(
    renderSections(
      page([
        {
          id: 'sec-1',
          type: 'hero',
          settings: { heading: 'Welcome' },
          blocks: [{ id: 'blk-missing', type: 'does-not-exist', settings: {} }],
        },
      ]),
      themeTemplates,
      engine,
    ),
    (error: unknown) => {
      assert.ok(error instanceof PageRenderError);
      assert.equal(error.reason, 'missing-block-type');
      assert.match(error.message, /does-not-exist/);
      assert.match(error.message, /blk-missing/);
      return true;
    },
  );
});

test('D5: public mode renders /content/ only; a page existing only as a draft is not publicly reachable', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeJson(
      siteRoot,
      'drafts/about.json',
      page([{ id: 'sec-1', type: 'hero', settings: { heading: 'Draft only' } }]),
    );

    await assert.rejects(
      renderPage(config, themeTemplates, layouts, engine, 'about.json', 'public'),
      (error: unknown) => error instanceof PageRenderError && error.reason === 'page-not-found',
    );
  } finally {
    cleanup();
  }
});

test('D5/C8: public mode treats an unpublished live page (published: false) as not found, closing out the renderer half of unpublish', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeJson(
      siteRoot,
      'content/about.json',
      page([{ id: 'sec-1', type: 'hero', settings: { heading: 'Unpublished' } }], false),
    );

    await assert.rejects(
      renderPage(config, themeTemplates, layouts, engine, 'about.json', 'public'),
      (error: unknown) => error instanceof PageRenderError && error.reason === 'page-not-found',
    );
  } finally {
    cleanup();
  }
});

test('public mode renders a real published live page', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeJson(
      siteRoot,
      'content/about.json',
      page([{ id: 'sec-1', type: 'hero', settings: { heading: 'Live and published' } }]),
    );

    const html = await renderPage(config, themeTemplates, layouts, engine, 'about.json', 'public');
    assert.ok(html.includes('Live and published'));
  } finally {
    cleanup();
  }
});

test('D6: preview mode renders the draft version when a draft exists', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeJson(
      siteRoot,
      'content/about.json',
      page([{ id: 'sec-1', type: 'hero', settings: { heading: 'Live version' } }]),
    );
    writeJson(
      siteRoot,
      'drafts/about.json',
      page([{ id: 'sec-1', type: 'hero', settings: { heading: 'Draft version' } }]),
    );

    const html = await renderPage(config, themeTemplates, layouts, engine, 'about.json', 'preview');
    assert.ok(html.includes('Draft version'));
    assert.ok(!html.includes('Live version'));
  } finally {
    cleanup();
  }
});

test('D6: preview mode falls back to live when no draft exists', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeJson(
      siteRoot,
      'content/about.json',
      page([{ id: 'sec-1', type: 'hero', settings: { heading: 'Live version' } }]),
    );

    const html = await renderPage(config, themeTemplates, layouts, engine, 'about.json', 'preview');
    assert.ok(html.includes('Live version'));
  } finally {
    cleanup();
  }
});
