#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadSiteConfig } from '../config.ts';
import { ask, chooseParts, parseSyncArgs, resolveToken, TOKEN_HELP } from './cli-helpers.ts';
import { normaliseSiteUrl } from './prompts.ts';
import { checkPullableSite, pullSite } from './pull-site.ts';
import { RemoteSite, SiteSyncError } from './remote-site.ts';
import { fetchLiveTheme } from './theme-sync.ts';

const args = parseSyncArgs(process.argv.slice(2));
const force = args.flags.has('--force');

const givenUrl = args.positional[0] ?? (await ask('Live site address: '));
const siteUrl = normaliseSiteUrl(givenUrl);
if (!siteUrl) {
  console.error(givenUrl.trim() === '' ? 'No address entered.' : `"${givenUrl}" is not a web address.`);
  console.error('Usage: npm run pull [-- <live-site-address>] [--content] [--theme] [--force]');
  process.exit(1);
}

// Checked before asking for the token, so a mistyped address is found
// out without typing a token for nothing.
try {
  await checkPullableSite(siteUrl);
} catch (error) {
  if (error instanceof SiteSyncError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const token = await resolveToken(args, siteUrl);

// Run from vhost/ (the scaffold's own "pull" script), so the site root
// is one level up - the same relationship check-site relies on.
const config = loadSiteConfig(resolve(process.cwd(), '..'));

// Asked before anything is changed: the theme needs a token with the
// "theme" scope, found out here with one read rather than part way in.
const liveTheme = await fetchLiveTheme(new RemoteSite(siteUrl, token)).catch(
  (error: unknown) => ({ unavailable: error instanceof Error ? error.message : String(error) }),
);
const parts = await chooseParts(args, 'pull', {
  content: { available: true, detail: 'pages, menus, redirects, images', checked: true },
  theme:
    'theme' in liveTheme
      ? { available: true, detail: 'templates, styles, scripts', checked: true }
      : { available: false, detail: liveTheme.unavailable, checked: false },
});
if (!parts.content && !parts.theme) {
  console.error('Nothing chosen. Nothing was pulled.');
  process.exit(0);
}

try {
  const result = await pullSite(config, { siteUrl, token, force, parts });
  console.log(`Pulled from ${siteUrl}:`);
  if (result.theme) {
    console.log(`  theme: ${result.theme.files} files, ${result.theme.downloaded} downloaded`);
    for (const path of result.theme.removed) {
      console.log(`    removed theme/${path} (not on the live site)`);
    }
  }
  if (result.content) {
    const content = result.content;
    console.log(`  content: ${content.pages} pages, ${content.menus} menus, ${content.drafts} drafts, ${content.redirects} redirects`);
    console.log(`  images: ${content.mediaDownloaded} downloaded, ${content.mediaAlreadyPresent} already here`);
    for (const path of content.removed) {
      console.log(`    removed content/${path} (not on the live site)`);
    }
  }
  console.log('Nothing was committed. Review the changes with "git status" and "git diff" from the site folder.');
} catch (error) {
  if (error instanceof SiteSyncError) {
    console.error(error.message);
    if (error.reason === 'unauthorised') {
      console.error(TOKEN_HELP);
    }
    process.exit(1);
  }
  throw error;
}
