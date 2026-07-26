import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type StartupCheckReason =
  | 'node-version-too-low'
  | 'site-root-missing'
  | 'git-binary-absent'
  | 'not-a-git-repo'
  | 'invalid-site-config'
  | 'invalid-token-config';

export class StartupCheckError extends Error {
  readonly reason: StartupCheckReason;

  constructor(reason: StartupCheckReason, message: string) {
    super(message);
    this.name = 'StartupCheckError';
    this.reason = reason;
  }
}

export interface StartupCheckOptions {
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(version: string): ParsedVersion {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return { major, minor, patch };
}

function isBelow(version: ParsedVersion, floor: ParsedVersion): boolean {
  if (version.major !== floor.major) {
    return version.major < floor.major;
  }
  if (version.minor !== floor.minor) {
    return version.minor < floor.minor;
  }
  return version.patch < floor.patch;
}

// Reads the Node version floor from the agent's own package.json rather
// than hardcoding a second literal here, so the dev-toolchain minimum
// (package.json engines.node, driven by --experimental-strip-types) and
// the shipped-agent's runtime minimum can't drift apart by accident.
// This is the agent's own bundled file, not site data, so resolving it
// relative to this module's own location is correct here, the same way
// validation.ts resolves its own schema files.
function readNodeVersionFloor(): string {
  const packageJsonPath = join(import.meta.dirname, '..', '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
    engines?: { node?: string };
  };
  const floor = packageJson.engines?.node;
  if (!floor) {
    throw new Error('package.json is missing engines.node');
  }
  return floor.replace(/^[^\d]*/, '');
}

// Fail-fast, in this specific order. Checking "is a git repo" before
// confirming the site root exists would make a missing root fail with
// the same ENOENT as "git binary absent" (both execFileSync failures),
// which would misreport one case as the other.
export function runStartupChecks(siteRoot: string, options: StartupCheckOptions = {}): void {
  const nodeVersion = options.nodeVersion ?? process.version;
  const floor = parseVersion(readNodeVersionFloor());
  if (isBelow(parseVersion(nodeVersion), floor)) {
    throw new StartupCheckError(
      'node-version-too-low',
      `Node ${readNodeVersionFloor()} or later is required, found ${nodeVersion}`,
    );
  }

  try {
    if (!statSync(siteRoot).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new StartupCheckError(
      'site-root-missing',
      `Site root does not exist or is not a directory: ${siteRoot}`,
    );
  }

  const env = options.env ?? process.env;

  try {
    // Deliberately not run with cwd: siteRoot, so this check never
    // depends on the site root existing.
    execFileSync('git', ['--version'], { env, stdio: 'ignore' });
  } catch {
    throw new StartupCheckError('git-binary-absent', 'git binary not found on PATH');
  }

  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: siteRoot,
      env,
      stdio: 'ignore',
    });
  } catch {
    throw new StartupCheckError(
      'not-a-git-repo',
      `Site root is not a git repository: ${siteRoot}`,
    );
  }
}
