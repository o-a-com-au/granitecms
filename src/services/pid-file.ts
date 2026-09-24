import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteConfig } from '../config.ts';

// Records which process is serving this site, so `npm run stop`
// (stop-site) can stop it from any terminal, not only the one it was
// started in. Lives in vhost/data/, beside the search index: derived,
// disposable, never git-tracked.
export interface PidRecord {
  // The process to signal. Under `npm run dev` (node --watch) that is
  // the watcher, not this process: SIGTERM to the watcher is passed on
  // to this process (which shuts down gracefully) and then the watcher
  // exits too, whereas signalling only this process would leave the
  // watcher waiting for the next theme change to start it again.
  pid: number;
  // This process itself, the one actually listening.
  serverPid: number;
  port: number;
  startedAt: string;
}

export function pidFilePath(config: SiteConfig): string {
  return join(config.dataRoot, 'server.pid');
}

// Node sets WATCH_REPORT_DEPENDENCIES in the child it runs under
// --watch, whose parent is then the watcher itself.
function stopTarget(): number {
  return process.env.WATCH_REPORT_DEPENDENCIES ? process.ppid : process.pid;
}

export function writePidFile(config: SiteConfig, port: number): void {
  const record: PidRecord = { pid: stopTarget(), serverPid: process.pid, port, startedAt: new Date().toISOString() };
  mkdirSync(config.dataRoot, { recursive: true });
  writeFileSync(pidFilePath(config), `${JSON.stringify(record, null, 2)}\n`);
}

export function readPidFile(config: SiteConfig): PidRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(pidFilePath(config), 'utf-8')) as Record<string, unknown>;
    const { pid, serverPid, port, startedAt } = parsed;
    if (
      typeof pid !== 'number' ||
      typeof serverPid !== 'number' ||
      typeof port !== 'number' ||
      typeof startedAt !== 'string'
    ) {
      return null;
    }
    return { pid, serverPid, port, startedAt };
  } catch {
    return null;
  }
}

// Only removes the file if it is still this process's own record: under
// `npm run dev` the watcher starts a new process on a theme change, and
// the old one shutting down must not delete the record the new one has
// just written.
export function removeOwnPidFile(config: SiteConfig): void {
  if (readPidFile(config)?.serverPid === process.pid) {
    removePidFile(config);
  }
}

export function removePidFile(config: SiteConfig): void {
  rmSync(pidFilePath(config), { force: true });
}

// Whether a process with this id exists. EPERM means it does, but
// belongs to another user.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}
