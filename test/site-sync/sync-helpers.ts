import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { TEST_IDENTITY_ENV, writeJson } from '../helpers/tmp-site.ts';

export const FIXTURE_SITE = join(import.meta.dirname, '..', 'fixtures', 'site');
export const TOKEN = 'pull-site-test-token';
export const MEDIA_NAME = 'photo-1a2b3c4d5e6f.jpg';
export const MEDIA_BYTES = Buffer.from('not really a jpeg, but bytes are bytes');

export function git(siteRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: siteRoot, env: { ...process.env, ...TEST_IDENTITY_ENV } }).toString('utf-8');
}

// A real running site: the fixture (pages, a menu, a draft-only page),
// a redirect, a media file, and a token with content, media and theme
// scopes.
// With `siteRoot`, starts (restarts) an existing test site instead.
export async function startLiveSite(
  existing: { siteRoot?: string } = {},
): Promise<{ app: FastifyInstance; url: string; siteRoot: string }> {
  const siteRoot = existing.siteRoot ?? setUpLiveSite();
  const app = buildServer(bootSite(siteRoot), loadServerConfig(siteRoot), { logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a port');
  }
  return { app, url: `http://127.0.0.1:${address.port}`, siteRoot };
}

function setUpLiveSite(): string {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-pull-live-'));
  cpSync(FIXTURE_SITE, siteRoot, { recursive: true });
  git(siteRoot, ['init', '--quiet']);
  writeJson(siteRoot, 'vhost/site.config.json', {
    tokens: [{ hash: createHash('sha256').update(TOKEN).digest('hex'), scopes: ['content', 'media', 'theme'] }],
  });
  writeJson(siteRoot, 'content/redirects.json', { schemaVersion: 1, entries: [{ from: '/old', to: '/about' }] });
  // Site settings the theme defines, none saved yet.
  writeJson(siteRoot, 'theme/config/settings_schema.json', {
    type: 'object',
    additionalProperties: false,
    properties: { announcement: { type: 'string', default: '' } },
  });
  mkdirSync(join(siteRoot, 'media'), { recursive: true });
  writeFileSync(join(siteRoot, 'media', MEDIA_NAME), MEDIA_BYTES);
  // Committed, as a real site's content always is: every live page got
  // there through a publish commit. (A push that deletes a page records
  // that deletion in git, which needs the page to have been tracked.)
  git(siteRoot, ['add', '-A']);
  git(siteRoot, ['commit', '--quiet', '-m', 'live site']);
  return siteRoot;
}

// The local copy: a committed git repo with its own theme, one page the
// live site doesn't have, and a stale draft.
export function createLocalSite(): string {
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

