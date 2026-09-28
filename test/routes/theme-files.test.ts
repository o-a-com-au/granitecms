import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { TEST_IDENTITY_ENV, writeJson } from '../helpers/tmp-site.ts';

const FIXTURE_SITE = join(import.meta.dirname, '..', 'fixtures', 'site');
const THEME_TOKEN = 'theme-scope-token';
const CONTENT_TOKEN = 'content-only-token';
const author = { name: 'Theme Developer', email: 'dev@example.com' };

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function git(siteRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: siteRoot, env: { ...process.env, ...TEST_IDENTITY_ENV } }).toString('utf-8');
}

function buildThemeTestServer() {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-theme-files-'));
  cpSync(FIXTURE_SITE, siteRoot, { recursive: true });
  writeFileSync(join(siteRoot, 'theme', '.DS_Store'), 'finder junk');
  writeJson(siteRoot, 'vhost/site.config.json', {
    tokens: [
      { hash: sha(THEME_TOKEN), scopes: ['theme'] },
      { hash: sha(CONTENT_TOKEN), scopes: ['content'] },
    ],
  });
  git(siteRoot, ['init', '--quiet']);
  git(siteRoot, ['add', '-A']);
  git(siteRoot, ['commit', '--quiet', '-m', 'site']);
  const app = buildServer(bootSite(siteRoot), loadServerConfig(siteRoot), { logger: false });
  return { app, siteRoot, cleanup: () => rmSync(siteRoot, { recursive: true, force: true }) };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const LAYOUT = 'layouts/theme.liquid';

test('theme files are listed with a hash each, hidden files left out, and read back byte for byte - with the theme scope only', async () => {
  const { app, siteRoot, cleanup } = buildThemeTestServer();
  try {
    const list = await app.inject({ method: 'GET', url: '/v1/theme/files', headers: auth(THEME_TOKEN) });
    assert.equal(list.statusCode, 200);
    const entries = list.json() as Array<{ path: string; size: number; hash: string }>;
    const layout = entries.find((entry) => entry.path === LAYOUT);
    const onDisk = readFileSync(join(siteRoot, 'theme', LAYOUT));
    assert.deepEqual(layout, { path: LAYOUT, size: onDisk.length, hash: sha(onDisk) });
    assert.ok(!entries.some((entry) => entry.path.includes('.DS_Store')));

    const file = await app.inject({ method: 'GET', url: `/v1/theme/files/${LAYOUT}`, headers: auth(THEME_TOKEN) });
    assert.equal(file.statusCode, 200);
    assert.deepEqual(file.rawPayload, onDisk);

    // A content-only token can't read or change the site's code.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/theme/files', headers: auth(CONTENT_TOKEN) })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/theme/files/../content/pages/about.json', headers: auth(THEME_TOKEN) })).statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('pushing a theme writes, deletes and commits once, and the live site renders the new theme on the very next request', async () => {
  const { app, siteRoot, cleanup } = buildThemeTestServer();
  try {
    const before = await app.inject({ method: 'GET', url: '/about' });
    assert.ok(!before.body.includes('Pushed layout'));

    const oldLayout = readFileSync(join(siteRoot, 'theme', LAYOUT), 'utf-8');
    const newLayout = oldLayout.replace('<body>', '<body><p>Pushed layout</p>');
    const styleBytes = readFileSync(join(siteRoot, 'theme/assets/style.css'));
    const commitsBefore = Number(git(siteRoot, ['rev-list', '--count', 'HEAD']).trim());

    const response = await app.inject({
      method: 'POST',
      url: '/v1/theme/push',
      headers: auth(THEME_TOKEN),
      payload: {
        writes: [
          { path: LAYOUT, content: Buffer.from(newLayout).toString('base64'), expected: sha(oldLayout) },
          { path: 'snippets/new-one.liquid', content: Buffer.from('<em>{{ x }}</em>').toString('base64'), expected: null },
        ],
        deletes: [{ path: 'assets/style.css', expected: sha(styleBytes) }],
        message: 'Push theme',
        author,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().generation, 1);

    // No restart: the same server renders the new layout straight away,
    // including a page it had already cached under the old theme.
    const after = await app.inject({ method: 'GET', url: '/about' });
    assert.ok(after.body.includes('Pushed layout'));

    assert.ok(existsSync(join(siteRoot, 'theme/snippets/new-one.liquid')));
    assert.equal(existsSync(join(siteRoot, 'theme/assets/style.css')), false);
    assert.equal(Number(git(siteRoot, ['rev-list', '--count', 'HEAD']).trim()), commitsBefore + 1);
    assert.equal(git(siteRoot, ['log', '-1', '--format=%an|%s']).trim(), 'Theme Developer|Push theme');
    assert.equal(git(siteRoot, ['status', '--porcelain', '--', 'theme']).trim(), '', 'everything pushed was committed');
  } finally {
    await app.close();
    cleanup();
  }
});

test('a push is refused, changing nothing, when a file changed on the site since the client saw it', async () => {
  const { app, siteRoot, cleanup } = buildThemeTestServer();
  try {
    const layoutBefore = readFileSync(join(siteRoot, 'theme', LAYOUT), 'utf-8');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/theme/push',
      headers: auth(THEME_TOKEN),
      payload: {
        writes: [
          { path: 'snippets/fine.liquid', content: Buffer.from('ok').toString('base64'), expected: null },
          { path: LAYOUT, content: Buffer.from('new').toString('base64'), expected: sha('what the client last saw') },
        ],
        deletes: [],
        message: 'Push theme',
        author,
      },
    });
    assert.equal(response.statusCode, 409);
    assert.match(response.json().message, /theme\/layouts\/theme\.liquid/);
    assert.equal(readFileSync(join(siteRoot, 'theme', LAYOUT), 'utf-8'), layoutBefore);
    assert.equal(existsSync(join(siteRoot, 'theme/snippets/fine.liquid')), false, 'nothing is written while any file conflicts');
  } finally {
    await app.close();
    cleanup();
  }
});

test('a push with a Liquid template that cannot be parsed is refused, changing nothing, and the site keeps rendering', async () => {
  const { app, siteRoot, cleanup } = buildThemeTestServer();
  try {
    const layoutBefore = readFileSync(join(siteRoot, 'theme', LAYOUT), 'utf-8');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/theme/push',
      headers: auth(THEME_TOKEN),
      payload: {
        writes: [{ path: LAYOUT, content: Buffer.from('{% if broken %}never closed').toString('base64'), expected: sha(layoutBefore) }],
        deletes: [],
        message: 'Push theme',
        author,
      },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().message, /theme\/layouts\/theme\.liquid is not valid Liquid/);
    assert.equal(readFileSync(join(siteRoot, 'theme', LAYOUT), 'utf-8'), layoutBefore);
    assert.equal((await app.inject({ method: 'GET', url: '/about' })).statusCode, 200);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a push is refused for any path outside theme/, a hidden file, or without the theme scope', async () => {
  const { app, siteRoot, cleanup } = buildThemeTestServer();
  try {
    for (const path of ['../content/pages/about.json', '/etc/passwd', 'assets/.env', 'a//b.liquid']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/theme/push',
        headers: auth(THEME_TOKEN),
        payload: { writes: [{ path, content: 'eA==', expected: null }], deletes: [], message: 'm', author },
      });
      assert.equal(response.statusCode, 400, path);
    }
    assert.ok(existsSync(join(siteRoot, 'content/pages/about.json')));

    const contentOnly = await app.inject({
      method: 'POST',
      url: '/v1/theme/push',
      headers: auth(CONTENT_TOKEN),
      payload: { writes: [{ path: 'snippets/x.liquid', content: 'eA==', expected: null }], deletes: [], message: 'm', author },
    });
    assert.equal(contentOnly.statusCode, 403);
  } finally {
    await app.close();
    cleanup();
  }
});
