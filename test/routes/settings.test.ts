import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { loadThemeSchemas } from '../../src/services/theme-schemas.ts';
import { TEST_IDENTITY_ENV, writeJson } from '../helpers/tmp-site.ts';

const FIXTURE_SITE = join(import.meta.dirname, '..', 'fixtures', 'site');
const TOKEN = 'settings-test-token';
const author = { name: 'Settings Editor', email: 'editor@example.com' };

const SETTINGS_SCHEMA = {
  title: 'Site settings',
  type: 'object',
  additionalProperties: false,
  properties: {
    site_name: { type: 'string', title: 'Site name', default: 'Default Co' },
    instagram_url: { type: 'string', title: 'Instagram' },
    body_font: { type: 'string', title: 'Body font', enum: ['Inter', 'Georgia'], default: 'Inter' },
  },
};

function git(siteRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: siteRoot, env: { ...process.env, ...TEST_IDENTITY_ENV } }).toString('utf-8');
}

// The fixture site, with a settings schema, and `settings` used in a
// layout, a section, a block and a snippet (pulled in with render).
function buildSettingsSite({ schema = SETTINGS_SCHEMA as unknown }: { schema?: unknown } = {}) {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-settings-'));
  cpSync(FIXTURE_SITE, siteRoot, { recursive: true });
  mkdirSync(join(siteRoot, 'theme', 'config'), { recursive: true });
  writeFileSync(join(siteRoot, 'theme', 'config', 'site_settings.json'), typeof schema === 'string' ? schema : JSON.stringify(schema));
  writeFileSync(join(siteRoot, 'theme', 'snippets', 'settings-probe.liquid'), '[snippet:{{ settings.site_name }}]');
  const layout = join(siteRoot, 'theme', 'layouts', 'theme.liquid');
  writeFileSync(layout, readFileSync(layout, 'utf-8').replace('</body>', "[layout:{{ settings.site_name }}|{{ settings.body_font }}]{% render 'settings-probe' %}</body>"));
  appendFileSync(join(siteRoot, 'theme', 'sections', 'hero.liquid'), '[section:{{ settings.site_name }}]');
  appendFileSync(join(siteRoot, 'theme', 'blocks', 'button.liquid'), '[block:{{ settings.site_name }}]');
  writeJson(siteRoot, 'vhost/site.config.json', { tokens: [{ hash: createHash('sha256').update(TOKEN).digest('hex'), scopes: ['content'] }] });
  git(siteRoot, ['init', '--quiet']);
  git(siteRoot, ['add', '-A']);
  git(siteRoot, ['commit', '--quiet', '-m', 'site']);
  const app = buildServer(bootSite(siteRoot), loadServerConfig(siteRoot), { logger: false });
  return { app, siteRoot, cleanup: () => rmSync(siteRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

const auth = { authorization: `Bearer ${TOKEN}` };

test('settings reach every layout, section, block and snippet, using the theme\'s defaults until saved', async () => {
  const { app, cleanup } = buildSettingsSite();
  try {
    const html = (await app.inject({ method: 'GET', url: '/about' })).body;
    for (const place of ['layout', 'section', 'block', 'snippet']) {
      assert.match(html, new RegExp(`\\[${place}:Default Co`), place);
    }
    assert.match(html, /\|Inter\]/);
  } finally {
    await app.close();
    cleanup();
  }
});

test('saving settings commits once and every page shows them on the next request, even one already cached', async () => {
  const { app, siteRoot, cleanup } = buildSettingsSite();
  try {
    assert.match((await app.inject({ method: 'GET', url: '/about' })).body, /\[layout:Default Co/, 'cached with the default');
    const commits = git(siteRoot, ['rev-list', '--count', 'HEAD']).trim();

    const get = await app.inject({ method: 'GET', url: '/v1/settings', headers: auth });
    assert.equal(get.statusCode, 200);
    assert.deepEqual(get.json().schema, SETTINGS_SCHEMA);
    assert.deepEqual(get.json().settings, {});
    assert.deepEqual(get.json().resolved, { site_name: 'Default Co', body_font: 'Inter' });

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/settings',
      headers: { ...auth, 'if-match': '*' },
      payload: { settings: { site_name: 'Ember', body_font: 'Georgia' }, message: 'Update site settings', author },
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.ok(put.headers.etag);

    const html = (await app.inject({ method: 'GET', url: '/about' })).body;
    for (const place of ['layout', 'section', 'block', 'snippet']) {
      assert.match(html, new RegExp(`\\[${place}:Ember`), place);
    }
    assert.match(html, /\|Georgia\]/);
    assert.equal(Number(git(siteRoot, ['rev-list', '--count', 'HEAD']).trim()), Number(commits) + 1);
    assert.equal(git(siteRoot, ['log', '-1', '--format=%an|%s']).trim(), 'Settings Editor|Update site settings');
    const stored = JSON.parse(readFileSync(join(siteRoot, 'content', 'settings.json'), 'utf-8')) as Record<string, unknown>;
    assert.deepEqual(stored, { schemaVersion: 7, settings: { site_name: 'Ember', body_font: 'Georgia' } });

    const after = await app.inject({ method: 'GET', url: '/v1/settings', headers: auth });
    assert.equal(after.headers.etag, put.headers.etag);
    assert.deepEqual(after.json().resolved, { site_name: 'Ember', body_font: 'Georgia' });
  } finally {
    await app.close();
    cleanup();
  }
});

test('the preview shows unsaved settings given in ?settings=, writing nothing, and ignores values the schema rejects', async () => {
  const { app, siteRoot, cleanup } = buildSettingsSite();
  try {
    const preview = (settings: string) =>
      app.inject({ method: 'GET', url: `/v1/preview/about?settings=${encodeURIComponent(settings)}`, headers: auth });

    const unsaved = await preview(JSON.stringify({ site_name: 'Unsaved Co' }));
    assert.equal(unsaved.statusCode, 200, unsaved.body);
    for (const place of ['layout', 'section', 'block', 'snippet']) {
      assert.match(unsaved.body, new RegExp(`\\[${place}:Unsaved Co`), place);
    }
    assert.match(unsaved.body, /\|Inter\]/, 'a setting not given still has its default');

    assert.match((await preview(JSON.stringify({ body_font: 'Comic Sans' }))).body, /\[layout:Default Co\|Inter\]/, 'rejected by the schema');
    assert.match((await preview('{not json')).body, /\[layout:Default Co\|Inter\]/, 'not JSON');

    assert.match((await app.inject({ method: 'GET', url: '/about' })).body, /\[layout:Default Co/, 'the live site is untouched');
    assert.equal(git(siteRoot, ['status', '--porcelain']).trim(), '');
  } finally {
    await app.close();
    cleanup();
  }
});

test('a save is refused - changing nothing - without If-Match, with a stale one, or with values the theme\'s schema rejects', async () => {
  const { app, siteRoot, cleanup } = buildSettingsSite();
  try {
    const save = (ifMatch: string | undefined, settings: unknown) =>
      app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: { ...auth, ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
        payload: { settings, message: 'm', author },
      });
    const first = await save('*', { site_name: 'First' });
    assert.equal(first.statusCode, 200);

    assert.equal((await save(undefined, { site_name: 'x' })).statusCode, 428);
    assert.equal((await save('"stale"', { site_name: 'Second' })).statusCode, 409);
    const invalid = await save(first.headers.etag as string, { body_font: 'Comic Sans' });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().message, /body_font/);
    assert.equal((await save(first.headers.etag as string, { unknown_setting: 1 })).statusCode, 400);

    assert.deepEqual(
      (JSON.parse(readFileSync(join(siteRoot, 'content', 'settings.json'), 'utf-8')) as { settings: unknown }).settings,
      { site_name: 'First' },
    );
  } finally {
    await app.close();
    cleanup();
  }
});

test('settings.json is not reachable through the generic content routes', async () => {
  const { app, cleanup } = buildSettingsSite();
  try {
    await app.inject({
      method: 'PUT',
      url: '/v1/settings',
      headers: { ...auth, 'if-match': '*' },
      payload: { settings: { site_name: 'x' }, message: 'm', author },
    });
    assert.equal((await app.inject({ method: 'GET', url: '/v1/content/settings.json', headers: auth })).statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a theme with no settings schema has no settings: templates see an empty `settings`, and only an empty save is accepted', async () => {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-no-settings-'));
  try {
    cpSync(FIXTURE_SITE, siteRoot, { recursive: true });
    assert.equal(loadThemeSchemas(join(siteRoot, 'theme')).settings, undefined);
  } finally {
    rmSync(siteRoot, { recursive: true, force: true });
  }
  const { app, cleanup } = buildSettingsSite({ schema: 'not json' });
  try {
    const get = await app.inject({ method: 'GET', url: '/v1/settings', headers: auth });
    assert.equal(get.json().schema, null, 'an unusable schema file leaves the theme with no settings');
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/settings',
      headers: { ...auth, 'if-match': '*' },
      payload: { settings: { site_name: 'x' }, message: 'm', author },
    });
    assert.equal(put.statusCode, 400);
    assert.match(put.json().message, /defines no site settings/);
  } finally {
    await app.close();
    cleanup();
  }
});

test('an unusable settings schema is left out with a start-up warning, like a broken section', () => {
  const root = mkdtempSync(join(tmpdir(), 'cms-agent-settings-schema-'));
  try {
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'site_settings.json'), 'not json');
    assert.match((loadThemeSchemas(root).warnings ?? []).join('\n'), /config\/site_settings\.json.*not valid JSON/);
    writeFileSync(join(root, 'config', 'site_settings.json'), JSON.stringify([{ name: 'a list' }]));
    assert.equal(loadThemeSchemas(root).settings, undefined);
    assert.match((loadThemeSchemas(root).warnings ?? []).join('\n'), /must hold a JSON Schema object/);
    writeFileSync(
      join(root, 'config', 'site_settings.json'),
      JSON.stringify({ type: 'object', required: ['name'], properties: { name: { type: 'string' } } }),
    );
    const schemas = loadThemeSchemas(root);
    assert.equal(schemas.settings, undefined);
    assert.match((schemas.warnings ?? []).join('\n'), /"required" has no valid "default"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config/settings_schema.json, the 0.7.0 name, is still read in Granite\'s form with a warning to rename it; in Shopify\'s form it is left alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'cms-agent-settings-schema-'));
  const schema = { type: 'object', properties: { announcement: { type: 'string', default: '' } } };
  try {
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'settings_schema.json'), JSON.stringify(schema));
    const old = loadThemeSchemas(root);
    assert.deepEqual(old.settings, schema);
    assert.match((old.warnings ?? []).join('\n'), /Rename it to config\/site_settings\.json/);

    const shopify = [{ name: 'theme_info', settings: [{ type: 'text', id: 'announcement', label: 'Announcement' }] }];
    writeFileSync(join(root, 'config', 'settings_schema.json'), JSON.stringify(shopify));
    assert.equal(loadThemeSchemas(root).settings, undefined);
    assert.deepEqual(loadThemeSchemas(root).warnings, []);

    writeFileSync(join(root, 'config', 'site_settings.json'), JSON.stringify(schema));
    const both = loadThemeSchemas(root);
    assert.deepEqual(both.settings, schema, 'the new name wins, whatever settings_schema.json holds');
    assert.deepEqual(both.warnings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
