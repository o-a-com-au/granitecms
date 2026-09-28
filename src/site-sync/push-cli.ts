#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadSiteConfig } from '../config.ts';
import { ask, chooseParts, parseSyncArgs, resolveToken, TOKEN_HELP } from './cli-helpers.ts';
import { normaliseSiteUrl } from './prompts.ts';
import { executePush, preparePush, type PushPlan } from './push-site.ts';
import type { ThemePlan } from './theme-sync.ts';
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

function printContentPlan(plan: PushPlan): void {
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

function printThemePlan(plan: ThemePlan): void {
  const labels = { create: 'new file ', update: 'update   ', delete: 'DELETE   ' } as const;
  for (const change of plan.changes) {
    console.error(`  ${labels[change.action]} theme/${change.path}`);
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function contentCount(plan: PushPlan): number {
  return plan.changes.length + plan.redirectOperations.length + plan.mediaToUpload.length;
}

function reportConflicts(conflicts: Array<{ path: string; reason: string }>, folder: string): void {
  for (const conflict of conflicts) {
    const path = conflict.path === 'redirects.json' ? 'content/redirects.json' : `${folder}/${conflict.path}`;
    console.error(`  ${path}: ${conflict.reason}`);
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

  const content = prepared.content.ready ? prepared.content.value : null;
  const theme = prepared.theme.ready ? prepared.theme.value : null;
  const contentChanges = content ? contentCount(content.plan) : 0;
  const themeChanges = theme ? theme.plan.changes.length : 0;

  const parts = await chooseParts(args, 'push', {
    content: content
      ? {
          available: true,
          detail: content.plan.conflicts.length > 0 ? plural(content.plan.conflicts.length, 'conflict') : contentChanges > 0 ? `${plural(contentChanges, 'change')}` : 'no changes',
          checked: contentChanges > 0 || content.plan.conflicts.length > 0,
        }
      : { available: false, detail: (prepared.content as { reason: string }).reason, checked: false },
    theme: theme
      ? {
          available: true,
          detail: theme.plan.conflicts.length > 0 ? plural(theme.plan.conflicts.length, 'conflict') : themeChanges > 0 ? `${plural(themeChanges, 'file')} changed` : 'no changes',
          checked: themeChanges > 0 || theme.plan.conflicts.length > 0,
        }
      : { available: false, detail: (prepared.theme as { reason: string }).reason, checked: false },
  });
  const pushContent = parts.content && content !== null;
  const pushTheme = parts.theme && theme !== null;
  if (!pushContent && !pushTheme) {
    console.log('Nothing chosen. Nothing was pushed.');
    process.exit(0);
  }

  const contentConflicts = pushContent ? content.plan.conflicts : [];
  const themeConflicts = pushTheme ? theme.plan.conflicts : [];
  const mediaMissing = pushContent ? content.plan.mediaMissing : [];
  if (contentConflicts.length > 0 || themeConflicts.length > 0 || mediaMissing.length > 0) {
    console.error('Nothing was pushed.');
    if (contentConflicts.length > 0 || themeConflicts.length > 0) {
      console.error('\nThese were changed on the live site since your last pull, and pushing would overwrite that work:');
      reportConflicts(themeConflicts, 'theme');
      reportConflicts(contentConflicts, 'content');
      console.error(
        '\nTo keep both: commit your work here, run npm run pull to bring in the live changes, reapply yours on top, then push again.',
      );
    }
    if (mediaMissing.length > 0) {
      console.error('\nThese images are used by pages being pushed, but are missing here and on the live site:');
      for (const name of mediaMissing) {
        console.error(`  media/${name}`);
      }
    }
    process.exit(1);
  }

  const total = (pushContent ? contentChanges : 0) + (pushTheme ? themeChanges : 0);
  if (total === 0) {
    console.log('Nothing to push: the live site already has everything changed here since your last pull.');
    process.exit(0);
  }

  console.error(`\nThis will change the LIVE site at ${siteUrl}:\n`);
  if (pushTheme) {
    printThemePlan(theme.plan);
  }
  if (pushContent) {
    printContentPlan(content.plan);
  }
  if (dryRun) {
    console.log('\nDry run: nothing was pushed.');
    process.exit(0);
  }

  const host = new URL(siteUrl).host;
  const deletes = pushContent ? content.plan.changes.filter((change) => change.action === 'delete').length : 0;
  console.error('\nWARNING: this overwrites the live website, straight away.');
  if (pushTheme) {
    console.error('  - The theme files listed replace the live ones, and every page shows the new theme at once.');
  }
  if (pushContent) {
    console.error('  - Every page listed is published as it is here, replacing what visitors see now.');
  }
  if (deletes > 0) {
    console.error(`  - ${plural(deletes, 'page')} ${deletes === 1 ? 'is' : 'are'} deleted from the live site.`);
  }
  console.error('  - Anything changed on the live site since your last pull is left alone (none is listed above).');
  console.error('  - Earlier versions stay in the live site\'s history, if you need to go back.\n');
  const typed = await ask(`Type ${host} to push, or anything else to cancel: `);
  if (typed.trim().toLowerCase() !== host.toLowerCase()) {
    fail('Cancelled. Nothing was pushed.');
  }

  const result = await executePush(prepared, { content: pushContent, theme: pushTheme });
  console.log(`Pushed to ${siteUrl}:`);
  if (result.theme) {
    console.log(`  theme: ${plural(result.theme.files, 'file')} changed, live now`);
    for (const warning of result.theme.warnings) {
      console.log(`  warning: ${warning}`);
    }
  }
  if (result.content) {
    const done = result.content;
    console.log(`  content: ${done.created} new, ${done.updated} updated, ${done.deleted} deleted`);
    console.log(`  ${plural(done.redirects, 'redirect change')}, ${plural(done.mediaUploaded, 'image')} uploaded`);
  }
} catch (error) {
  if (error instanceof SiteSyncError) {
    fail(error.message, ...(error.reason === 'unauthorised' ? [TOKEN_HELP] : []));
  }
  throw error;
}
