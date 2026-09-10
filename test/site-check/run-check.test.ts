import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSiteCheck } from '../../src/site-check/run-check.ts';
import { createTmpSiteRoot, writeAndCommit } from '../helpers/tmp-site.ts';

function page(overrides: Record<string, unknown> = {}): object {
  return {
    schemaVersion: 6,
    name: 'Page',
    title: 'Page',
    type: 'page',
    layout: 'theme',
    published: true,
    sections: [],
    ...overrides,
  };
}

// A minimal real theme, shared by every test below - a plain layout
// (content_for_layout only, no menus needed) is enough to boot and
// render against, without dragging in a real section type unless a
// specific test needs one.
function seedMinimalTheme(siteRoot: string, layoutBody: string): void {
  mkdirSync(join(siteRoot, 'theme', 'layouts'), { recursive: true });
  writeFileSync(join(siteRoot, 'theme', 'layouts', 'theme.liquid'), layoutBody);
}

test('a clean site (no broken references, no schema problems) produces zero findings', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    seedMinimalTheme(siteRoot, '<html><body>{{ content_for_layout | raw }}</body></html>');
    writeAndCommit(siteRoot, 'content/pages/index.json', JSON.stringify(page()));

    const result = await runSiteCheck(siteRoot);

    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
  } finally {
    cleanup();
  }
});

test('a rendered reference to a /media/ file that does not exist on disk is a missing-asset finding', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    seedMinimalTheme(siteRoot, '<html><body><img src="/media/does-not-exist.jpg"></body></html>');
    writeAndCommit(siteRoot, 'content/pages/index.json', JSON.stringify(page()));

    const result = await runSiteCheck(siteRoot);

    assert.equal(result.ok, false);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.kind, 'missing-asset');
    assert.match(result.findings[0]?.message ?? '', /\/media\/does-not-exist\.jpg/);
    assert.equal(result.findings[0]?.pageUrl, '/');
  } finally {
    cleanup();
  }
});

test('a real /media/ file that does exist produces no finding for it', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    seedMinimalTheme(siteRoot, '<html><body><img src="/media/real.jpg"></body></html>');
    mkdirSync(join(siteRoot, 'media'), { recursive: true });
    writeFileSync(join(siteRoot, 'media', 'real.jpg'), 'x');
    writeAndCommit(siteRoot, 'content/pages/index.json', JSON.stringify(page()));

    const result = await runSiteCheck(siteRoot);

    assert.equal(result.ok, true);
  } finally {
    cleanup();
  }
});

test('a srcset entry is parsed as several urls, each checked independently', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    seedMinimalTheme(
      siteRoot,
      '<html><body><img srcset="/media/a.jpg 480w, /media/missing.jpg 960w"></body></html>',
    );
    mkdirSync(join(siteRoot, 'media'), { recursive: true });
    writeFileSync(join(siteRoot, 'media', 'a.jpg'), 'x');
    writeAndCommit(siteRoot, 'content/pages/index.json', JSON.stringify(page()));

    const result = await runSiteCheck(siteRoot);

    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0]?.message ?? '', /\/media\/missing\.jpg/);
  } finally {
    cleanup();
  }
});

test('an <a href> to a page that was never published is a broken-link finding', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    seedMinimalTheme(siteRoot, '<html><body><a href="/nowhere">Nowhere</a>{{ content_for_layout | raw }}</body></html>');
    writeAndCommit(siteRoot, 'content/pages/index.json', JSON.stringify(page()));

    const result = await runSiteCheck(siteRoot);

    assert.equal(result.ok, false);
    assert.equal(result.findings[0]?.kind, 'broken-link');
    assert.match(result.findings[0]?.message ?? '', /\/nowhere/);
  } finally {
    cleanup();
  }
});

test('an <a href> to another real, published page produces no finding', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    seedMinimalTheme(siteRoot, '<html><body><a href="/about">About</a>{{ content_for_layout | raw }}</body></html>');
    writeAndCommit(siteRoot, 'content/pages/index.json', JSON.stringify(page()));
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page({ name: 'About', title: 'About' })));

    const result = await runSiteCheck(siteRoot);

    assert.equal(result.ok, true);
  } finally {
    cleanup();
  }
});

test('a theme schema problem surfaces as a schema finding, not tied to any page', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    seedMinimalTheme(siteRoot, '<html><body>{{ content_for_layout | raw }}</body></html>');
    mkdirSync(join(siteRoot, 'theme', 'sections'), { recursive: true });
    writeFileSync(
      join(siteRoot, 'theme', 'sections', 'no-default.liquid'),
      '<h1>{{ section.settings.heading }}</h1>\n{% schema %}\n{"type":"object","required":["heading"],"properties":{"heading":{"type":"string","minLength":1}}}\n{% endschema %}\n',
    );
    writeAndCommit(siteRoot, 'content/pages/index.json', JSON.stringify(page()));

    const result = await runSiteCheck(siteRoot);

    assert.equal(result.ok, false);
    const schemaFindings = result.findings.filter((f) => f.kind === 'schema');
    assert.equal(schemaFindings.length, 1);
    assert.equal(schemaFindings[0]?.pageUrl, undefined);
    assert.match(schemaFindings[0]?.message ?? '', /no-default/);
  } finally {
    cleanup();
  }
});

test('a page that fails to render is a render-error finding, and does not stop the rest of the check', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    seedMinimalTheme(siteRoot, '<html><body>{{ content_for_layout | raw }}</body></html>');
    writeAndCommit(
      siteRoot,
      'content/pages/broken.json',
      JSON.stringify(page({ name: 'Broken', title: 'Broken', sections: [{ id: 'sec-1', type: 'does-not-exist', settings: {} }] })),
    );
    writeAndCommit(siteRoot, 'content/pages/index.json', JSON.stringify(page()));

    const result = await runSiteCheck(siteRoot);

    assert.equal(result.ok, false);
    const renderErrors = result.findings.filter((f) => f.kind === 'render-error');
    assert.equal(renderErrors.length, 1);
    assert.equal(renderErrors[0]?.pageUrl, '/broken');
  } finally {
    cleanup();
  }
});
