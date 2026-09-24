import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

const CONTENT_TOKEN = 'menus-test-token';
const author = { name: 'Jane Editor', email: 'jane@example.com' };

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function menu(label: string): object {
  return { schemaVersion: 1, items: [{ label, url: '/' }] };
}

function buildMenusTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'vhost/site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup };
}

test('PUT /v1/menus/:name creates a new menu and commits immediately, no draft step', async () => {
  const { app, siteRoot, cleanup } = buildMenusTestServer();
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/menus/main.json',
      headers: {
        authorization: `Bearer ${CONTENT_TOKEN}`,
        'content-type': 'application/json',
        'if-match': 'no-prior-file',
      },
      payload: { content: menu('Home'), message: 'create main menu', author },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.headers.etag);
    const written = JSON.parse(readFileSync(join(siteRoot, 'content', 'menus', 'main.json'), 'utf-8'));
    assert.deepEqual(written, menu('Home'));
    // No draft was ever created for this write.
    assert.equal(
      (() => {
        try {
          readFileSync(join(siteRoot, 'content', 'drafts', 'menus', 'main.json'));
          return true;
        } catch {
          return false;
        }
      })(),
      false,
    );
  } finally {
    await app.close();
    cleanup();
  }
});

test('PUT /v1/menus/:name without an If-Match header is rejected with 428', async () => {
  const { app, cleanup } = buildMenusTestServer();
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/menus/main.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { content: menu('Home'), message: 'create', author },
    });
    assert.equal(response.statusCode, 428);
  } finally {
    await app.close();
    cleanup();
  }
});

test('PUT /v1/menus/:name with a stale If-Match returns 409, matching the page/draft precedent', async () => {
  const { app, cleanup } = buildMenusTestServer();
  try {
    await app.inject({
      method: 'PUT',
      url: '/v1/menus/main.json',
      headers: {
        authorization: `Bearer ${CONTENT_TOKEN}`,
        'content-type': 'application/json',
        'if-match': 'no-prior-file',
      },
      payload: { content: menu('Home'), message: 'create', author },
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/menus/main.json',
      headers: {
        authorization: `Bearer ${CONTENT_TOKEN}`,
        'content-type': 'application/json',
        'if-match': '"stale-etag"',
      },
      payload: { content: menu('Changed'), message: 'update', author },
    });
    assert.equal(response.statusCode, 409);
  } finally {
    await app.close();
    cleanup();
  }
});

test('PUT /v1/menus/:name rejects invalid menu content with 400', async () => {
  const { app, cleanup } = buildMenusTestServer();
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/menus/main.json',
      headers: {
        authorization: `Bearer ${CONTENT_TOKEN}`,
        'content-type': 'application/json',
        'if-match': 'no-prior-file',
      },
      payload: { content: { schemaVersion: 1, notItems: 'oops' }, message: 'create', author },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('PUT /v1/menus/:name rejects a malformed body with 400', async () => {
  const { app, cleanup } = buildMenusTestServer();
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/menus/main.json',
      headers: {
        authorization: `Bearer ${CONTENT_TOKEN}`,
        'content-type': 'application/json',
        'if-match': 'no-prior-file',
      },
      payload: { content: menu('Home') },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('PUT /v1/menus/:name with no token is rejected with 401', async () => {
  const { app, cleanup } = buildMenusTestServer();
  try {
    const response = await app.inject({ method: 'PUT', url: '/v1/menus/main.json', payload: {} });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt against PUT /v1/menus/:name fails safely, never a 500', async () => {
  const { app, cleanup } = buildMenusTestServer();
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/menus/..%2f..%2f..%2fetc%2fpasswd',
      headers: {
        authorization: `Bearer ${CONTENT_TOKEN}`,
        'content-type': 'application/json',
        'if-match': 'no-prior-file',
      },
      payload: { content: menu('Home'), message: 'create', author },
    });
    assert.ok(response.statusCode === 400 || response.statusCode === 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('two concurrent PUTs racing with the same If-Match value resolve to exactly one success (real ETag conflict protection, not just create/update existence checks)', async () => {
  const { app, cleanup } = buildMenusTestServer();
  try {
    await app.inject({
      method: 'PUT',
      url: '/v1/menus/main.json',
      headers: {
        authorization: `Bearer ${CONTENT_TOKEN}`,
        'content-type': 'application/json',
        'if-match': 'no-prior-file',
      },
      payload: { content: menu('Home'), message: 'create', author },
    });
    const read = await app.inject({
      method: 'GET',
      url: '/v1/content/menus/main.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    const startingEtag = read.headers.etag as string;

    const [r1, r2] = await Promise.all([
      app.inject({
        method: 'PUT',
        url: '/v1/menus/main.json',
        headers: {
          authorization: `Bearer ${CONTENT_TOKEN}`,
          'content-type': 'application/json',
          'if-match': startingEtag,
        },
        payload: { content: menu('From A'), message: 'update from A', author },
      }),
      app.inject({
        method: 'PUT',
        url: '/v1/menus/main.json',
        headers: {
          authorization: `Bearer ${CONTENT_TOKEN}`,
          'content-type': 'application/json',
          'if-match': startingEtag,
        },
        payload: { content: menu('From B'), message: 'update from B', author },
      }),
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort();
    assert.deepEqual(statuses, [200, 409]);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/content/menus/:name and DELETE /v1/content/menus/:name still work through the generic content routes, unchanged', async () => {
  const { app, cleanup } = buildMenusTestServer();
  try {
    await app.inject({
      method: 'PUT',
      url: '/v1/menus/main.json',
      headers: {
        authorization: `Bearer ${CONTENT_TOKEN}`,
        'content-type': 'application/json',
        'if-match': 'no-prior-file',
      },
      payload: { content: menu('Home'), message: 'create', author },
    });

    const get = await app.inject({
      method: 'GET',
      url: '/v1/content/menus/main.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(get.statusCode, 200);

    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/content/menus/main.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: 'delete main menu', author },
    });
    assert.equal(del.statusCode, 204);
  } finally {
    await app.close();
    cleanup();
  }
});

// --- POST /v1/menus/rename and GET /v1/menus/references (Group W10) ---

async function createMainMenu(app: ReturnType<typeof buildMenusTestServer>['app']): Promise<string> {
  const response = await app.inject({
    method: 'PUT',
    url: '/v1/menus/main.json',
    headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json', 'if-match': 'no-prior-file' },
    payload: { content: menu('Home'), message: 'create main menu', author },
  });
  return response.headers.etag as string;
}

function renameRequest(etag: string | undefined, payload: unknown) {
  return {
    method: 'POST' as const,
    url: '/v1/menus/rename',
    headers: {
      authorization: `Bearer ${CONTENT_TOKEN}`,
      'content-type': 'application/json',
      ...(etag === undefined ? {} : { 'if-match': etag }),
    },
    payload: payload as object,
  };
}

test('POST /v1/menus/rename moves a menu to its new handle, returning its etag and any stale theme references', async () => {
  const { app, siteRoot, cleanup } = buildMenusTestServer();
  try {
    const etag = await createMainMenu(app);
    mkdirSync(join(siteRoot, 'theme', 'layouts'), { recursive: true });
    writeFileSync(join(siteRoot, 'theme', 'layouts', 'theme.liquid'), '{% for item in menus.main.items %}{% endfor %}');

    const response = await app.inject(renameRequest(etag, { from: 'main', to: 'header', message: 'rename', author }));

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers.etag, etag);
    assert.deepEqual(response.json(), { ok: true, staleThemeReferences: ['theme/layouts/theme.liquid'] });
    assert.equal(existsSync(join(siteRoot, 'content', 'menus', 'header.json')), true);
    assert.equal(existsSync(join(siteRoot, 'content', 'menus', 'main.json')), false);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/menus/rename: 428 without If-Match, 400 for a bad body or handle, 404 for a missing menu, 409 for a taken handle', async () => {
  const { app, cleanup } = buildMenusTestServer();
  try {
    const etag = await createMainMenu(app);
    await app.inject({
      method: 'PUT',
      url: '/v1/menus/footer.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json', 'if-match': 'no-prior-file' },
      payload: { content: menu('Privacy'), message: 'create footer', author },
    });

    assert.equal((await app.inject(renameRequest(undefined, { from: 'main', to: 'x', message: 'm', author }))).statusCode, 428);
    assert.equal((await app.inject(renameRequest(etag, { from: 'main', message: 'm', author }))).statusCode, 400);
    assert.equal((await app.inject(renameRequest(etag, { from: 'main', to: '../pages/about', message: 'm', author }))).statusCode, 400);
    assert.equal((await app.inject(renameRequest(etag, { from: 'nope', to: 'x', message: 'm', author }))).statusCode, 404);
    assert.equal((await app.inject(renameRequest(etag, { from: 'main', to: 'footer', message: 'm', author }))).statusCode, 409);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/menus/references lists theme files using a handle, and needs a token', async () => {
  const { app, siteRoot, cleanup } = buildMenusTestServer();
  try {
    mkdirSync(join(siteRoot, 'theme', 'layouts'), { recursive: true });
    writeFileSync(join(siteRoot, 'theme', 'layouts', 'theme.liquid'), '{{ menus.main.items }}');

    const ok = await app.inject({
      method: 'GET',
      url: '/v1/menus/references?handle=main',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { handle: 'main', themeFiles: ['theme/layouts/theme.liquid'] });

    const bad = await app.inject({
      method: 'GET',
      url: '/v1/menus/references?handle=../x',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(bad.statusCode, 400);

    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/menus/references?handle=main' });
    assert.equal(unauthenticated.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});
