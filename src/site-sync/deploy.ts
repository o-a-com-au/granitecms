import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCapabilities } from './live-content.ts';

// How a CMS upgrade reaches the live site. A deploy replaces only the
// CMS program: the live site's content and theme live on its own disk
// and are never touched by one (docs/guide-deploying.md).
export type DeployMethod =
  | { kind: 'command'; command: string }
  | { kind: 'railway' }
  | { kind: 'fly' }
  | { kind: 'manual' };

export interface DeployDeps {
  // Whether a program is installed and, for Railway, linked to this
  // site - true when running it with these arguments succeeds.
  succeeds: (program: string, args: string[], cwd: string) => boolean;
  exists: (path: string) => boolean;
  readText: (path: string) => string;
}

export const defaultDeployDeps: DeployDeps = {
  succeeds: (program, args, cwd) => {
    try {
      execFileSync(program, args, { cwd, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
  exists: existsSync,
  readText: (path) => readFileSync(path, 'utf-8'),
};

// In order: the site's own vhost/deploy.json (set once, for any host -
// "git push", an ssh command...), then a site linked to Railway, then
// one set up for Fly, and otherwise the developer deploys by hand.
export function detectDeployMethod(siteRoot: string, deps: DeployDeps = defaultDeployDeps): DeployMethod {
  const deployJson = join(siteRoot, 'vhost', 'deploy.json');
  if (deps.exists(deployJson)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(deps.readText(deployJson));
    } catch {
      throw new Error('vhost/deploy.json is not valid JSON. It should look like { "command": "git push" }.');
    }
    const command = (parsed as { command?: unknown } | null)?.command;
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('vhost/deploy.json needs a "command", for example { "command": "git push" }.');
    }
    return { kind: 'command', command };
  }
  if (deps.succeeds('railway', ['status'], siteRoot)) {
    return { kind: 'railway' };
  }
  if (deps.exists(join(siteRoot, 'fly.toml')) && deps.succeeds('fly', ['version'], siteRoot)) {
    return { kind: 'fly' };
  }
  return { kind: 'manual' };
}

export function describeDeployMethod(method: DeployMethod): string {
  switch (method.kind) {
    case 'command':
      return `the command in vhost/deploy.json (${method.command})`;
    case 'railway':
      return 'Railway (railway up)';
    case 'fly':
      return 'Fly.io (fly deploy)';
    case 'manual':
      return 'you, with your host\'s usual deploy command';
  }
}

// Runs the deploy, showing its own output. Returns false if it failed.
// Manual deploys are handled by the caller (it has to ask).
export function runDeploy(method: Exclude<DeployMethod, { kind: 'manual' }>, siteRoot: string): boolean {
  const result =
    method.kind === 'command'
      ? spawnSync(method.command, { cwd: siteRoot, stdio: 'inherit', shell: true })
      : method.kind === 'railway'
        ? spawnSync('railway', ['up', '--no-gitignore', '--ci'], { cwd: siteRoot, stdio: 'inherit' })
        : spawnSync('fly', ['deploy', '--dockerfile', 'vhost/Dockerfile'], { cwd: siteRoot, stdio: 'inherit' });
  return result.status === 0;
}

export interface WaitOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  onPoll?: (seen: string | null) => void;
}

// Waits for the live site to report the new version, then checks its
// home page loads. Returns what was last seen if it never got there.
export async function waitForLiveVersion(
  siteUrl: string,
  version: string,
  options: WaitOptions = {},
): Promise<{ ok: true } | { ok: false; lastSeen: string | null; reason: string }> {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const intervalMs = options.intervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastSeen: string | null = null;

  for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
    try {
      lastSeen = (await readCapabilities(siteUrl, fetchImpl)).agentVersion;
    } catch {
      // Restarting: not answering yet is expected.
      lastSeen = null;
    }
    options.onPoll?.(lastSeen);
    if (lastSeen === version) {
      try {
        const home = await fetchImpl(new URL('/', siteUrl), { signal: AbortSignal.timeout(30_000) });
        if (home.ok) {
          return { ok: true };
        }
        return { ok: false, lastSeen, reason: `the live site is on ${version}, but its home page returned ${home.status}` };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, lastSeen, reason: `the live site is on ${version}, but its home page didn't load (${detail})` };
      }
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    lastSeen,
    reason: lastSeen === null ? 'the live site stopped answering' : `the live site is still on ${lastSeen}`,
  };
}
