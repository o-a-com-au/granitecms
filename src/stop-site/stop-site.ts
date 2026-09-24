import type { SiteConfig } from '../config.ts';
import { isProcessAlive, readPidFile, removePidFile } from '../services/pid-file.ts';

export type StopSiteResult =
  | { outcome: 'not-running' }
  | { outcome: 'removed-stale'; pid: number }
  | { outcome: 'not-a-site'; pid: number; port: number }
  | { outcome: 'stopped'; port: number }
  | { outcome: 'still-stopping'; pid: number };

export interface StopSiteDeps {
  isAlive: (pid: number) => boolean;
  signal: (pid: number) => void;
  // Whether a cms-agent site is answering on this port.
  isSiteListening: (port: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}

// GET /v1/capabilities is unauthenticated and always answers with the
// agent's own version, so it's the check that something on the recorded
// port really is a site - not just any process that happens to have
// been given the recorded id after the site's own ended.
async function capabilitiesAnswer(port: number): Promise<boolean> {
  try {
    const response = await fetch(new URL('/v1/capabilities', `http://127.0.0.1:${port}`), {
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await response.json()) as Record<string, unknown>;
    return response.ok && typeof body.agentVersion === 'string';
  } catch {
    return false;
  }
}

export const defaultStopSiteDeps: StopSiteDeps = {
  isAlive: isProcessAlive,
  signal: (pid) => process.kill(pid, 'SIGTERM'),
  isSiteListening: capabilitiesAnswer,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // Long enough for the final draft checkpoint a graceful shutdown runs.
  timeoutMs: 15_000,
};

// Stops the site recorded in vhost/data/server.pid with SIGTERM - the
// same graceful shutdown as Ctrl+C (the server closes and runs its
// final draft checkpoint) - then waits for it to exit. It only ever
// signals a process that is both alive and answering as a site on the
// recorded port, so a leftover file from a crash never gets an
// unrelated process that has since been given the same id killed.
export async function stopSite(config: SiteConfig, deps: StopSiteDeps = defaultStopSiteDeps): Promise<StopSiteResult> {
  const record = readPidFile(config);
  if (!record) {
    return { outcome: 'not-running' };
  }

  if (!deps.isAlive(record.pid)) {
    removePidFile(config);
    return { outcome: 'removed-stale', pid: record.pid };
  }

  if (!(await deps.isSiteListening(record.port))) {
    return { outcome: 'not-a-site', pid: record.pid, port: record.port };
  }

  deps.signal(record.pid);

  const pollMs = 200;
  for (let waited = 0; waited < deps.timeoutMs; waited += pollMs) {
    if (!deps.isAlive(record.pid) && !deps.isAlive(record.serverPid)) {
      // The server removes its own record on a graceful shutdown; this
      // covers one that exited without getting that far.
      removePidFile(config);
      return { outcome: 'stopped', port: record.port };
    }
    await deps.sleep(pollMs);
  }
  return { outcome: 'still-stopping', pid: record.pid };
}
