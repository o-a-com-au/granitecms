#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadSiteConfig } from '../config.ts';
import { ask, parseSyncArgs, resolveToken, TOKEN_HELP } from './cli-helpers.ts';
import { normaliseSiteUrl } from './prompts.ts';
import { checkPullableSite, pullSite } from './pull-site.ts';
import { SiteSyncError } from './remote-site.ts';

const args = parseSyncArgs(process.argv.slice(2));
const force = args.flags.has('--force');

const givenUrl = args.positional[0] ?? (await ask('Live site address: '));
const siteUrl = normaliseSiteUrl(givenUrl);
if (!siteUrl) {
  console.error(givenUrl.trim() === '' ? 'No address entered.' : `"${givenUrl}" is not a web address.`);
  console.error('Usage: npm run pull [-- <live-site-address>] [--force]');
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

try {
  const result = await pullSite(config, { siteUrl, token, force });
  console.log(`Pulled from ${siteUrl}:`);
  console.log(`  ${result.pages} pages, ${result.menus} menus, ${result.drafts} drafts, ${result.redirects} redirects`);
  console.log(`  media: ${result.mediaDownloaded} downloaded, ${result.mediaAlreadyPresent} already here`);
  if (result.removed.length > 0) {
    console.log(`  removed ${result.removed.length} local files the live site doesn't have:`);
    for (const path of result.removed) {
      console.log(`    content/${path}`);
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
