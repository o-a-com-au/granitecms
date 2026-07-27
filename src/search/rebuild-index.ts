import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { listFilesRecursively } from '../services/fs-walk.ts';
import { postPathToUrl } from '../services/post-urls.ts';
import { pagePathToUrl } from '../services/urls.ts';
import { enqueue } from '../services/write-queue.ts';
import { openNodeSqliteDriver } from './drivers/node-sqlite-driver.ts';

interface InstanceLike {
  settings?: unknown;
  blocks?: InstanceLike[];
}

interface PageForIndex {
  title?: unknown;
  published?: unknown;
  sections?: InstanceLike[];
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      collectStrings(nested, out);
    }
  }
}

// Recursively collects every string value out of each section's
// settings and any nested blocks' settings (instance.schema.json's
// blocks is self-referential, so this covers arbitrarily deep
// nesting). Only settings values, not id/type, so the indexed body is
// actual authored content, not structural metadata.
function extractBody(instances: InstanceLike[] | undefined): string {
  const strings: string[] = [];
  const walk = (list: InstanceLike[] | undefined): void => {
    if (!list) {
      return;
    }
    for (const instance of list) {
      collectStrings(instance.settings, strings);
      walk(instance.blocks);
    }
  };
  walk(instances);
  return strings.join(' ');
}

async function rebuildIndexJob(config: SiteConfig): Promise<void> {
  mkdirSync(config.dataRoot, { recursive: true });

  // Delete-then-recreate, not existsSync-then-unlinkSync (a TOCTOU
  // gap): this makes every rebuild start from a genuinely clean file,
  // which is also what makes "delete the index and rebuild produces
  // equivalent results" (G2) a structural consequence rather than a
  // special case.
  try {
    unlinkSync(config.searchIndexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const driver = openNodeSqliteDriver(config.searchIndexPath);
  try {
    driver.exec('CREATE VIRTUAL TABLE pages_fts USING fts5(url UNINDEXED, title, body)');
    const insert = driver.prepare('INSERT INTO pages_fts (url, title, body) VALUES (?, ?, ?)');

    // Posts are genuinely public, URL-addressable content search
    // should cover, same as pages - only the root and the URL mapping
    // differ. Menus are deliberately never walked here at all: they
    // have no public URL to point a search result at.
    const collections = [
      { root: config.pagesRoot, toUrl: pagePathToUrl },
      { root: config.postsRoot, toUrl: postPathToUrl },
    ];

    driver.exec('BEGIN');
    for (const { root, toUrl } of collections) {
      for (const relativePath of listFilesRecursively(root, root, '.json')) {
        let page: PageForIndex;
        try {
          page = JSON.parse(readFileSync(join(root, relativePath), 'utf-8')) as PageForIndex;
        } catch {
          // A malformed individual file is skipped, not an all-or-nothing
          // abort: the index is explicitly disposable/best-effort, and
          // aborting the whole rebuild over one bad file would leave no
          // working index at all - strictly worse than skipping one page.
          continue;
        }

        // Never walks draftsRoot at all, and skips unpublished content
        // here - both halves of "drafts and unpublished content are
        // absent from the index" (G3) are true by construction, not by
        // a filter that could be gotten wrong.
        if (page.published === false) {
          continue;
        }

        const url = toUrl(relativePath);
        const title = typeof page.title === 'string' ? page.title : '';
        const body = extractBody(page.sections);
        insert.run(url, title, body);
      }
    }
    driver.exec('COMMIT');
  } finally {
    driver.close();
  }
}

// Queued via enqueue(), not because constraint 6 literally demands it
// for a non-authoritative index, but because of a same-process race
// specific to this delete-then-recreate design: two concurrent
// rebuilds can interleave so one's unlink races another's open+CREATE,
// or one can unlink the file out from under another's in-progress
// transaction. enqueue() is a generic, domain-agnostic primitive, so
// reusing it for self-exclusion costs nothing.
export function rebuildIndex(config: SiteConfig): Promise<void> {
  return enqueue(() => rebuildIndexJob(config));
}
