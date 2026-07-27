import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/renderer/engine.ts';
import { PageRenderError, renderSections } from '../../src/renderer/render-page.ts';
import type { PageContent } from '../../src/renderer/render-page.ts';
import type { ThemeTemplates } from '../../src/renderer/theme-templates.ts';

function page(sections: PageContent['sections']): PageContent {
  return { schemaVersion: 1, title: 'Test page', published: true, sections };
}

// Proves the real renderInstance/renderSections pipeline (not just the
// raw engine) correctly threads the engine through and resolves a
// snippet call from inside a section template.
test('a section template can call a snippet via {% render %} and get real output', async () => {
  const themeTemplates: ThemeTemplates = {
    sections: {
      hero: `<h1>{{ section.settings.heading }}</h1>{% render 'byline', author: section.settings.author %}`,
    },
    blocks: {},
  };
  const engine = createEngine({ byline: '<span class="byline">By {{ author }}</span>' });

  const html = await renderSections(
    page([{ id: 'sec-1', type: 'hero', settings: { heading: 'Welcome', author: 'Jane' } }]),
    themeTemplates,
    engine,
  );

  assert.ok(html.includes('<span class="byline">By Jane</span>'));
});

test('a snippet does not see the calling template scope unless it is explicitly passed as an argument', async () => {
  const themeTemplates: ThemeTemplates = {
    sections: { hero: `{% render 'leaky' %}` },
    blocks: {},
  };
  const engine = createEngine({ leaky: '{{ section.settings.heading }}' });

  const html = await renderSections(
    page([{ id: 'sec-1', type: 'hero', settings: { heading: 'Should not leak' } }]),
    themeTemplates,
    engine,
  );

  assert.ok(!html.includes('Should not leak'));
});

test('a missing snippet surfaces as PageRenderError(template-error), not a crash or a different shape', async () => {
  const themeTemplates: ThemeTemplates = {
    sections: { hero: `{% render 'does-not-exist' %}` },
    blocks: {},
  };
  const engine = createEngine({});

  await assert.rejects(
    renderSections(page([{ id: 'sec-1', type: 'hero', settings: {} }]), themeTemplates, engine),
    (error: unknown) => error instanceof PageRenderError && error.reason === 'template-error',
  );
});
