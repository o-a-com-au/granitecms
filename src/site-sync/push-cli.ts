#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadSiteConfig } from '../config.ts';
import { ask, parseSyncArgs, resolveToken, TOKEN_HELP } from './cli-helpers.ts';
import { normaliseSiteUrl } from './prompts.ts';
import { executePush, preparePush, type PushPlan } from './push-site.ts';
import { SiteSyncError } from './remote-site.ts';
import { readSyncRecord } from './sync-record.ts';

const args = parseSyncArgs(process.argv.slice(2));
const dryRun = args.flags.has('--dry-run');

// Run from vhost/ (the scaffold's own "push" script), so the site root
// is one level up - the same relationship check-site relies on.
const config = loadSiteConfig(resolve(process.cwd(), '..'));

function fail(message: string, ...more: string[]): never {
  console.error(message);
  for (const line of more) {
    console.error(line);
  }
  process.exit(1);
}

// Push only ever goes back to the site this copy was pulled from, so
// with no address given, that's the one.
const record = readSyncRecord(config);
const given = args.positional[0];
const siteUrl = given === undefined ? record?.siteUrl : normaliseSiteUrl(given);
if (!siteUrl) {
  fail(
    given === undefined
      ? 'This copy has never been pulled from a live site, so there is nothing to push back to. Run npm run pull first.'
      : `"${given}" is not a web address.`,
  );
}

function printPlan(plan: PushPlan): void {
  const labels = { create: 'new page ', update: 'update   ', delete: 'DELETE   ' } as const;
  for (const change of plan.changes) {
    console.error(`  ${labels[change.action]} content/${change.path}`);
  }
  for (const operation of plan.redirectOperations) {
    const { from, to } = operation.entry;
    const verb = { POST: 'add redirect   ', PUT: 'change redirect', DELETE: 'REMOVE redirect' }[operation.method];
    console.error(`  ${verb} ${from}${operation.method === 'DELETE' ? '' : ` -> ${to}`}`);
  }
  for (const name of plan.mediaToUpload) {
    console.error(`  upload    media/${name}`);
  }
}

try {
  const token = await resolveToken(args, siteUrl);
  console.error(`Comparing this copy with ${siteUrl}...`);
  const prepared = await preparePush(config, {
    siteUrl,
    token,
    onWait: (seconds) => console.error(`  The live site asked to slow down; waiting ${seconds}s...`),
  });
  const { plan } = prepared;

  if (plan.conflicts.length > 0 || plan.mediaMissing.length > 0) {
    console.error('Nothing was pushed.');
    if (plan.conflicts.length > 0) {
      console.error('\nThese were changed on the live site since your last pull, and pushing would overwrite that work:');
      for (const conflict of plan.conflicts) {
        console.error(`  content/${conflict.path}: ${conflict.reason}`);
      }
      console.error(
        '\nTo keep both: commit your work here, run npm run pull to bring in the live changes, reapply yours on top, then push again.',
      );
    }
    if (plan.mediaMissing.length > 0) {
      console.error('\nThese images are used by pages being pushed, but are missing here and on the live site:');
      for (const name of plan.mediaMissing) {
        console.error(`  media/${name}`);
      }
    }
    process.exit(1);
  }

  const total = plan.changes.length + plan.redirectOperations.length + plan.mediaToUpload.length;
  if (total === 0) {
    console.log('Nothing to push: the live site already has everything changed here since your last pull.');
    process.exit(0);
  }

  console.error(`\nThis will change the LIVE site at ${siteUrl}:\n`);
  printPlan(plan);
  if (dryRun) {
    console.log('\nDry run: nothing was pushed.');
    process.exit(0);
  }

  const host = new URL(siteUrl).host;
  const deletes = plan.changes.filter((change) => change.action === 'delete').length;
  console.error('\nWARNING: this overwrites the live website, straight away.');
  console.error('  - Every page listed is published as it is here, replacing what visitors see now.');
  if (deletes > 0) {
    console.error(`  - ${deletes} page${deletes === 1 ? ' is' : 's are'} deleted from the live site.`);
  }
  console.error('  - Pages changed on the live site since your last pull are left alone (none are listed above).');
  console.error('  - Earlier versions stay in each page\'s history in the admin, if you need to go back.\n');
  const typed = await ask(`Type ${host} to push, or anything else to cancel: `);
  if (typed.trim().toLowerCase() !== host.toLowerCase()) {
    fail('Cancelled. Nothing was pushed.');
  }

  const result = await executePush(prepared);
  console.log(`Pushed to ${siteUrl}:`);
  console.log(`  ${result.created} new, ${result.updated} updated, ${result.deleted} deleted`);
  console.log(`  ${result.redirects} redirect changes, ${result.mediaUploaded} images uploaded`);
} catch (error) {
  if (error instanceof SiteSyncError) {
    fail(error.message, ...(error.reason === 'unauthorised' ? [TOKEN_HELP] : []));
  }
  throw error;
}
