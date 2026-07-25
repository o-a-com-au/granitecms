// The swappable SQLite driver interface. No node:sqlite or
// better-sqlite3 import belongs in this file, or anywhere outside
// src/search/drivers/ (checklist G5).
export interface PreparedStatement {
  run(...params: unknown[]): void;
  all(...params: unknown[]): unknown[];
}

export interface SearchDriver {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  close(): void;
}
