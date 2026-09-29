import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { writeJson } from '../helpers/tmp-site.ts';

const FIXTURE_SITE = join(import.meta.dirname, '..', 'fixtures', 'site');
const TOKEN = 'links-test-token';

test('GET /v1/links?to= lists what links to a page, needs a content token, and refuses anything but a page path', async () => {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-links-'));
  cpSync(FIXTURE_SITE, siteRoot, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: siteRoot });
  writeJson(siteRoot, 'vhost/site.config.json', { tokens: [{ hash: createHash('sha256').update(TOKEN).digest('hex'), scopes: ['content'] }] });
  const app = buildServer(bootSite(siteRoot), loadServerConfig(siteRoot), { logger: false });
  const auth = { authorization: `Bearer ${TOKEN}` };
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/links?to=%2Fabout', headers: auth });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { to: string; references: Array<{ kind: string; path: string; hrefs: string[] }> };
    assert.equal(body.to, '/about');
    assert.ok(
      body.references.some((reference) => reference.kind === 'menu' && reference.path === 'menus/main.json' && reference.hrefs.includes('/about')),
      JSON.stringify(body.references),
    );

    assert.equal((await app.inject({ method: 'GET', url: '/v1/links?to=%2Fabout' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/links?to=https%3A%2F%2Fexample.com', headers: auth })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/links', headers: auth })).statusCode, 400);
  } finally {
    await app.close();
    rmSync(siteRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
