import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeAndCommit, writeJson } from '../helpers/tmp-site.ts';

const CONTENT_TOKEN = 'git-test-token';
const author = { name: 'Jane Editor', email: 'jane@example.com' };

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function page(title: string): object {
  return { schemaVersion: 4, title, type: 'page', layout: 'theme', published: true, sections: [] };
}

function buildGitTestServer() {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup };
}

test('G1: GET /v1/git/log returns commit history', async () => {
  const { app, siteRoot, cleanup } = buildGitTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About')), 'add about');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/git/log',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as { commits: Array<{ message: string }>; hasMore: boolean };
    assert.equal(body.commits.length, 1);
    assert.equal(body.commits[0]?.message, 'add about');
    assert.equal(body.hasMore, false);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/git/log rejects a non-integer limit with 400', async () => {
  const { app, cleanup } = buildGitTestServer();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/git/log?limit=not-a-number',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/git/log with no token is rejected with 401', async () => {
  const { app, cleanup } = buildGitTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/git/log' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

test('G3: GET /v1/git/show/:ref/*path returns a file as it existed at that revision', async () => {
  const { app, siteRoot, cleanup } = buildGitTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('V1')), 'v1');
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot }).toString('utf-8').trim();
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('V2')), 'v2');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/git/show/${hash}/content/pages/about.json`,
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(response.body), page('V1'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/git/show/:ref/*path returns 400 for an invalid ref', async () => {
  const { app, siteRoot, cleanup } = buildGitTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About')), 'add about');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/git/show/not-a-real-ref/content/pages/about.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/git/show/:ref/*path returns 404 for a path that never existed at a valid ref', async () => {
  const { app, siteRoot, cleanup } = buildGitTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About')), 'add about');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/git/show/HEAD/content/pages/never-existed.json',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt against GET /v1/git/show fails safely, never a 500', async () => {
  const { app, siteRoot, cleanup } = buildGitTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About')), 'add about');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/git/show/HEAD/..%2f..%2f..%2fetc%2fpasswd',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 404);
    assert.ok(!response.body.includes('root:'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /v1/git/show with no token is rejected with 401', async () => {
  const { app, cleanup } = buildGitTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/git/show/HEAD/content/pages/about.json' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

test('G4: POST /v1/git/revert restores a path from a given revision as one new commit', async () => {
  const { app, siteRoot, cleanup } = buildGitTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('V1')), 'v1');
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot }).toString('utf-8').trim();
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('V2')), 'v2');
    const config = bootSite(siteRoot).config;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/git/revert',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { ref: hash, paths: ['content/pages/about.json'], message: 'revert to v1', author },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(config.pagesRoot, 'about.json'), 'utf-8')), page('V1'));
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/git/revert rejects a malformed body with 400', async () => {
  const { app, cleanup } = buildGitTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/git/revert',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { ref: 'HEAD', paths: [], message: 'x', author },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/git/revert returns 400 for an invalid ref', async () => {
  const { app, siteRoot, cleanup } = buildGitTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About')), 'add about');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/git/revert',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { ref: '--upload-pack=/bin/sh', paths: ['content/pages/about.json'], message: 'x', author },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/git/revert returns 404 for a path absent at that revision', async () => {
  const { app, siteRoot, cleanup } = buildGitTestServer();
  try {
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About')), 'add about');
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: siteRoot }).toString('utf-8').trim();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/git/revert',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { ref: hash, paths: ['content/pages/never-existed.json'], message: 'x', author },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('a path traversal attempt against POST /v1/git/revert fails safely, never a 500', async () => {
  const { app, siteRoot, cleanup } = buildGitTestServer();
  try {
    // A real commit must exist first, or "HEAD" itself is an invalid
    // ref (no commits yet) and that 400 would mask the path-traversal
    // check this test actually targets.
    writeAndCommit(siteRoot, 'content/pages/about.json', JSON.stringify(page('About')), 'add about');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/git/revert',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { ref: 'HEAD', paths: ['../../../etc/passwd'], message: 'x', author },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/git/revert with no token is rejected with 401', async () => {
  const { app, cleanup } = buildGitTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/git/revert',
      headers: { 'content-type': 'application/json' },
      payload: { ref: 'HEAD', paths: ['content/pages/about.json'], message: 'x', author },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});

test('G5: POST /v1/git/commit commits a dirty working tree with the supplied author', async () => {
  const { app, siteRoot, cleanup } = buildGitTestServer();
  try {
    writeJson(siteRoot, 'content/pages/manual.json', page('Manual'));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/git/commit',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: 'manual fix', author },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as { ok: boolean; committed: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.committed, true);
    const log = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: siteRoot }).toString('utf-8').trim();
    assert.equal(log, 'manual fix');
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/git/commit on a clean working tree reports committed: false', async () => {
  const { app, siteRoot, cleanup } = buildGitTestServer();
  try {
    // buildGitTestServer's own site.config.json write is itself an
    // uncommitted file - it must be committed too, or the tree is
    // never actually clean and this test can't tell "clean" from
    // "committed" apart.
    execFileSync('git', ['add', '-A'], { cwd: siteRoot });
    execFileSync('git', ['commit', '-m', 'seed'], {
      cwd: siteRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'x',
        GIT_AUTHOR_EMAIL: 'x@x.com',
        GIT_COMMITTER_NAME: 'x',
        GIT_COMMITTER_EMAIL: 'x@x.com',
      },
      stdio: 'ignore',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/git/commit',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: 'no-op', author },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as { ok: boolean; committed: boolean };
    assert.equal(body.committed, false);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/git/commit rejects a malformed body with 400', async () => {
  const { app, cleanup } = buildGitTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/git/commit',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}`, 'content-type': 'application/json' },
      payload: { message: '' },
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /v1/git/commit with no token is rejected with 401', async () => {
  const { app, cleanup } = buildGitTestServer();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/git/commit',
      headers: { 'content-type': 'application/json' },
      payload: { message: 'x', author },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    cleanup();
  }
});
