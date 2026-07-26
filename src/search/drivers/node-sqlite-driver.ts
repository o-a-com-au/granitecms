import { DatabaseSync } from 'node:sqlite';
import type { SearchDriver } from './driver.ts';

// A plain string constant, not the raw node:sqlite import itself - safe
// for the capabilities endpoint (Phase 2 Group A) to import without
// tripping the G5 grep test, and avoids hardcoding this name a second
// time as a literal that could drift from the actual active driver.
export const DRIVER_NAME = 'node:sqlite';

// The only file in the codebase allowed to import node:sqlite
// (checklist G5, enforced by a grep test in
// test/static/static-analysis.test.ts). DatabaseSync's own
// prepare()/exec()/close() already structurally match SearchDriver,
// so this is a thin adapter, not a reimplementation.
export function openNodeSqliteDriver(path: string): SearchDriver {
  const db = new DatabaseSync(path);
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    close: () => db.close(),
  };
}
