import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import type { LiveContent } from '../../src/site-sync/live-content.ts';
import { pullSite } from '../../src/site-sync/pull-site.ts';
import { executePush, planPush, preparePush, type LocalContent } from '../../src/site-sync/push-site.ts';
import { SiteSyncError } from '../../src/site-sync/remote-site.ts';
import { hashOf, readSyncRecord, type ContentRecord } from '../../src/site-sync/sync-record.ts';
import { writeJson } from '../helpers/tmp-site.ts';
import { createLocalSite, git, startLiveSite, TOKEN } from './sync-helpers.ts';

// --- planPush: the rules, without a site ---

const page = (title: string) => Buffer.from(JSON.stringify({ schemaVersion: 7, title }));

function scenario({
  pulled = {},
  here = {},
  there = {},
  liveDrafts = [],
}: {
  pulled?: Record<string, string>;
  here?: Record<string, string>;
  there?: Record<string, string>;
  liveDrafts?: string[];
}) {
  const record: ContentRecord = {
    syncedAt: '',
    files: Object.fromEntries(Object.entries(pulled).map(([path, title]) => [path, hashOf(page(title))])),
    redirects: [],
  };
  const local: LocalContent = {
    files: new Map(Object.entries(here).map(([path, title]) => [path, page(title)])),
    redirects: [],
    mediaNames: new Set(),
  };
  const live: LiveContent = {
    live: new Map(Object.entries(there).map(([path, title]) => [path, { bytes: page(title), etag: `"${title}"` }])),
    drafts: new Map(liveDrafts.map((path) => [path, page('draft')])),
    redirects: [],
  };
  return planPush(record, local, live, new Set());
}

const P = 'pages/about.json';

test('planPush: nothing changed here means nothing pushed, even when the live site changed (their edit is kept)', () => {
  const plan = scenario({ pulled: { [P]: 'A' }, here: { [P]: 'A' }, there: { [P]: 'Live edit' } });
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.conflicts, []);
});

test('planPush: changed here only is an update; created here only is a create', () => {
  const plan = scenario({
    pulled: { [P]: 'A' },
    here: { [P]: 'Local edit', 'pages/new.json': 'New' },
    there: { [P]: 'A' },
  });
  assert.deepEqual(plan.changes, [
    { path: P, action: 'update' },
    { path: 'pages/new.json', action: 'create' },
  ]);
});

test('planPush: changed in both places is a conflict, never an overwrite - unless both made the same change', () => {
  assert.deepEqual(scenario({ pulled: { [P]: 'A' }, here: { [P]: 'Mine' }, there: { [P]: 'Theirs' } }).conflicts, [
    { path: P, reason: 'changed on the live site since your last pull' },
  ]);
  const same = scenario({ pulled: { [P]: 'A' }, here: { [P]: 'Same' }, there: { [P]: 'Same' } });
  assert.deepEqual([same.changes, same.conflicts], [[], []]);
});

test('planPush: only a page deleted here is deleted there; one created or edited live is never deleted', () => {
  assert.deepEqual(scenario({ pulled: { [P]: 'A' }, here: {}, there: { [P]: 'A' } }).changes, [{ path: P, action: 'delete' }]);
  // Created on the live site after the pull: not in the record, not here.
  assert.deepEqual(scenario({ pulled: {}, here: {}, there: { 'pages/theirs.json': 'Theirs' } }).changes, []);
  // Deleted here, but edited live since.
  assert.deepEqual(scenario({ pulled: { [P]: 'A' }, here: {}, there: { [P]: 'Edited' } }).conflicts, [
    { path: P, reason: 'changed on the live site since your last pull' },
  ]);
});

test('planPush: a page created in both places, or deleted live but changed here, is a conflict', () => {
  assert.deepEqual(scenario({ here: { [P]: 'Mine' }, there: { [P]: 'Theirs' } }).conflicts, [
    { path: P, reason: 'created on the live site since your last pull' },
  ]);
  assert.deepEqual(scenario({ pulled: { [P]: 'A' }, here: { [P]: 'Mine' }, there: {} }).conflicts, [
    { path: P, reason: 'deleted on the live site since your last pull' },
  ]);
});

test('planPush: a page with an unpublished draft on the live site is a conflict (writing it would replace the draft)', () => {
  assert.deepEqual(scenario({ pulled: { [P]: 'A' }, here: { [P]: 'Mine' }, there: { [P]: 'A' }, liveDrafts: [P] }).conflicts, [
    { path: P, reason: 'has unpublished draft changes on the live site' },
  ]);
});

test('planPush: formatting alone is not a change (the live site re-serialises what it is sent)', () => {
  const record: ContentRecord = { syncedAt: '', files: { [P]: hashOf(Buffer.from('{"a":1,"b":[2]}')) }, redirects: [] };
  const local: LocalContent = { files: new Map([[P, Buffer.from('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n')]]), redirects: [], mediaNames: new Set() };
  const live: LiveContent = { live: new Map([[P, { bytes: Buffer.from('{"a":1,"b":[2]}'), etag: '"e"' }]]), drafts: new Map(), redirects: [] };
  assert.deepEqual(planPush(record, local, live, new Set()).changes, []);
});

test('planPush: redirects are pushed as per-redirect operations, and conflict if both sides changed them', () => {
  const base = [{ from: '/a', to: '/x' }, { from: '/b', to: '/y' }];
  const record: ContentRecord = { syncedAt: '', files: {}, redirects: base };
  const local: LocalContent = { files: new Map(), redirects: [{ from: '/a', to: '/changed' }, { from: '/c', to: '/z' }], mediaNames: new Set() };
  const liveSame: LiveContent = { live: new Map(), drafts: new Map(), redirects: base };
  assert.deepEqual(planPush(record, local, liveSame, new Set()).redirectOperations, [
    { method: 'DELETE', entry: { from: '/b', to: '/y' } },
    { method: 'PUT', entry: { from: '/a', to: '/changed' } },
    { method: 'POST', entry: { from: '/c', to: '/z' } },
  ]);

  const liveChanged: LiveContent = { ...liveSame, redirects: [...base, { from: '/live', to: '/q' }] };
  const plan = planPush(record, local, liveChanged, new Set());
  assert.deepEqual(plan.redirectOperations, []);
  assert.deepEqual(plan.conflicts, [{ path: 'redirects.json', reason: 'redirects changed on the live site since your last pull' }]);
});

test('planPush: uploads only media the pushed pages use and the live site lacks; flags any missing here too', () => {
  const record: ContentRecord = { syncedAt: '', files: {}, redirects: [] };
  const body = Buffer.from(
    JSON.stringify({ a: '/media/have-111111111111.jpg', b: '/media/new-222222222222.jpg', c: '/media/gone-333333333333.jpg' }),
  );
  const local: LocalContent = {
    files: new Map([[P, body]]),
    redirects: [],
    mediaNames: new Set(['new-222222222222.jpg', 'unused-444444444444.jpg']),
  };
  const live: LiveContent = { live: new Map(), drafts: new Map(), redirects: [] };
  const plan = planPush(record, local, live, new Set(['have-111111111111.jpg']));
  assert.deepEqual(plan.mediaToUpload, ['new-222222222222.jpg']);
  assert.deepEqual(plan.mediaMissing, ['gone-333333333333.jpg']);
});

// --- For real: pull from a running site, change things here, push back ---

// Passes the live site's own content validation: a current-schema page
// with no sections.
function validPage(title: string): Record<string, unknown> {
  return { schemaVersion: 7, name: title, title, type: 'page', layout: 'theme', published: true, sections: [] };
}

async function pulledCopy() {
  const live = await startLiveSite();
  const localRoot = createLocalSite();
  git(localRoot, ['config', 'user.name', 'Local Developer']);
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

test('a real push: creates, updates, deletes, a redirect and an image reach the live site as one commit, and a second push finds nothing', async () => {
  const { live, localRoot, config, cleanup } = await pulledCopy();
  try {
    // The image's name must be what the site itself would call it.
    const imageBytes = Buffer.from('an image, as far as this test is concerned');
    const imageName = `hero-${createHash('sha256').update(imageBytes).digest('hex').slice(0, 12)}.jpg`;
    writeFileSync(join(localRoot, 'media', imageName), imageBytes);

    writeJson(localRoot, 'content/pages/about.json', validPage('About, edited locally'));
    // Push finds the images a page uses by the /media/ paths in its text,
    // wherever they appear. The fixture theme has no usable image
    // setting, so a tag carries the reference here.
    writeJson(localRoot, 'content/pages/new-page.json', { ...validPage('New page'), tags: [`/media/${imageName}`] });
    rmSync(join(localRoot, 'content/pages/hidden.json'));
    writeJson(localRoot, 'content/redirects.json', { schemaVersion: 1, entries: [{ from: '/old', to: '/about' }, { from: '/new', to: '/new-page' }] });

    const liveCommitsBefore = Number(git(live.siteRoot, ['rev-list', '--count', 'HEAD']).trim());
    const prepared = await preparePush(config, { siteUrl: live.url, token: TOKEN });
    assert.ok(prepared.content.ready);
    const plan = prepared.content.value.plan;
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.changes, [
      { path: 'pages/about.json', action: 'update' },
      { path: 'pages/hidden.json', action: 'delete' },
      { path: 'pages/new-page.json', action: 'create' },
    ]);
    assert.deepEqual(plan.mediaToUpload, [imageName]);

    const result = await executePush(prepared, { content: true, theme: false });
    assert.deepEqual(result.content, { created: 1, updated: 1, deleted: 1, redirects: 1, mediaUploaded: 1 });

    const liveJson = (path: string) => JSON.parse(readFileSync(join(live.siteRoot, 'content', path), 'utf-8')) as { title: string };
    assert.equal(liveJson('pages/about.json').title, 'About, edited locally');
    assert.equal(liveJson('pages/new-page.json').title, 'New page');
    assert.equal(existsSync(join(live.siteRoot, 'content/pages/hidden.json')), false);
    assert.deepEqual(readFileSync(join(live.siteRoot, 'media', imageName)), imageBytes, 'stored under exactly the local name');
    assert.equal(existsSync(join(live.siteRoot, 'content/drafts/pages/about.json')), false, 'published, no draft left');
    // All page changes in one commit, then one for the redirect - by whoever pushed.
    const log = git(live.siteRoot, ['log', '--format=%an|%s']).trim().split('\n');
    assert.equal(log.length, liveCommitsBefore + 2);
    assert.equal(log[1], 'Local Developer|Push 3 changes from a local copy');
    assert.match(log[0] as string, /^Local Developer\|Add redirect \/new/);

    const again = await preparePush(config, { siteUrl: live.url, token: TOKEN });
    assert.ok(again.content.ready);
    const againPlan = again.content.value.plan;
    assert.deepEqual([againPlan.changes, againPlan.redirectOperations, againPlan.mediaToUpload], [[], [], []]);
  } finally {
    await cleanup();
  }
});

test('a real push refuses a page an editor changed on the live site since the pull, and changes nothing there', async () => {
  const { live, localRoot, config, cleanup } = await pulledCopy();
  try {
    // An editor's change, straight onto the live site's disk (the site
    // reads content fresh on every request).
    writeJson(live.siteRoot, 'content/pages/about.json', validPage('Edited by an editor on the live site'));
    writeJson(localRoot, 'content/pages/about.json', validPage('Edited locally'));
    writeJson(localRoot, 'content/pages/unrelated.json', validPage('Unrelated local page'));

    const prepared = await preparePush(config, { siteUrl: live.url, token: TOKEN });
    assert.ok(prepared.content.ready);
    assert.deepEqual(prepared.content.value.plan.conflicts, [{ path: 'pages/about.json', reason: 'changed on the live site since your last pull' }]);
    await assert.rejects(executePush(prepared, { content: true, theme: false }), (error: unknown) => error instanceof SiteSyncError && error.reason === 'conflicts');
    assert.equal(
      (JSON.parse(readFileSync(join(live.siteRoot, 'content/pages/about.json'), 'utf-8')) as { title: string }).title,
      'Edited by an editor on the live site',
    );
    assert.equal(existsSync(join(live.siteRoot, 'content/pages/unrelated.json')), false, 'nothing at all is pushed while any conflict remains');
  } finally {
    await cleanup();
  }
});

test('a first push (never pulled) lists every local difference as a create or update, deletes nothing, and records the live site', async () => {
  const live = await startLiveSite();
  const localRoot = createLocalSite();
  try {
    git(localRoot, ['config', 'user.name', 'First Pusher']);
    git(localRoot, ['config', 'user.email', 'first@example.com']);
    // This copy has the fixture's theme but none of its pages: only
    // local-only.json, plus a local-only redirect.
    writeJson(localRoot, 'content/pages/local-only.json', validPage('Local only'));
    writeJson(localRoot, 'content/redirects.json', { schemaVersion: 1, entries: [{ from: '/local', to: '/local-only' }] });
    const config = loadSiteConfig(localRoot);
    assert.equal(readSyncRecord(config), null);

    const prepared = await preparePush(config, { siteUrl: live.url, token: TOKEN });
    assert.ok(prepared.content.ready);
    const { plan, firstPush } = prepared.content.value;
    assert.equal(firstPush, true);
    // The live site's own pages aren't here, but are never deleted on a first push.
    assert.deepEqual(plan.changes, [{ path: 'pages/local-only.json', action: 'create' }]);
    assert.deepEqual(plan.conflicts, []);
    // The live /old redirect isn't here either: added to, never removed.
    assert.deepEqual(plan.redirectOperations, [{ method: 'POST', entry: { from: '/local', to: '/local-only' } }]);

    await executePush(prepared, { content: true, theme: false });
    assert.ok(existsSync(join(live.siteRoot, 'content/pages/about.json')), 'live pages untouched');
    assert.ok(existsSync(join(live.siteRoot, 'content/pages/local-only.json')));

    // Now recorded: the next push is the normal, protected kind, and finds nothing.
    const record = readSyncRecord(config);
    const again = await preparePush(config, { siteUrl: live.url, token: TOKEN });
    assert.ok(again.content.ready);
    assert.equal(again.content.value.firstPush, false);
    // Live pages this copy never had are not recorded, so they are
    // never read as deleted here - the next push leaves them alone.
    assert.deepEqual(again.content.value.plan.changes, []);
    assert.deepEqual(again.content.value.plan.redirectOperations, []);
    assert.equal(record?.content?.files['pages/about.json'], undefined);
    assert.ok(record?.content?.files['pages/local-only.json']);
  } finally {
    await live.app.close();
    rmSync(live.siteRoot, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
  }
});

test('push refuses to go to a different site than the one this copy was pulled from', async () => {
  const live = await startLiveSite();
  const localRoot = createLocalSite();
  try {
    const config = loadSiteConfig(localRoot);
    await pullSite(config, { siteUrl: live.url, token: TOKEN, parts: { content: true, theme: true } });
    await assert.rejects(
      preparePush(config, { siteUrl: 'https://another-site.example', token: TOKEN }),
      (error: unknown) => error instanceof SiteSyncError && error.reason === 'different-site',
    );
  } finally {
    await live.app.close();
    rmSync(live.siteRoot, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
  }
});

// --- The command, as run: answers piped in ---

function runPush(localRoot: string, args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cli = join(import.meta.dirname, '..', '..', 'src', 'site-sync', 'push-cli.ts');
  const env = { ...process.env };
  delete env.CMS_TOKEN;
  const child = execFile(process.execPath, ['--experimental-strip-types', cli, ...args], { cwd: join(localRoot, 'vhost'), env });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin?.end(input);
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr })));
}

test('npm run push: shows what will change and warns, pushes nothing on a wrong confirmation or --dry-run, and pushes on the right one', async () => {
  const { live, localRoot, cleanup } = await pulledCopy();
  try {
    writeJson(localRoot, 'content/pages/about.json', validPage('Pushed from the command'));
    const host = new URL(live.url).host;
    const liveTitle = () => (JSON.parse(readFileSync(join(live.siteRoot, 'content/pages/about.json'), 'utf-8')) as { title: string }).title;
    const before = liveTitle();

    const dry = await runPush(localRoot, ['--dry-run'], `${TOKEN}\n\n`);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stderr, /update\s+content\/pages\/about\.json/);
    assert.match(dry.stdout, /Dry run: nothing was pushed/);
    assert.equal(liveTitle(), before);

    const wrong = await runPush(localRoot, [], `${TOKEN}\n\nnot-the-host\n`);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /WARNING: this overwrites the live website/);
    assert.match(wrong.stderr, /Cancelled\. Nothing was pushed\./);
    assert.equal(liveTitle(), before);

    const right = await runPush(localRoot, [], `${TOKEN}\n\n${host}\n`);
    assert.equal(right.code, 0, right.stderr);
    assert.match(right.stdout, /Pushed to .*\n\s+content: 0 new, 1 updated, 0 deleted/);
    assert.equal(liveTitle(), 'Pushed from the command');
    assert.ok(!right.stdout.includes(TOKEN) && !right.stderr.includes(TOKEN), 'the token is never printed');
  } finally {
    await cleanup();
  }
});
