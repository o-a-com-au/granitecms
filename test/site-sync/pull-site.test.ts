import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { pullSite } from '../../src/site-sync/pull-site.ts';
import { SiteSyncError } from '../../src/site-sync/remote-site.ts';
import { writeJson } from '../helpers/tmp-site.ts';
import { createLocalSite, git, MEDIA_BYTES, MEDIA_NAME, startLiveSite, TOKEN } from './sync-helpers.ts';

test('pullSite mirrors a real live site\'s content, drafts, menus, redirects and media into a local site, without committing', async () => {
  const live = await startLiveSite();
  const localRoot = createLocalSite();
  try {
    const config = loadSiteConfig(localRoot);
    const result = (await pullSite(config, { siteUrl: live.url, token: TOKEN, parts: { content: true, theme: false } })).content!;

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
    const again = (await pullSite(config, { siteUrl: live.url, token: TOKEN, parts: { content: true, theme: false } })).content!;
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
      pullSite(config, { siteUrl: live.url, token: TOKEN, parts: { content: true, theme: false } }),
      (error: unknown) => error instanceof SiteSyncError && error.reason === 'uncommitted-changes',
    );
    assert.equal(JSON.parse(readFileSync(join(localRoot, 'content/pages/local-only.json'), 'utf-8')).title, 'Edited, not committed');

    await pullSite(config, { siteUrl: live.url, token: TOKEN, force: true, parts: { content: true, theme: false } });
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
      pullSite(loadSiteConfig(localRoot), { siteUrl: live.url, token: 'wrong', parts: { content: true, theme: false } }),
      (error: unknown) => error instanceof SiteSyncError && error.reason === 'unauthorised',
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
          parts: { content: true, theme: false },
          fetchImpl: fakeFetch({ '/v1/capabilities': CAPABILITIES, '/v1/content': [{ path, hasDraft: false }] }),
        }),
        (error: unknown) => error instanceof SiteSyncError && error.reason === 'unsafe-path',
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
        parts: { content: true, theme: false },
        fetchImpl: fakeFetch({
          '/v1/capabilities': CAPABILITIES,
          '/v1/content': [],
          '/v1/redirects': { schemaVersion: 1, entries: [] },
          '/v1/media': [{ name: '../evil.jpg', size: 1 }],
        }),
      }),
      (error: unknown) => error instanceof SiteSyncError && error.reason === 'unsafe-path',
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
        parts: { content: true, theme: false },
        fetchImpl: fakeFetch({ '/v1/capabilities': { agentVersion: '9.0.0', contentSchemaVersion: 99 } }),
      }),
      (error: unknown) => error instanceof SiteSyncError && error.reason === 'newer-schema',
    );
    await assert.rejects(
      pullSite(loadSiteConfig(localRoot), {
        siteUrl: 'http://live.test',
        token: 't',
        parts: { content: true, theme: false },
        fetchImpl: fakeFetch({ '/v1/capabilities': { hello: 'world' } }),
      }),
      (error: unknown) => error instanceof SiteSyncError && error.reason === 'not-a-site',
    );
  } finally {
    rmSync(localRoot, { recursive: true, force: true });
  }
});

// The real command, as a user runs it, with no token argument and none
// in the environment: it asks, and here the answer is piped in.
test('npm run pull asks for the token when none is given, and pulls with the answer', async () => {
  const live = await startLiveSite();
  const localRoot = createLocalSite();
  try {
    const cli = join(import.meta.dirname, '..', '..', 'src', 'site-sync', 'pull-cli.ts');
    const env = { ...process.env };
    delete env.CMS_TOKEN;
    const child = execFile(process.execPath, ['--experimental-strip-types', cli, live.url], {
      cwd: join(localRoot, 'vhost'),
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin?.end(`${TOKEN}\n`);
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

    assert.equal(code, 0, stderr);
    assert.match(stderr, new RegExp(`API token for ${live.url.replace(/[.]/g, '\\.')} \\(hidden\\): `));
    assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN), 'the token is never printed');
    assert.match(stdout, /Pulled from/);
    assert.deepEqual(readFileSync(join(localRoot, 'media', MEDIA_NAME)), MEDIA_BYTES);
  } finally {
    await live.app.close();
    rmSync(live.siteRoot, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
  }
});

test('npm run pull with no arguments asks for the address, then the token', async () => {
  const live = await startLiveSite();
  const localRoot = createLocalSite();
  try {
    const cli = join(import.meta.dirname, '..', '..', 'src', 'site-sync', 'pull-cli.ts');
    const env = { ...process.env };
    delete env.CMS_TOKEN;
    const child = execFile(process.execPath, ['--experimental-strip-types', cli], { cwd: join(localRoot, 'vhost'), env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    // Both answers in one write, as a pipe would deliver them.
    child.stdin?.end(`${live.url}\n${TOKEN}\n`);
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

    assert.equal(code, 0, stderr);
    assert.match(stderr, /Live site address: /);
    assert.match(stderr, /\(hidden\): /);
    assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN), 'the token is never printed');
    assert.deepEqual(readFileSync(join(localRoot, 'media', MEDIA_NAME)), MEDIA_BYTES);
  } finally {
    await live.app.close();
    rmSync(live.siteRoot, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
  }
});
