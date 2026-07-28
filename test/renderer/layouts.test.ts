import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/renderer/engine.ts';
import { PageRenderError, renderPage } from '../../src/renderer/render-page.ts';
import type { ThemeTemplates } from '../../src/renderer/theme-templates.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';
import { loadSiteConfig } from '../../src/config.ts';

const themeTemplates: ThemeTemplates = {
  sections: { hero: '<h1>{{ section.settings.heading }}</h1>' },
  blocks: {},
};
const layouts = { theme: '<html><body class="wrapped">{{ content_for_layout | raw }}</body></html>' };
const engine = createEngine({});

function page(fields: Record<string, unknown>): object {
  return {
    schemaVersion: 4,
    title: 'Test page',
    type: 'page',
    published: true,
    sections: [{ id: 'sec-1', type: 'hero', settings: { heading: 'Welcome' } }],
    ...fields,
  };
}

test('a rendered page is wrapped in its named layout, with the body content correctly unescaped', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeJson(siteRoot, 'content/about.json', page({ layout: 'theme' }));

    const html = await renderPage(config, themeTemplates, layouts, engine, 'about.json', 'public');

    assert.match(html, /<body class="wrapped">/);
    assert.ok(html.includes('<h1>Welcome</h1>'), 'body content must appear as real markup, not escaped text');
    assert.ok(!html.includes('&lt;h1&gt;'), 'body content must not be double-escaped');
  } finally {
    cleanup();
  }
});

test('a layout can read live menus, threaded into scope as `menus`', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeJson(siteRoot, 'content/about.json', page({ layout: 'nav' }));
    writeJson(siteRoot, 'content/menus/main.json', {
      schemaVersion: 1,
      items: [{ label: 'Home', url: '/' }, { label: 'About', url: '/about' }],
    });

    const layoutsWithNav = {
      ...layouts,
      nav: '<nav>{% for item in menus.main.items %}<a href="{{ item.url }}">{{ item.label }}</a>{% endfor %}</nav>{{ content_for_layout | raw }}',
    };

    const html = await renderPage(config, themeTemplates, layoutsWithNav, engine, 'about.json', 'public');

    assert.ok(html.includes('<a href="/">Home</a>'));
    assert.ok(html.includes('<a href="/about">About</a>'));
  } finally {
    cleanup();
  }
});

test('a layout referencing a menu that does not exist gets an empty/undefined value, not a crash', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeJson(siteRoot, 'content/about.json', page({ layout: 'nav' }));

    const layoutsWithNav = {
      ...layouts,
      nav: '<nav>{% for item in menus.main.items %}<a href="{{ item.url }}">{{ item.label }}</a>{% endfor %}</nav>{{ content_for_layout | raw }}',
    };

    const html = await renderPage(config, themeTemplates, layoutsWithNav, engine, 'about.json', 'public');
    assert.match(html, /<nav><\/nav>/);
  } finally {
    cleanup();
  }
});

test('preview mode overlays a draft menu over its live counterpart, matching the page draft-overlay precedent', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeJson(siteRoot, 'content/about.json', page({ layout: 'nav' }));
    writeJson(siteRoot, 'content/menus/main.json', { schemaVersion: 1, items: [{ label: 'Live', url: '/live' }] });
    writeJson(siteRoot, 'content/drafts/menus/main.json', { schemaVersion: 1, items: [{ label: 'Draft', url: '/draft' }] });

    const layoutsWithNav = {
      ...layouts,
      nav: '<nav>{% for item in menus.main.items %}<a href="{{ item.url }}">{{ item.label }}</a>{% endfor %}</nav>{{ content_for_layout | raw }}',
    };

    const previewHtml = await renderPage(config, themeTemplates, layoutsWithNav, engine, 'about.json', 'preview');
    assert.ok(previewHtml.includes('>Draft<'));
    assert.ok(!previewHtml.includes('>Live<'));

    const publicHtml = await renderPage(config, themeTemplates, layoutsWithNav, engine, 'about.json', 'public');
    assert.ok(publicHtml.includes('>Live<'));
    assert.ok(!publicHtml.includes('>Draft<'));
  } finally {
    cleanup();
  }
});

test('a page whose layout name does not exist in the theme throws PageRenderError(missing-layout)', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    writeJson(siteRoot, 'content/about.json', page({ layout: 'does-not-exist' }));

    await assert.rejects(
      renderPage(config, themeTemplates, layouts, engine, 'about.json', 'public'),
      (error: unknown) => error instanceof PageRenderError && error.reason === 'missing-layout',
    );
  } finally {
    cleanup();
  }
});

test('a page missing the layout field entirely (pre-existing content that predates this field) still renders, defaulting to "theme"', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    // A real schemaVersion-1-shaped fixture, matching what boot.ts's
    // never-auto-migrate design guarantees can persist indefinitely -
    // no "type", no "layout", nothing this session's schema additions
    // introduced. Not a hypothetical: test/fixtures/site/content/pages/
    // about.json is exactly this shape today.
    writeJson(siteRoot, 'content/about.json', {
      schemaVersion: 1,
      title: 'Legacy Page',
      published: true,
      sections: [{ id: 'sec-1', type: 'hero', settings: { heading: 'Welcome' } }],
    });

    const html = await renderPage(config, themeTemplates, layouts, engine, 'about.json', 'public');

    assert.match(html, /<body class="wrapped">/);
    assert.ok(html.includes('<h1>Welcome</h1>'));
  } finally {
    cleanup();
  }
});
