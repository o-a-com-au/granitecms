import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { requireScope } from '../../src/services/token-auth.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const CONTENT_TOKEN = 'test-content-token';
const THEME_TOKEN = 'test-theme-token';

// Synthetic routes, test-only: at the point Group B lands,
// capabilities.ts is the only real route in src/routes/ and it's
// exempt from auth, so there is no real scope-gated production route
// yet to prove B1/B2/B3/B5 against - matching the same pattern Group
// A's own A5 test used for its throwaway /v1/__throws route.
function buildAuthTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'vhost/site.config.json', {
    tokens: [
      { hash: hashOf(CONTENT_TOKEN), scopes: ['content'] },
      { hash: hashOf(THEME_TOKEN), scopes: ['theme'] },
    ],
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  app.get(
    '/v1/__content-gated',
    { preHandler: requireScope(serverConfig.tokens, 'content') },
    async () => ({ ok: true }),
  );
  app.get(
    '/v1/__theme-gated',
    { preHandler: requireScope(serverConfig.tokens, 'theme') },
    async () => ({ ok: true }),
  );

  return { app, cleanup };
}

test('B1: a request with no token is rejected with 401 on every route that requires one', async () => {
  const { app, cleanup } = buildAuthTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/__content-gated' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

test('B2: a request with a token lacking the scope a route requires is rejected with 403', async () => {
  const { app, cleanup } = buildAuthTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/__theme-gated',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
    cleanup();
  }
});

test('B3: a request with a valid, correctly-scoped token succeeds', async () => {
  const { app, cleanup } = buildAuthTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/__content-gated',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
  } finally {
    await app.close();
    cleanup();
  }
});

test('B5 (synthetic proof - no theme-writing route exists anywhere in Phase 2 scope, see docs/phase-2-checklist.md): a content-scoped token cannot access a theme-gated route; the theme scope is required and distinct from the content scope', async () => {
  const { app, cleanup } = buildAuthTestServer();
  try {
    const wrongScope = await app.inject({
      method: 'GET',
      url: '/v1/__theme-gated',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(wrongScope.statusCode, 403);

    const rightScope = await app.inject({
      method: 'GET',
      url: '/v1/__theme-gated',
      headers: { authorization: `Bearer ${THEME_TOKEN}` },
    });
    assert.equal(rightScope.statusCode, 200);
  } finally {
    await app.close();
    cleanup();
  }
});
