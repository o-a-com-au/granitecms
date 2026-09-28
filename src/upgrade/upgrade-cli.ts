#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ask, parseSyncArgs } from '../site-sync/cli-helpers.ts';
import { changesBetween, compareVersions, mayBreak } from './changelog.ts';
import { finishUpgrade } from './finish.ts';

// npm run upgrade [-- <version>] [--yes] [--force]
//
// In two halves. This version (the one installed now) picks the new
// version, shows what's new, asks, and installs it. Then it hands over
// to the NEW version's own copy of this command (--finish), which puts
// back the CMS's own files, updates content to the new format, and
// checks the site: only the new version knows what it changed.
// Nothing is committed, and the live site is not touched - npm run
// push offers the upgrade once it has been tested here.

const PACKAGE = '@o-a/cms-agent';
const args = parseSyncArgs(process.argv.slice(2));
const vhostDir = process.cwd();
const siteRoot = resolve(vhostDir, '..');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function installedVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(vhostDir, 'node_modules', '@o-a', 'cms-agent', 'package.json'), 'utf-8')) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return fail('The CMS isn\'t installed here. Run npm run upgrade from your site\'s vhost/ folder, after npm install.');
  }
}

function npm(npmArgs: string[], cwd = vhostDir): string {
  return execFileSync('npm', npmArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf-8');
}

// The CHANGELOG.md inside the version about to be installed, fetched
// the same way npm install will fetch it - so it's the real thing, from
// the same registry.
function changelogOf(version: string): string | null {
  const scratch = mkdtempSync(join(tmpdir(), 'cms-upgrade-'));
  try {
    const packed = JSON.parse(npm(['pack', `${PACKAGE}@${version}`, '--pack-destination', scratch, '--json'], scratch)) as Array<{
      filename: string;
    }>;
    const tarball = join(scratch, packed[0]?.filename as string);
    execFileSync('tar', ['-xzf', tarball, '-C', scratch, 'package/CHANGELOG.md'], { stdio: 'ignore' });
    return readFileSync(join(scratch, 'package', 'CHANGELOG.md'), 'utf-8');
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function hasUncommittedChanges(): boolean {
  try {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no', '--', 'vhost', 'content', 'theme'], {
      cwd: siteRoot,
    });
    return status.toString('utf-8').trim() !== '';
  } catch {
    return false;
  }
}

async function start(): Promise<void> {
  const from = installedVersion();

  let latest: string;
  let versions: string[];
  try {
    const info = JSON.parse(npm(['view', PACKAGE, 'versions', 'dist-tags', '--json'])) as {
      versions: string[] | string;
      'dist-tags': { latest: string };
    };
    versions = Array.isArray(info.versions) ? info.versions : [info.versions];
    latest = info['dist-tags'].latest;
  } catch {
    return fail(`Couldn't ask npm which versions of ${PACKAGE} exist. Check your internet connection and try again.`);
  }

  const to = args.positional[0] ?? latest;
  if (!versions.includes(to)) {
    fail(`${PACKAGE} has no version ${to}. The latest is ${latest}.`);
  }
  if (compareVersions(to, from) === 0) {
    console.log(`Already on ${from}${to === latest ? ', the latest' : ''}. Nothing to upgrade.`);
    return;
  }
  if (compareVersions(to, from) < 0) {
    fail(`${to} is older than the ${from} installed here. npm run upgrade only goes forward.`);
  }
  if (!args.flags.has('--force') && hasUncommittedChanges()) {
    fail(
      'vhost/, content/ or theme/ has uncommitted changes. Commit them first, so the upgrade\'s own changes are easy to review (or pass --force).',
    );
  }

  console.log(`Upgrading the CMS from ${from} to ${to}.\n`);
  const changelog = changelogOf(to);
  if (changelog) {
    for (const section of changesBetween(changelog, from, to)) {
      console.log(`--- ${section.version} ---\n${section.text}\n`);
    }
  } else {
    console.log(`(Couldn't read the changelog for ${to}.)\n`);
  }
  if (mayBreak(from, to)) {
    console.log(`Note: ${from} to ${to} is a bigger step, which can include breaking changes. Read the notes above before going ahead.\n`);
  }

  if (!args.flags.has('--yes')) {
    const answer = (await ask(`Upgrade from ${from} to ${to}? (y/N) `)).toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Cancelled. Nothing was changed.');
      return;
    }
  }

  const packagePath = join(vhostDir, 'package.json');
  const lockPath = join(vhostDir, 'package-lock.json');
  const packageBefore = readFileSync(packagePath, 'utf-8');
  const lockBefore = existsSync(lockPath) ? readFileSync(lockPath, 'utf-8') : null;
  const pkg = JSON.parse(packageBefore) as { dependencies?: Record<string, string> };
  pkg.dependencies = { ...pkg.dependencies, [PACKAGE]: to };
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  console.log(`Installing ${PACKAGE}@${to}...`);
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: vhostDir, stdio: 'inherit' });
  } catch {
    writeFileSync(packagePath, packageBefore);
    if (lockBefore !== null) {
      writeFileSync(lockPath, lockBefore);
    }
    fail(`Installing ${to} failed; package.json and package-lock.json are back as they were. Run npm install to restore ${from}.`);
  }

  // Hand over to the version just installed.
  const next = join(vhostDir, 'node_modules', '@o-a', 'cms-agent', 'dist', 'upgrade', 'upgrade-cli.js');
  if (!existsSync(next)) {
    fail(`${to} is installed, but has no upgrade step of its own to finish with.`);
  }
  const finished = spawnSync(process.execPath, [next, '--finish'], { cwd: vhostDir, stdio: 'inherit' });
  process.exit(finished.status ?? 1);
}

async function finish(): Promise<void> {
  const version = installedVersion();
  console.log(`\nFinishing the upgrade to ${version}...`);
  const result = await finishUpgrade(siteRoot);

  const changed = result.files.filter((file) => file.status !== 'unchanged');
  if (changed.length > 0) {
    console.log('The CMS\'s own files:');
    for (const file of changed) {
      console.log(`  ${file.status.padEnd(8)} ${file.path}`);
    }
  }
  if (result.migrated.length > 0) {
    console.log(`Updated ${result.migrated.length} content file${result.migrated.length === 1 ? '' : 's'} to the new content format.`);
  }
  if (result.migrationProblem) {
    console.log(`Content couldn't be updated to the new format, so none of it was changed:\n  ${result.migrationProblem}\nFix that file, then run npm run upgrade -- --finish again.`);
  }
  if (result.check.ok) {
    console.log('Site check: no problems found.');
  } else {
    // Reported, but not a failed upgrade: the check covers the whole
    // site, so these can be problems it already had.
    const count = result.check.findings.length;
    console.log(`Site check: ${count} problem${count === 1 ? '' : 's'} (some may be from before the upgrade). Run npm run check to see them.`);
  }
  console.log(
    `\nThe CMS here is now ${version}. Nothing was committed, and the live site hasn't changed.\nTest it with npm run dev, review with git diff, then put it live with npm run push.`,
  );
  if (result.migrationProblem) {
    process.exit(1);
  }
}

await (args.flags.has('--finish') ? finish() : start());
