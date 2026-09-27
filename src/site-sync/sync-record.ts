import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteConfig } from '../config.ts';
import type { RedirectEntry } from '../services/redirects.ts';

// What the live site looked like at the last pull (or push), so push can
// tell a change made here apart from one an editor made on the live site
// since. Lives in vhost/data/, beside the search index: never committed,
// and specific to this copy of the site.
export interface SyncRecord {
  siteUrl: string;
  syncedAt: string;
  // Content-relative path -> hashOf(the bytes the live site had).
  files: Record<string, string>;
  redirects: RedirectEntry[];
}

// Compares content, not formatting: the live site re-serialises a page
// it is sent, so the same page reads back with different whitespace.
// Hashing the raw bytes would make every page pushed once look changed
// locally forever after. Anything that isn't JSON is hashed as-is.
export function hashOf(bytes: Buffer): string {
  let canonical: string;
  try {
    canonical = JSON.stringify(JSON.parse(bytes.toString('utf-8')));
  } catch {
    return createHash('sha256').update(bytes).digest('hex');
  }
  return createHash('sha256').update(canonical).digest('hex');
}

function recordPath(config: SiteConfig): string {
  return join(config.dataRoot, 'sync-record.json');
}

export function readSyncRecord(config: SiteConfig): SyncRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(config), 'utf-8')) as Partial<SyncRecord>;
    if (
      typeof parsed.siteUrl !== 'string' ||
      typeof parsed.syncedAt !== 'string' ||
      typeof parsed.files !== 'object' ||
      parsed.files === null ||
      !Array.isArray(parsed.redirects)
    ) {
      return null;
    }
    return parsed as SyncRecord;
  } catch {
    return null;
  }
}

export function writeSyncRecord(config: SiteConfig, record: SyncRecord): void {
  mkdirSync(config.dataRoot, { recursive: true });
  writeFileSync(recordPath(config), `${JSON.stringify(record, null, 2)}\n`);
}

// A redirects list compared by content, not order.
export function sameRedirects(a: RedirectEntry[], b: RedirectEntry[]): boolean {
  const key = (entries: RedirectEntry[]) =>
    JSON.stringify(
      [...entries]
        .map((entry) => ({ from: entry.from, to: entry.to, note: entry.note ?? null }))
        .sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0)),
    );
  return key(a) === key(b);
}
