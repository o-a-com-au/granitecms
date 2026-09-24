import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { bootSite } from '../../src/boot.ts';
import { loadSiteConfig } from '../../src/config.ts';
import { PullSiteError, pullSite } from '../../src/pull-site/pull-site.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { TEST_IDENTITY_ENV, writeJson } from '../helpers/tmp-site.ts';

const FIXTURE_SITE = join(import.meta.dirname, '..', 'fixtures', 'site');
const TOKEN = 'pull-site-test-token';
const MEDIA_NAME = 'photo-1a2b3c4d5e6f.jpg';
const MEDIA_BYTES = Buffer.from('not really a jpeg, but bytes are bytes');

function git(siteRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: siteRoot, env: { ...process.env, ...TEST_IDENTITY_ENV } }).toString('utf-8');
}

// A real running site: the fixture (pages, a menu, a draft-only page),
// a redirect, a media file, and a token with content + media scopes.
async function startLiveSite(): Promise<{ app: FastifyInstance; url: string; siteRoot: string }> {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-pull-live-'));
  cpSync(FIXTURE_SITE, siteRoot, { recursive: true });
  git(siteRoot, ['init', '--quiet']);
  writeJson(siteRoot, 'vhost/site.config.json', {
    tokens: [{ hash: createHash('sha256').update(TOKEN).digest('hex'), scopes: ['content', 'media'] }],
  });
  writeJson(siteRoot, 'content/redirects.json', { schemaVersion: 1, entries: [{ from: '/old', to: '/about' }] });
  mkdirSync(join(siteRoot, 'media'), { recursive: true });
  writeFileSync(join(siteRoot, 'media', MEDIA_NAME), MEDIA_BYTES);

  const app = buildServer(bootSite(siteRoot), loadServerConfig(siteRoot), { logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a port');
  }
  return { app, url: `http://127.0.0.1:${address.port}`, siteRoot };
}

// The local copy: a committed git repo with its own theme, one page the
// live site doesn't have, and a stale draft.
function createLocalSite(): string {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-pull-local-'));
  cpSync(join(FIXTURE_SITE, 'theme'), join(siteRoot, 'theme'), { recursive: true });
  writeJson(siteRoot, 'content/pages/local-only.json', { schemaVersion: 7, title: 'Local only' });
  writeJson(siteRoot, 'content/drafts/pages/stale-draft.json', { schemaVersion: 7, title: 'Stale' });
  writeJson(siteRoot, 'vhost/site.config.json', { tokens: [] });
  git(siteRoot, ['init', '--quiet']);
  git(siteRoot, ['add', '-A']);
  git(siteRoot, ['commit', '--quiet', '-m', 'local']);
  return siteRoot;
}

test('pullSite mirrors a real live site\'s content, drafts, menus, redirects and media into a local site, without committing', async () => {
  const live = await startLiveSite();
  const localRoot = createLocalSite();
  try {
    const config = loadSiteConfig(localRoot);
    const result = await pullSite(config, { siteUrl: live.url, token: TOKEN });

    // Byte-for-byte what the live site has, for every live file.
    for (const path of ['content/pages/about.json', 'content/menus/main.json']) {
      assert.equal(readFileSync(join(localRoot, path), 'utf-8'), readFileSync(join(live.siteRoot, path), 'utf-8'), path);
    }
    // A draft-only page arrives as a draft, not as a live page.
    assert.ok(existsSync(join(localRoot, 'content/drafts/pages/draft-only.json')));
    assert.equal(existsSync(join(localRoot, 'content/pages/draft-only.json')), false);
    // Local files the live site doesn't have are gone, and reported.
    assert.equal(existsSync(join(localRoot, 'content/pages/local-only.json')), false);
    assert.equal(existsSync(join(localRoot, 'content/drafts/pages/stale-draft.json')), false);
    assert.deepEqual(result.removed, ['drafts/pages/stale-draft.json', 'pages/local-only.json']);
    // Redirects and media.
    assert.deepEqual(JSON.parse(readFileSync(join(localRoot, 'content/redirects.json'), 'utf-8')).entries, [{ from: '/old', to: '/about' }]);
    assert.deepEqual(readFileSync(join(localRoot, 'media', MEDIA_NAME)), MEDIA_BYTES);
    assert.equal(result.mediaDownloaded, 1);
    assert.equal(result.redirects, 1);
    assert.ok(result.pages > 0);
    assert.equal(result.menus, 1);
    assert.equal(result.drafts, 1);
    // The theme is the local site's own, untouched; nothing committed.
    assert.equal(git(localRoot, ['log', '--oneline']).trim().split('\n').length, 1);
    assert.notEqual(git(localRoot, ['status', '--porcelain', '--', 'content']).trim(), '');
    // The search index was rebuilt from the pulled content.
    assert.ok(existsSync(join(localRoot, 'vhost', 'data', 'search-index.sqlite')));

    // A second pull (after committing) finds the media already there.
    git(localRoot, ['add', '-A']);
    git(localRoot, ['commit', '--quiet', '-m', 'pulled']);
    const again = await pullSite(config, { siteUrl: live.url, token: TOKEN });
    assert.equal(again.mediaDownloaded, 0);
    assert.equal(again.mediaAlreadyPresent, 1);
    assert.deepEqual(again.removed, []);
    assert.equal(git(localRoot, ['status', '--porcelain', '--', 'content']).trim(), '', 'nothing changed the second time');
  } finally {
    await live.app.close();
    rmSync(live.siteRoot, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
  }
});

test('pullSite refuses to overwrite uncommitted local content unless forced, and changes nothing when it refuses', async () => {
  const live = await startLiveSite();
  const localRoot = createLocalSite();
  try {
    writeJson(localRoot, 'content/pages/local-only.json', { schemaVersion: 7, title: 'Edited, not committed' });
    const config = loadSiteConfig(localRoot);

    await assert.rejects(
      pullSite(config, { siteUrl: live.url, token: TOKEN }),
      (error: unknown) => error instanceof PullSiteError && error.reason === 'uncommitted-changes',
    );
    assert.equal(JSON.parse(readFileSync(join(localRoot, 'content/pages/local-only.json'), 'utf-8')).title, 'Edited, not committed');

    await pullSite(config, { siteUrl: live.url, token: TOKEN, force: true });
    assert.equal(existsSync(join(localRoot, 'content/pages/local-only.json')), false);
  } finally {
    await live.app.close();
    rmSync(live.siteRoot, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
  }
});

test('pullSite: a wrong token is reported as such, and changes nothing', async () => {
  const live = await startLiveSite();
  const localRoot = createLocalSite();
  try {
    await assert.rejects(
      pullSite(loadSiteConfig(localRoot), { siteUrl: live.url, token: 'wrong' }),
      (error: unknown) => error instanceof PullSiteError && error.reason === 'unauthorised',
    );
    assert.ok(existsSync(join(localRoot, 'content/pages/local-only.json')));
  } finally {
    await live.app.close();
    rmSync(live.siteRoot, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
  }
});

// A fake server stands in for a hostile or broken one: pull-site writes
// server-supplied paths to disk, so they must never escape the site.
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    const body = routes[url.pathname];
    if (body === undefined) {
      return new Response('{}', { status: 404 });
    }
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const CAPABILITIES = { agentVersion: '0.5.3', contentSchemaVersion: 7 };

test('pullSite refuses a content path that would escape the site, before writing anything', async () => {
  const localRoot = createLocalSite();
  try {
    for (const path of ['../../etc/evil.json', 'pages/../../evil.json', 'theme/layouts/x.json', '/abs.json', 'pages/.hidden.json']) {
      await assert.rejects(
        pullSite(loadSiteConfig(localRoot), {
          siteUrl: 'http://live.test',
          token: 't',
          fetchImpl: fakeFetch({ '/v1/capabilities': CAPABILITIES, '/v1/content': [{ path, hasDraft: false }] }),
        }),
        (error: unknown) => error instanceof PullSiteError && error.reason === 'unsafe-path',
        path,
      );
    }
    assert.ok(existsSync(join(localRoot, 'content/pages/local-only.json')));
  } finally {
    rmSync(localRoot, { recursive: true, force: true });
  }
});

test('pullSite refuses a media name that would escape media/', async () => {
  const localRoot = createLocalSite();
  try {
    await assert.rejects(
      pullSite(loadSiteConfig(localRoot), {
        siteUrl: 'http://live.test',
        token: 't',
        fetchImpl: fakeFetch({
          '/v1/capabilities': CAPABILITIES,
          '/v1/content': [],
          '/v1/redirects': { schemaVersion: 1, entries: [] },
          '/v1/media': [{ name: '../evil.jpg', size: 1 }],
        }),
      }),
      (error: unknown) => error instanceof PullSiteError && error.reason === 'unsafe-path',
    );
    assert.equal(existsSync(join(localRoot, 'evil.jpg')), false);
  } finally {
    rmSync(localRoot, { recursive: true, force: true });
  }
});

test('pullSite refuses a site with a newer content schema than this agent, and anything that is not a site', async () => {
  const localRoot = createLocalSite();
  try {
    await assert.rejects(
      pullSite(loadSiteConfig(localRoot), {
        siteUrl: 'http://live.test',
        token: 't',
        fetchImpl: fakeFetch({ '/v1/capabilities': { agentVersion: '9.0.0', contentSchemaVersion: 99 } }),
      }),
      (error: unknown) => error instanceof PullSiteError && error.reason === 'newer-schema',
    );
    await assert.rejects(
      pullSite(loadSiteConfig(localRoot), {
        siteUrl: 'http://live.test',
        token: 't',
        fetchImpl: fakeFetch({ '/v1/capabilities': { hello: 'world' } }),
      }),
      (error: unknown) => error instanceof PullSiteError && error.reason === 'not-a-site',
    );
  } finally {
    rmSync(localRoot, { recursive: true, force: true });
  }
});
