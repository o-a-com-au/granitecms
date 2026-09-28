#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadSiteConfig } from '../config.ts';
import { ask, chooseParts, parseSyncArgs, resolveToken, TOKEN_HELP } from './cli-helpers.ts';
import { normaliseSiteUrl } from './prompts.ts';
import { readAgentVersion } from '../routes/capabilities.ts';
import { compareVersions } from '../upgrade/changelog.ts';
import { describeDeployMethod, detectDeployMethod, runDeploy, waitForLiveVersion } from './deploy.ts';
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

// Narrowed once here, for the functions below.
const liveUrl: string = siteUrl;
const host = new URL(liveUrl).host;

async function confirmByAddress(): Promise<void> {
  const typed = await ask(`Type ${host} to go ahead, or anything else to cancel: `);
  if (typed.trim().toLowerCase() !== host.toLowerCase()) {
    fail('Cancelled. Nothing was pushed.');
  }
}

// Step 1 when chosen: put the CMS here onto the live site by deploying,
// and wait until the live site says it is running it. Content and theme
// are only sent once it has, so they arrive on a CMS that understands
// them - and nothing else is sent if it doesn't.
async function upgradeLiveCms(liveVersion: string, localVersion: string): Promise<void> {
  const method = detectDeployMethod(config.siteRoot);
  console.error(`\nStep 1: upgrade the live site's CMS from ${liveVersion} to ${localVersion}, using ${describeDeployMethod(method)}.`);
  console.error('  - The live site restarts, and is unavailable for a moment.');
  console.error('  - Its content and theme are not touched by the upgrade.');
  if (dryRun) {
    return;
  }
  console.error('');
  await confirmByAddress();

  if (method.kind === 'manual') {
    console.error(`\nDeploy the site now, the way you usually deploy to your host. (To have push do it for you next time, put the command in vhost/deploy.json, for example { "command": "git push" }.)`);
    await ask('Press Enter once the deploy has started: ');
  } else if (!runDeploy(method, config.siteRoot)) {
    fail('The deploy failed, so nothing else was pushed. Its output is above.');
  }

  console.error(`Waiting for the live site to come back on ${localVersion}...`);
  let lastReported: string | null | undefined;
  const outcome = await waitForLiveVersion(liveUrl, localVersion, {
    onPoll: (seen) => {
      if (seen !== lastReported) {
        console.error(seen === null ? '  (restarting, not answering yet)' : `  live site on ${seen}`);
        lastReported = seen;
      }
    },
  });
  if (!outcome.ok) {
    fail(`Stopped without pushing anything else: ${outcome.reason}. Check the deploy on your host.`);
  }
  console.error(`The live site is now on ${localVersion}.`);
}

try {
  const token = await resolveToken(args, siteUrl);
  const prepare = () =>
    preparePush(config, {
      siteUrl,
      token,
      onWait: (seconds) => console.error(`  The live site asked to slow down; waiting ${seconds}s...`),
    });
  console.error(`Comparing this copy with ${siteUrl}...`);
  let prepared = await prepare();

  const localVersion = readAgentVersion();
  const versionOrder = compareVersions(localVersion, prepared.liveVersion);
  if (versionOrder < 0) {
    console.error(
      `Note: the live site runs a newer CMS (${prepared.liveVersion}) than this copy (${localVersion}). Run npm run upgrade here to match it.`,
    );
  }

  const describe = () => {
    const content = prepared.content.ready ? prepared.content.value : null;
    const theme = prepared.theme.ready ? prepared.theme.value : null;
    return { content, theme, contentChanges: content ? contentCount(content.plan) : 0, themeChanges: theme ? theme.plan.changes.length : 0 };
  };
  const first = describe();
  const parts = await chooseParts(args, 'push', {
    content: first.content
      ? {
          available: true,
          detail: first.content.plan.conflicts.length > 0 ? plural(first.content.plan.conflicts.length, 'conflict') : first.contentChanges > 0 ? plural(first.contentChanges, 'change') : 'no changes',
          checked: first.contentChanges > 0 || first.content.plan.conflicts.length > 0,
        }
      : { available: false, detail: (prepared.content as { reason: string }).reason, checked: false },
    theme: first.theme
      ? {
          available: true,
          detail: first.theme.plan.conflicts.length > 0 ? plural(first.theme.plan.conflicts.length, 'conflict') : first.themeChanges > 0 ? `${plural(first.themeChanges, 'file')} changed` : 'no changes',
          checked: first.themeChanges > 0 || first.theme.plan.conflicts.length > 0,
        }
      : { available: false, detail: (prepared.theme as { reason: string }).reason, checked: false },
    cms:
      versionOrder > 0
        ? { available: true, detail: `live site: ${prepared.liveVersion}, here: ${localVersion}`, checked: true }
        : { available: false, detail: `the live site already runs ${prepared.liveVersion}`, checked: false },
  });
  if (!parts.content && !parts.theme && !parts.cms) {
    console.log('Nothing chosen. Nothing was pushed.');
    process.exit(0);
  }
  if ((parts.content || parts.theme) && prepared.liveSchemaOlder && !parts.cms) {
    fail(
      `The live site's CMS (${prepared.liveVersion}) uses an older content format than this copy's (${localVersion}), and could reject what it's sent. Push the CMS upgrade with it (npm run push, and tick CMS upgrade).`,
    );
  }

  if (parts.cms) {
    await upgradeLiveCms(prepared.liveVersion, localVersion);
    if (!parts.content && !parts.theme) {
      console.log(dryRun ? '\nDry run: nothing was pushed.' : `Pushed to ${siteUrl}: the CMS upgrade to ${localVersion}.`);
      process.exit(0);
    }
    if (dryRun) {
      console.log('\nDry run: nothing was pushed. (What content and theme would change is worked out once the upgrade is live.)');
      process.exit(0);
    }
    // Planned again against the upgraded site: what it reports can have
    // changed with it (a theme it could not report before, for one).
    console.error(`\nStep 2: your content and theme changes. Comparing again with the upgraded site...`);
    prepared = await prepare();
  }

  const { content, theme, contentChanges, themeChanges } = describe();
  const pushContent = parts.content && content !== null;
  const pushTheme = parts.theme && theme !== null;
  if (parts.theme && theme === null) {
    console.error(`The theme can't be pushed: ${(prepared.theme as { reason: string }).reason}.`);
  }
  if (!pushContent && !pushTheme) {
    process.exit(parts.cms ? 0 : 1);
  }

  const contentConflicts = pushContent ? content.plan.conflicts : [];
  const themeConflicts = pushTheme ? theme.plan.conflicts : [];
  const mediaMissing = pushContent ? content.plan.mediaMissing : [];
  if (contentConflicts.length > 0 || themeConflicts.length > 0 || mediaMissing.length > 0) {
    console.error('Nothing more was pushed.');
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
  await confirmByAddress();

  const result = await executePush(prepared, { content: pushContent, theme: pushTheme });
  console.log(`Pushed to ${siteUrl}:`);
  if (parts.cms) {
    console.log(`  CMS: upgraded to ${localVersion}`);
  }
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
  if (error instanceof Error && error.message.startsWith('vhost/deploy.json')) {
    fail(error.message);
  }
  throw error;
}
