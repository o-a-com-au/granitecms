import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { pullSite } from '../../src/site-sync/pull-site.ts';
import { executePush, preparePush } from '../../src/site-sync/push-site.ts';
import { SiteSyncError } from '../../src/site-sync/remote-site.ts';
import { readSyncRecord } from '../../src/site-sync/sync-record.ts';
import { writeJson } from '../helpers/tmp-site.ts';
import { createLocalSite, git, startLiveSite, TOKEN } from './sync-helpers.ts';

const LAYOUT = 'layouts/theme.liquid';

function writeTheme(siteRoot: string, path: string, text: string): void {
  const full = join(siteRoot, 'theme', path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

async function pulledSite() {
  const live = await startLiveSite();
  const localRoot = createLocalSite();
  git(localRoot, ['config', 'user.name', 'Theme Developer']);
  git(localRoot, ['config', 'user.email', 'dev@example.com']);
  const config = loadSiteConfig(localRoot);
  await pullSite(config, { siteUrl: live.url, token: TOKEN, parts: { content: true, theme: true } });
  git(localRoot, ['add', '-A']);
  git(localRoot, ['commit', '--quiet', '-m', 'pulled']);
  return {
    live,
    localRoot,
    config,
    cleanup: async () => {
      await live.app.close();
      rmSync(live.siteRoot, { recursive: true, force: true });
      rmSync(localRoot, { recursive: true, force: true });
    },
  };
}

test('pulling the theme mirrors theme/ from the live site, and records it', async () => {
  const live = await startLiveSite();
  const localRoot = createLocalSite();
  try {
    writeTheme(live.siteRoot, 'snippets/live-only.liquid', 'live');
    git(live.siteRoot, ['add', '-A']);
    git(live.siteRoot, ['commit', '--quiet', '-m', 'live snippet']);
    writeTheme(localRoot, 'snippets/local-only.liquid', 'local');
    git(localRoot, ['add', '-A']);
    git(localRoot, ['commit', '--quiet', '-m', 'local snippet']);

    const config = loadSiteConfig(localRoot);
    const result = await pullSite(config, { siteUrl: live.url, token: TOKEN, parts: { content: false, theme: true } });

    assert.equal(readFileSync(join(localRoot, 'theme/snippets/live-only.liquid'), 'utf-8'), 'live');
    assert.equal(existsSync(join(localRoot, 'theme/snippets/local-only.liquid')), false);
    assert.deepEqual(result.theme?.removed, ['snippets/local-only.liquid']);
    assert.equal(result.content, undefined, 'content was not chosen, so not pulled');
    assert.ok(readSyncRecord(config)?.theme?.files[LAYOUT]);
  } finally {
    await live.app.close();
    rmSync(live.siteRoot, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
  }
});

test('pushing the theme: the live site shows it on the next request, as one commit, and a second push finds nothing', async () => {
  const { live, localRoot, config, cleanup } = await pulledSite();
  try {
    const layout = readFileSync(join(localRoot, 'theme', LAYOUT), 'utf-8');
    writeTheme(localRoot, LAYOUT, layout.replace('<body>', '<body><p>From a theme push</p>'));
    writeTheme(localRoot, 'snippets/new.liquid', '<b>new</b>');
    rmSync(join(localRoot, 'theme/assets/style.css'));
    const commitsBefore = Number(git(live.siteRoot, ['rev-list', '--count', 'HEAD']).trim());

    const prepared = await preparePush(config, { siteUrl: live.url, token: TOKEN });
    assert.ok(prepared.theme.ready);
    assert.deepEqual(prepared.theme.value.plan.changes, [
      { path: 'assets/style.css', action: 'delete' },
      { path: LAYOUT, action: 'update' },
      { path: 'snippets/new.liquid', action: 'create' },
    ]);
    const result = await executePush(prepared, { content: false, theme: true });
    assert.equal(result.theme?.files, 3);

    const page = await fetch(new URL('/about', live.url));
    assert.match(await page.text(), /From a theme push/);
    assert.equal(existsSync(join(live.siteRoot, 'theme/assets/style.css')), false);
    assert.equal(Number(git(live.siteRoot, ['rev-list', '--count', 'HEAD']).trim()), commitsBefore + 1);
    assert.equal(git(live.siteRoot, ['log', '-1', '--format=%an']).trim(), 'Theme Developer');

    const again = await preparePush(config, { siteUrl: live.url, token: TOKEN });
    assert.ok(again.theme.ready);
    assert.deepEqual(again.theme.value.plan.changes, []);
  } finally {
    await cleanup();
  }
});

test('a theme file changed on the live site since the pull is a conflict, and nothing is pushed', async () => {
  const { live, localRoot, config, cleanup } = await pulledSite();
  try {
    writeTheme(live.siteRoot, LAYOUT, '<html><body>Edited on the live site {{ content_for_layout | raw }}</body></html>');
    writeTheme(localRoot, LAYOUT, '<html><body>Edited here {{ content_for_layout | raw }}</body></html>');
    writeTheme(localRoot, 'snippets/unrelated.liquid', 'x');

    const prepared = await preparePush(config, { siteUrl: live.url, token: TOKEN });
    assert.ok(prepared.theme.ready);
    assert.deepEqual(prepared.theme.value.plan.conflicts, [{ path: LAYOUT, reason: 'changed on the live site since your last pull' }]);
    await assert.rejects(
      executePush(prepared, { content: false, theme: true }),
      (error: unknown) => error instanceof SiteSyncError && error.reason === 'conflicts',
    );
    assert.match(readFileSync(join(live.siteRoot, 'theme', LAYOUT), 'utf-8'), /Edited on the live site/);
    assert.equal(existsSync(join(live.siteRoot, 'theme/snippets/unrelated.liquid')), false);
  } finally {
    await cleanup();
  }
});

test('the theme goes first: a page using a section type only the pushed theme defines is accepted in the same push', async () => {
  const { live, localRoot, config, cleanup } = await pulledSite();
  try {
    writeTheme(
      localRoot,
      'sections/note.liquid',
      '<p class="note">{{ section.settings.text }}</p>\n{% schema %}\n{"title":"Note","type":"object","additionalProperties":false,"properties":{"text":{"type":"string"}}}\n{% endschema %}\n',
    );
    writeJson(localRoot, 'content/pages/with-note.json', {
      schemaVersion: 7,
      name: 'With note',
      title: 'With note',
      type: 'page',
      layout: 'theme',
      published: true,
      sections: [{ id: 'sec-1', type: 'note', settings: { text: 'Hello from a new section' }, blocks: [] }],
    });

    const prepared = await preparePush(config, { siteUrl: live.url, token: TOKEN });
    await executePush(prepared, { content: true, theme: true });

    const page = await fetch(new URL('/with-note', live.url));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<p class="note">Hello from a new section<\/p>/);
  } finally {
    await cleanup();
  }
});

test('without the theme scope, the theme is simply unavailable - content still pushes', async () => {
  const live = await startLiveSite();
  const localRoot = createLocalSite();
  try {
    const contentOnly = 'content-only-token';
    writeJson(live.siteRoot, 'vhost/site.config.json', {
      tokens: [
        { hash: createHash('sha256').update(TOKEN).digest('hex'), scopes: ['content', 'media', 'theme'] },
        { hash: createHash('sha256').update(contentOnly).digest('hex'), scopes: ['content', 'media'] },
      ],
    });
    // Tokens are read at start-up, so the site restarts with the new list.
    await live.app.close();
    const restarted = await startLiveSite({ siteRoot: live.siteRoot });
    try {
      git(localRoot, ['config', 'user.name', 'Dev']);
      git(localRoot, ['config', 'user.email', 'dev@example.com']);
      const config = loadSiteConfig(localRoot);
      await pullSite(config, { siteUrl: restarted.url, token: TOKEN, parts: { content: true, theme: true } });
      await assert.rejects(
        pullSite(config, { siteUrl: restarted.url, token: contentOnly, force: true, parts: { content: false, theme: true } }),
        (error: unknown) => error instanceof SiteSyncError && error.reason === 'unauthorised',
      );
      const prepared = await preparePush(config, { siteUrl: restarted.url, token: contentOnly });
      assert.deepEqual(prepared.theme, { ready: false, reason: 'the token doesn\'t have the "theme" scope' });
      assert.ok(prepared.content.ready);
    } finally {
      await restarted.app.close();
    }
  } finally {
    rmSync(live.siteRoot, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
  }
});

test('a live site on a CMS without theme endpoints makes the theme unavailable, not the whole sync', async () => {
  const { fetchLiveTheme } = await import('../../src/site-sync/theme-sync.ts');
  const { RemoteSite } = await import('../../src/site-sync/remote-site.ts');
  const olderSite = (async () => new Response('{"message":"Not Found"}', { status: 404 })) as typeof fetch;
  assert.deepEqual(await fetchLiveTheme(new RemoteSite('https://older.example', 't', { fetchImpl: olderSite })), {
    unavailable: 'the live site\'s CMS is too old to sync its theme; upgrade it first',
  });
});

test('a first theme push (never pulled) sends local changes, never deletes a live-only file, and leaves it unrecorded', async () => {
  const live = await startLiveSite();
  const localRoot = createLocalSite();
  try {
    git(localRoot, ['config', 'user.name', 'Dev']);
    git(localRoot, ['config', 'user.email', 'dev@example.com']);
    writeTheme(live.siteRoot, 'snippets/live-only.liquid', 'made on the live site');
    git(live.siteRoot, ['add', '-A']);
    git(live.siteRoot, ['commit', '--quiet', '-m', 'live-only snippet']);
    const layout = readFileSync(join(localRoot, 'theme', LAYOUT), 'utf-8');
    writeTheme(localRoot, LAYOUT, layout.replace('<body>', '<body><p>First theme push</p>'));
    const config = loadSiteConfig(localRoot);

    const prepared = await preparePush(config, { siteUrl: live.url, token: TOKEN });
    assert.ok(prepared.theme.ready);
    assert.equal(prepared.theme.value.firstPush, true);
    assert.deepEqual(prepared.theme.value.plan.changes, [{ path: LAYOUT, action: 'update' }]);

    await executePush(prepared, { content: false, theme: true });
    assert.match(readFileSync(join(live.siteRoot, 'theme', LAYOUT), 'utf-8'), /First theme push/);
    assert.ok(existsSync(join(live.siteRoot, 'theme/snippets/live-only.liquid')));
    assert.equal(readSyncRecord(config)?.theme?.files['snippets/live-only.liquid'], undefined);

    const again = await preparePush(config, { siteUrl: live.url, token: TOKEN });
    assert.ok(again.theme.ready);
    assert.deepEqual(again.theme.value.plan.changes, [], 'the live-only snippet is still left alone');
  } finally {
    await live.app.close();
    rmSync(live.siteRoot, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
  }
});
