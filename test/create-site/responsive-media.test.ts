import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldSite } from '../../src/create-site/generate-site.ts';
import { bootSite } from '../../src/boot.ts';
import { renderPage } from '../../src/renderer/render-page.ts';

// The scaffold's responsive-media snippet, rendered for real rather than
// inspected as source. What matters here is what actually reaches the HTML:
// the admin's drag-and-drop finds a drop target purely by looking for
// data-cms-image/data-cms-media in the rendered page, so a snippet that
// stops emitting them breaks image replacement across every site built from
// this scaffold, and breaks it silently - the page still renders perfectly,
// images simply stop being droppable. That is exactly how it went unnoticed
// in a real generated site. Nothing short of rendering catches it.

interface Scaffolded {
  dir: string;
  cleanup: () => void;
}

function scaffold(): Scaffolded {
  const parent = mkdtempSync(join(tmpdir(), 'responsive-media-test-'));
  const dir = join(parent, 'site');
  scaffoldSite(dir);
  return { dir, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

interface ScaffoldSection {
  type: string;
  settings: Record<string, unknown>;
}

// Patches the home page's own hero/cta-banner instances in place, so the
// test exercises the scaffold's real sections rather than a hand-written
// stand-in that could drift from them.
function patchHomePage(dir: string, patch: (section: ScaffoldSection) => void): void {
  const file = join(dir, 'content', 'pages', 'index.json');
  const page = JSON.parse(readFileSync(file, 'utf-8')) as { sections?: ScaffoldSection[] };
  for (const section of page.sections ?? []) {
    patch(section);
  }
  writeFileSync(file, JSON.stringify(page, null, 2));
}

async function renderHome(dir: string): Promise<string> {
  const booted = bootSite(dir);
  assert.deepEqual(booted.themeSchemas.warnings ?? [], [], 'no theme component may be excluded at boot');
  return renderPage(booted.config, booted.themeTemplates, booted.layouts, booted.engine, 'pages/index.json', 'public');
}

test('an image setting renders as a drag-and-drop target naming its own field', async () => {
  const { dir, cleanup } = scaffold();
  try {
    patchHomePage(dir, (section) => {
      if (section.type === 'hero') {
        section.settings.image = { url: '/media/photo-abc123def456.jpg', focalX: 0.25, focalY: 0.75 };
      }
    });

    const html = await renderHome(dir);

    // data-cms-image is what today's admin queries; data-cms-media/-kind is
    // the wider contract that also covers video.
    assert.match(html, /data-cms-image="image"/);
    assert.match(html, /data-cms-media="image"/);
    assert.match(html, /data-cms-media-kind="image"/);
    // The stored focal point must survive into the rendered markup, or a
    // cropped image silently ignores the crop an editor set.
    assert.match(html, /object-position: 25% 75%/);
  } finally {
    cleanup();
  }
});

test('a video setting renders as a drop target but never claims to be an image', async () => {
  const { dir, cleanup } = scaffold();
  try {
    patchHomePage(dir, (section) => {
      if (section.type === 'cta-banner') {
        section.settings.backgroundLoop = {
          url: '/media/loop-abc123def456.mp4',
          poster: '/media/still-abc123def456.jpg',
        };
      }
    });

    const html = await renderHome(dir);

    assert.match(html, /data-cms-media="backgroundLoop"/);
    assert.match(html, /data-cms-media-kind="video"/);
    assert.match(html, /<video/);
    assert.match(html, /poster="\/media\/still-abc123def456\.jpg"/);

    // The safety property. An admin that predates video support understands
    // only data-cms-image, and would write an image-shaped value
    // ({url, focalX, focalY}) straight over this field's own {url, poster}.
    // Emitting it here would corrupt the setting rather than degrade.
    assert.equal(/data-cms-image=/.test(html), false, 'a video slot must never emit data-cms-image');
  } finally {
    cleanup();
  }
});

test('a section with no image set renders no drop target at all', async () => {
  const { dir, cleanup } = scaffold();
  try {
    // The scaffold's default content sets no image on the hero, so this is
    // the out-of-the-box state.
    const html = await renderHome(dir);

    // Decided directly: an unset image is not a drop spot in the viewport.
    // A theme cannot tell the admin preview from the public site, so an
    // editor-only placeholder would show to real visitors.
    assert.equal(/data-cms-media=/.test(html), false);
    assert.equal(/data-cms-image=/.test(html), false);
    // Positive control: the page really did render, so the assertions above
    // are not passing simply because nothing was produced.
    assert.match(html, /<section class="hero"/);
  } finally {
    cleanup();
  }
});

test('the scaffold ships the snippet every generated site is told to use', async () => {
  const { dir, cleanup } = scaffold();
  try {
    const snippet = readFileSync(join(dir, 'theme', 'snippets', 'responsive-media.liquid'), 'utf-8');
    // A generated site that has the documentation but not the snippet would
    // leave an agent inventing its own image markup, which is how the
    // contract got missed in the first place.
    assert.match(snippet, /data-cms-media/);
    assert.match(snippet, /Do not add a srcset here/);
  } finally {
    cleanup();
  }
});
