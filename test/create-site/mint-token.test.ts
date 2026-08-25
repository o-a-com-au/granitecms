import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldSite } from '../../src/create-site/generate-site.ts';
import { MintTokenError, mintToken, parseScopes } from '../../src/create-site/mint-token.ts';

function scaffoldedSite(): { siteDir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), 'mint-token-test-'));
  const siteDir = join(parent, 'site');
  scaffoldSite(siteDir);
  return { siteDir, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

function readConfig(siteDir: string): { tokens: Array<{ hash: string; scopes: string[] }> } {
  return JSON.parse(readFileSync(join(siteDir, 'vhost', 'site.config.json'), 'utf-8')) as ReturnType<typeof readConfig>;
}

test('mintToken appends a new token to an existing site without touching the scaffold token', () => {
  const { siteDir, cleanup } = scaffoldedSite();
  try {
    const before = readConfig(siteDir);
    assert.equal(before.tokens.length, 1);

    const { raw } = mintToken(siteDir, ['content']);

    const after = readConfig(siteDir);
    assert.equal(after.tokens.length, 2);
    assert.deepEqual(after.tokens[0], before.tokens[0]);
    assert.equal(after.tokens[1]?.hash, createHash('sha256').update(raw).digest('hex'));
    assert.deepEqual(after.tokens[1]?.scopes, ['content']);
  } finally {
    cleanup();
  }
});

test('mintToken commits the config change as a new commit, author matching the checkpoint identity', () => {
  const { siteDir, cleanup } = scaffoldedSite();
  try {
    mintToken(siteDir, ['content', 'theme', 'media']);

    const log = execFileSync('git', ['log', '--oneline'], { cwd: siteDir }).toString('utf-8').trim().split('\n');
    assert.equal(log.length, 2, 'the initial scaffold commit plus one new commit');

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: siteDir }).toString('utf-8').trim();
    assert.equal(status, '', 'nothing should be left uncommitted');
  } finally {
    cleanup();
  }
});

test('mintToken raises MintTokenError against a directory that is not a real site', () => {
  const parent = mkdtempSync(join(tmpdir(), 'mint-token-test-'));
  try {
    assert.throws(() => mintToken(parent, ['content']), (error: unknown) => error instanceof MintTokenError);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('parseScopes defaults to all three scopes when none are given', () => {
  assert.deepEqual(parseScopes(undefined), ['content', 'theme', 'media']);
});

test('parseScopes accepts a comma-separated list and rejects an unknown scope', () => {
  assert.deepEqual(parseScopes('content,theme'), ['content', 'theme']);
  assert.throws(() => parseScopes('content,bogus'), (error: unknown) => error instanceof MintTokenError);
});
