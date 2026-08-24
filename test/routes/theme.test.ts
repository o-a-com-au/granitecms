import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

const CONTENT_TOKEN = 'theme-test-token';

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function buildThemeTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'vhost/site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
  });

  mkdirSync(join(siteRoot, 'theme', 'sections'), { recursive: true });
  mkdirSync(join(siteRoot, 'theme', 'blocks'), { recursive: true });
  writeFileSync(
    join(siteRoot, 'theme', 'sections', 'hero.liquid'),
    '<h1>{{ section.settings.heading }}</h1>{% for html in blocksHtml %}{{ html | raw }}{% endfor %}\n{% schema %}\n{"type":"object","required":["heading"],"properties":{"heading":{"type":"string","minLength":1,"default":"New Section"}},"allowedBlocks":["button"]}\n{% endschema %}\n',
  );
  writeFileSync(
    join(siteRoot, 'theme', 'blocks', 'button.liquid'),
    '<a href="{{ block.settings.url }}">{{ block.settings.label }}</a>\n{% schema %}\n{"type":"object","required":["label","url"],"properties":{"label":{"type":"string","default":"Learn more"},"url":{"type":"string","default":"#"}}}\n{% endschema %}\n',
  );
  mkdirSync(join(siteRoot, 'theme', 'templates'), { recursive: true });
  writeJson(siteRoot, 'theme/templates/blog-article.json', {
    schemaVersion: 1,
    name: 'blog-article',
    title: 'Blog Article',
    type: 'page',
    layout: 'theme',
    published: true,
    sections: [{ id: 'sec-hero', type: 'hero', settings: { heading: 'A blog post' }, blocks: [] }],
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, cleanup };
}

test('I2: GET /v1/theme/schemas returns the real theme schemas and acceptsBlocks flags', async () => {
  const { app, cleanup } = buildThemeTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/theme/schemas',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      sections: Record<string, unknown>;
      blocks: Record<string, unknown>;
      acceptsBlocks: { sections: Record<string, boolean>; blocks: Record<string, boolean> };
    };
    assert.ok(body.sections.hero);
    assert.ok(body.blocks.button);
    assert.equal(body.acceptsBlocks.sections.hero, true);
    assert.equal(body.acceptsBlocks.blocks.button, false);
  } finally {
    await app.close();
    cleanup();
  }
});

test('K3: GET /v1/theme/schemas round-trips a section\'s allowedBlocks key unmolested', async () => {
  const { app, cleanup } = buildThemeTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/theme/schemas',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { sections: Record<string, { allowedBlocks?: unknown }> };
    const hero = body.sections.hero;
    assert.ok(hero, 'expected the hero section schema to be present');
    assert.deepEqual(hero.allowedBlocks, ['button']);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/theme/schemas with no token is rejected with 401', async () => {
  const { app, cleanup } = buildThemeTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/theme/schemas' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

test('Group Q: GET /v1/theme/page-templates returns the real page templates verbatim', async () => {
  const { app, cleanup } = buildThemeTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/theme/page-templates',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { templates: Array<{ id: string; title: string }> };
    assert.equal(body.templates.length, 1);
    assert.equal(body.templates[0]?.id, 'blog-article');
    assert.equal(body.templates[0]?.title, 'Blog Article');
  } finally {
    await app.close();
    cleanup();
  }
});

test('Group Q: GET /v1/theme/page-templates returns an empty list when the theme has no templates folder', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'vhost/site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
  });
  try {
    const booted = bootSite(siteRoot);
    const serverConfig = loadServerConfig(siteRoot);
    const app = buildServer(booted, serverConfig, { logger: false });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/theme/page-templates',
        headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { templates: [] });
    } finally {
      await app.close();
    }
  } finally {
    cleanup();
  }
});

test('GET /v1/theme/page-templates with no token is rejected with 401', async () => {
  const { app, cleanup } = buildThemeTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/theme/page-templates' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});
