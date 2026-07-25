import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { renderSections } from '../../src/renderer/render-page.ts';
import { loadThemeTemplates } from '../../src/renderer/theme-templates.ts';
import type { PageContent } from '../../src/renderer/render-page.ts';

const fixturesDir = join(import.meta.dirname, '..', 'fixtures');
const themeTemplates = loadThemeTemplates(join(fixturesDir, 'theme'));

function page(sections: PageContent['sections']): PageContent {
  return { schemaVersion: 1, title: 'Test page', published: true, sections };
}

test('D1: a page JSON plus theme renders to HTML with sections in declared order', async () => {
  const html = await renderSections(
    page([
      { id: 'sec-1', type: 'hero', settings: { heading: 'First' } },
      { id: 'sec-2', type: 'hero', settings: { heading: 'Second' } },
    ]),
    themeTemplates,
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
  );

  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw HTML must not appear unescaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});
