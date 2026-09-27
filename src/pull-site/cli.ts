#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadSiteConfig } from '../config.ts';
import { PromptCancelledError, promptHidden } from './prompt-token.ts';
import { PullSiteError, pullSite } from './pull-site.ts';

const USAGE = 'Usage: npm run pull -- <live-site-url> [--force]';

const args = process.argv.slice(2);
const force = args.includes('--force');
const tokenFlag = args.indexOf('--token');
const flagToken = tokenFlag === -1 ? undefined : args[tokenFlag + 1];
const positional = args.filter((arg, index) => !arg.startsWith('--') && (tokenFlag === -1 || index !== tokenFlag + 1));
const siteUrl = positional[0];
const TOKEN_HELP = 'The token is the live site\'s API token (the same one the admin uses), with the "content" and "media" scopes.';

if (!siteUrl) {
  console.error(USAGE);
  console.error(TOKEN_HELP);
  process.exit(1);
}

// Asked for when not given, without showing it: CMS_TOKEN and --token
// still work (for scripts), but either leaves the token in shell
// history. Piped input works too - the first line is the token.
let token = flagToken ?? process.env.CMS_TOKEN;
if (!token) {
  try {
    token = await promptHidden(`API token for ${siteUrl} (hidden): `, process.stdin, process.stderr);
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      process.exit(130);
    }
    throw error;
  }
}
if (!token) {
  console.error('No token entered.');
  console.error(TOKEN_HELP);
  process.exit(1);
}

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
  if (error instanceof PullSiteError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
