import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteConfig } from '../config.ts';
import type { RedirectEntry } from '../services/redirects.ts';

// What the live site looked like at the last pull (or push), so push can
// tell a change made here apart from one made on the live site since.
// Kept per part, because content and theme can be pulled separately.
// Lives in vhost/data/, beside the search index: never committed, and
// specific to this copy of the site.
export interface ContentRecord {
  syncedAt: string;
  // Content-relative path -> hashOf(what the live site had).
  files: Record<string, string>;
  redirects: RedirectEntry[];
}

export interface ThemeRecord {
  syncedAt: string;
  // Theme-relative path -> hashThemeFile(what the live site had).
  files: Record<string, string>;
}

export interface SyncRecord {
  siteUrl: string;
  content?: ContentRecord;
  theme?: ThemeRecord;
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

function isFileMap(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && Object.values(value).every((hash) => typeof hash === 'string');
}

export function readSyncRecord(config: SiteConfig): SyncRecord | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(recordPath(config), 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof parsed.siteUrl !== 'string') {
    return null;
  }
  const record: SyncRecord = { siteUrl: parsed.siteUrl };

  // 0.5.5 wrote content only, at the top level.
  const content = (parsed.content ?? (parsed.files ? parsed : undefined)) as Record<string, unknown> | undefined;
  if (content && isFileMap(content.files) && Array.isArray(content.redirects)) {
    record.content = {
      syncedAt: typeof content.syncedAt === 'string' ? content.syncedAt : '',
      files: content.files,
      redirects: content.redirects as RedirectEntry[],
    };
  }
  const theme = parsed.theme as Record<string, unknown> | undefined;
  if (theme && isFileMap(theme.files)) {
    record.theme = { syncedAt: typeof theme.syncedAt === 'string' ? theme.syncedAt : '', files: theme.files };
  }
  return record;
}

// Replaces one part of the record and keeps the other - unless the
// record is for a different site, which starts it afresh.
export function updateSyncRecord(
  config: SiteConfig,
  siteUrl: string,
  part: { content: ContentRecord } | { theme: ThemeRecord },
): void {
  const existing = readSyncRecord(config);
  const base: SyncRecord = existing && existing.siteUrl === siteUrl ? existing : { siteUrl };
  const record: SyncRecord = { ...base, ...part };
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
