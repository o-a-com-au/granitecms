import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootSite } from '../src/boot.ts';
import { buildServer } from '../src/server.ts';
import { loadServerConfig } from '../src/server-config.ts';
import { createTmpSiteRoot } from './helpers/tmp-site.ts';

function buildTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });
  return { app, cleanup };
}

test('A2: every route is registered under a /v1 prefix', async () => {
  const { app, cleanup } = buildTestServer();
  try {
    const unprefixed = await app.inject({ method: 'GET', url: '/capabilities' });
    assert.equal(unprefixed.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('A4: requesting an unregistered route returns 404 with a structured JSON error body', async () => {
  const { app, cleanup } = buildTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    const body = response.json() as { statusCode: number; error: string; message: string };
    assert.equal(body.statusCode, 404);
    assert.equal(typeof body.error, 'string');
    assert.equal(typeof body.message, 'string');
  } finally {
    await app.close();
    cleanup();
  }
});

test('A5: an uncaught error thrown inside a route handler returns 500 with a structured JSON error body, never a raw stack trace', async () => {
  const { app, cleanup } = buildTestServer();
  try {
    app.get('/v1/__throws', async () => {
      throw new Error('internal detail that must never reach the client');
    });

    const response = await app.inject({ method: 'GET', url: '/v1/__throws' });
    assert.equal(response.statusCode, 500);
    const body = response.json() as { statusCode: number; error: string; message: string };
    assert.equal(body.statusCode, 500);
    assert.equal(body.error, 'Internal Server Error');
    assert.equal(body.message, 'Internal Server Error');
    assert.ok(!response.body.includes('internal detail'));
    assert.ok(!response.body.includes('.ts:'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('a route error below 500 (e.g. a future schema-validation failure) is passed through with its real message, not sanitised', async () => {
  const { app, cleanup } = buildTestServer();
  try {
    app.get('/v1/__bad-request', async () => {
      const error = new Error('specific, safe-to-show validation detail') as Error & { statusCode: number };
      error.statusCode = 400;
      throw error;
    });

    const response = await app.inject({ method: 'GET', url: '/v1/__bad-request' });
    assert.equal(response.statusCode, 400);
    const body = response.json() as { statusCode: number; message: string };
    assert.equal(body.message, 'specific, safe-to-show validation detail');
  } finally {
    await app.close();
    cleanup();
  }
});
