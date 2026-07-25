import { openNodeSqliteDriver } from './drivers/node-sqlite-driver.ts';

export interface SearchResult {
  url: string;
  title: string;
}

// Never queued: an in-flight query holding an open handle during a
// concurrent rebuild's unlink just keeps reading the pre-rebuild inode
// (stale but consistent, never torn) - queuing a read against the same
// queue as writes would only add latency for no correctness benefit.
export function queryIndex(searchIndexPath: string, term: string): SearchResult[] {
  const driver = openNodeSqliteDriver(searchIndexPath);
  try {
    const rows = driver.prepare('SELECT url, title FROM pages_fts WHERE pages_fts MATCH ?').all(term);
    // node:sqlite returns rows as [Object: null prototype] instances;
    // rebuilt here as plain objects so callers (and assert.deepEqual)
    // never have to know that's a driver implementation detail.
    return rows.map((row) => {
      const { url, title } = row as { url: string; title: string };
      return { url, title };
    });
  } finally {
    driver.close();
  }
}
