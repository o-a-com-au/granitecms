import { DatabaseSync } from 'node:sqlite';
import type { SearchDriver } from './driver.ts';

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
