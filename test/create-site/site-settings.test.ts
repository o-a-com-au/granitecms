import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { scaffoldSite } from '../../src/create-site/generate-site.ts';
import { renderPage } from '../../src/renderer/render-page.ts';
import { resolveSiteSettings } from '../../src/services/site-settings.ts';

// A new site ships with site settings: its footer links and body font
// come from them, defaulting to what the scaffold always showed.
test('a new site\'s footer links and body font come from its site settings, and follow a saved change', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'scaffold-settings-'));
  try {
    const siteRoot = join(parent, 'site');
    scaffoldSite(siteRoot);
    const render = () => {
      const booted = bootSite(siteRoot);
      assert.deepEqual(booted.themeSchemas.warnings ?? [], []);
      return renderPage(booted.config, booted.themeTemplates, booted.layouts, booted.engine, 'pages/index.json', 'public', resolveSiteSettings(booted.config, booted.themeSchemas));
    };

    const before = await render();
    assert.match(before, /href="https:\/\/github\.com\/granite-cms\/granite" aria-label="GitHub"/);
    assert.match(before, /aria-label="Discord"/);
    assert.doesNotMatch(before, /Georgia/);

    writeFileSync(
      join(siteRoot, 'content', 'settings.json'),
      JSON.stringify({ schemaVersion: 7, settings: { github_url: 'https://github.com/example/site', discord_url: '', body_font: 'Serif' } }),
    );
    const after = await render();
    assert.match(after, /href="https:\/\/github\.com\/example\/site" aria-label="GitHub"/);
    assert.doesNotMatch(after, /aria-label="Discord"/, 'a link left empty is not shown');
    assert.match(after, /--font-sans: Georgia/);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
