import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import { GitShowError, getCommitLog, readFileAtRevision } from '../../src/services/git-history.ts';
import { createTmpSiteRoot, writeAndCommit } from '../helpers/tmp-site.ts';

function commitFile(siteRoot: string, relativePath: string, content: string, message: string): void {
  writeAndCommit(siteRoot, relativePath, content, message);
}

test('G1: getCommitLog returns commit history with hash, author, date, and message', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    commitFile(siteRoot, 'content/pages/about.json', '{"a":1}', 'add about');
    const config = loadSiteConfig(siteRoot);

    const result = getCommitLog(config, {});

    assert.equal(result.commits.length, 1);
    assert.equal(result.hasMore, false);
    const [entry] = result.commits;
    assert.equal(entry?.message, 'add about');
    assert.equal(typeof entry?.hash, 'string');
    assert.equal(entry?.hash.length, 40);
    assert.match(entry?.date ?? '', /^\d{4}-\d{2}-\d{2}T/);
    // author.name/email come from the fixed test identity
    // (writeAndCommit's TEST_IDENTITY_ENV), not the request's own
    // author - proving getCommitLog reports whatever git actually
    // recorded, not a value it invents.
    assert.equal(entry?.author.name, 'Test Fixture');
    assert.equal(entry?.author.email, 'fixture@example.com');
  } finally {
    cleanup();
  }
});

test('a commit with an embedded multi-line message parses correctly, proving the delimiter strategy handles it', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    mkdirSync(join(siteRoot, 'content', 'pages'), { recursive: true });
    writeFileSync(join(siteRoot, 'content', 'pages', 'about.json'), '{"a":1}');
    execFileSync('git', ['add', '-A'], { cwd: siteRoot });
    execFileSync('git', ['commit', '-m', 'first line\n\nsecond paragraph\nthird line'], {
      cwd: siteRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Jane Editor',
        GIT_AUTHOR_EMAIL: 'jane@example.com',
        GIT_COMMITTER_NAME: 'Jane Editor',
        GIT_COMMITTER_EMAIL: 'jane@example.com',
      },
      stdio: 'ignore',
    });
    const config = loadSiteConfig(siteRoot);

    const result = getCommitLog(config, {});

    assert.equal(result.commits.length, 1);
    assert.equal(result.commits[0]?.message, 'first line\n\nsecond paragraph\nthird line');
  } finally {
    cleanup();
  }
});

test('G2: a commit whose message is exactly "chore: draft checkpoint" is flagged isCheckpoint, an ordinary message is not', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    commitFile(siteRoot, 'content/pages/about.json', '{"a":1}', 'add about');
    commitFile(siteRoot, 'content/drafts/pages/x.json', '{}', 'chore: draft checkpoint');
    const config = loadSiteConfig(siteRoot);

    const result = getCommitLog(config, {});

    const checkpoint = result.commits.find((c) => c.message === 'chore: draft checkpoint');
    const editorCommit = result.commits.find((c) => c.message === 'add about');
    assert.equal(checkpoint?.isCheckpoint, true);
    assert.equal(editorCommit?.isCheckpoint, false);
  } finally {
    cleanup();
  }
});

test('a migration-style "chore:" message that is not the exact checkpoint string is not flagged', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    commitFile(siteRoot, 'content/pages/about.json', '{"a":1}', 'chore: migrate content to schema version 4');
    const config = loadSiteConfig(siteRoot);

    const result = getCommitLog(config, {});

    assert.equal(result.commits[0]?.isCheckpoint, false);
  } finally {
    cleanup();
  }
});

test('getCommitLog on a HEAD-less repo (zero commits yet) returns an empty list, not an error', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    assert.deepEqual(getCommitLog(config, {}), { commits: [], hasMore: false });
  } finally {
    cleanup();
  }
});

test('getCommitLog filters by path: only commits touching that path are returned', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    commitFile(siteRoot, 'content/pages/about.json', '{"a":1}', 'add about');
    commitFile(siteRoot, 'content/pages/contact.json', '{"c":1}', 'add contact');
    commitFile(siteRoot, 'content/pages/about.json', '{"a":2}', 'update about');
    const config = loadSiteConfig(siteRoot);

    const result = getCommitLog(config, { path: 'content/pages/about.json' });

    assert.deepEqual(
      result.commits.map((c) => c.message),
      ['update about', 'add about'],
    );
  } finally {
    cleanup();
  }
});

test('getCommitLog respects limit and reports hasMore', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    for (let i = 0; i < 5; i++) {
      commitFile(siteRoot, 'content/pages/about.json', `{"n":${i}}`, `commit ${i}`);
    }
    const config = loadSiteConfig(siteRoot);

    const result = getCommitLog(config, { limit: 3 });

    assert.equal(result.commits.length, 3);
    assert.equal(result.hasMore, true);
    assert.deepEqual(
      result.commits.map((c) => c.message),
      ['commit 4', 'commit 3', 'commit 2'],
    );
  } finally {
    cleanup();
  }
});

test('G3: readFileAtRevision returns a file\'s content as it existed at a given revision', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    commitFile(siteRoot, 'content/pages/about.json', '{"title":"v1"}', 'v1');
    const firstHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot }).toString('utf-8').trim();
    commitFile(siteRoot, 'content/pages/about.json', '{"title":"v2"}', 'v2');
    const config = loadSiteConfig(siteRoot);

    const atV1 = readFileAtRevision(config, firstHash, 'content/pages/about.json');
    assert.equal(atV1.toString('utf-8'), '{"title":"v1"}');

    const atHead = readFileAtRevision(config, 'HEAD', 'content/pages/about.json');
    assert.equal(atHead.toString('utf-8'), '{"title":"v2"}');
  } finally {
    cleanup();
  }
});

test('readFileAtRevision can read a file that has since been deleted from the working tree', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    commitFile(siteRoot, 'content/pages/gone.json', '{"deleted":"later"}', 'add gone');
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot }).toString('utf-8').trim();
    rmSync(join(siteRoot, 'content', 'pages', 'gone.json'));
    execFileSync('git', ['add', '-A'], { cwd: siteRoot });
    execFileSync('git', ['commit', '-m', 'remove gone'], {
      cwd: siteRoot,
      env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x.com', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x.com' },
      stdio: 'ignore',
    });
    const config = loadSiteConfig(siteRoot);

    const content = readFileAtRevision(config, hash, 'content/pages/gone.json');
    assert.equal(content.toString('utf-8'), '{"deleted":"later"}');
  } finally {
    cleanup();
  }
});

test('readFileAtRevision throws not-found-at-ref for a directory path (not a file)', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    commitFile(siteRoot, 'content/pages/about.json', '{}', 'add about');
    const config = loadSiteConfig(siteRoot);

    assert.throws(
      () => readFileAtRevision(config, 'HEAD', 'content/pages'),
      (error: unknown) => error instanceof GitShowError && error.reason === 'not-found-at-ref',
    );
  } finally {
    cleanup();
  }
});

test('readFileAtRevision throws not-found-at-ref for a path that never existed at that ref', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    commitFile(siteRoot, 'content/pages/about.json', '{}', 'add about');
    const config = loadSiteConfig(siteRoot);

    assert.throws(
      () => readFileAtRevision(config, 'HEAD', 'content/pages/never-existed.json'),
      (error: unknown) => error instanceof GitShowError && error.reason === 'not-found-at-ref',
    );
  } finally {
    cleanup();
  }
});

test('readFileAtRevision throws invalid-ref for a malformed or nonexistent ref', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    commitFile(siteRoot, 'content/pages/about.json', '{}', 'add about');
    const config = loadSiteConfig(siteRoot);

    assert.throws(
      () => readFileAtRevision(config, '--upload-pack=/bin/sh', 'content/pages/about.json'),
      (error: unknown) => error instanceof GitShowError && error.reason === 'invalid-ref',
    );
    assert.throws(
      () => readFileAtRevision(config, 'not-a-real-ref', 'content/pages/about.json'),
      (error: unknown) => error instanceof GitShowError && error.reason === 'invalid-ref',
    );
  } finally {
    cleanup();
  }
});
