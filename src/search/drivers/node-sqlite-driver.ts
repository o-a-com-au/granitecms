import { DatabaseSync } from 'node:sqlite';
import type { SearchDriver } from './driver.ts';

// A plain string constant, not the raw node:sqlite import itself - safe
// for the capabilities endpoint (Phase 2 Group A) to import without
// tripping the G5 grep test, and avoids hardcoding this name a second
// time as a literal that could drift from the actual active driver.
export const DRIVER_NAME = 'node:sqlite';

export interface OpenDriverOptions {
  // Every query path opens read-only now (query-content.ts) - never
  // true for rebuild-index.ts's own write connection. Semantically
  // correct (a query never writes) and lets node:sqlite skip whatever
  // write-path setup it would otherwise do.
  readOnly?: boolean;
  // Busy-timeout in milliseconds: how long a connection waits on a
  // lock before giving up, rather than failing immediately. Matters
  // far less now that rebuilds swap the index file atomically via
  // rename (rebuild-index.ts) rather than writing into the live file
  // in place, but a query landing in the same instant as a rename is
  // still worth a brief, bounded wait instead of an immediate error.
  timeout?: number;
}

// The only file in the codebase allowed to import node:sqlite
// (checklist G5, enforced by a grep test in
// test/static/static-analysis.test.ts). DatabaseSync's own
// prepare()/exec()/close() already structurally match SearchDriver,
// so this is a thin adapter, not a reimplementation.
export function openNodeSqliteDriver(path: string, options: OpenDriverOptions = {}): SearchDriver {
  const db = new DatabaseSync(path, options);
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    close: () => db.close(),
  };
}
