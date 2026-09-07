import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { listFilesRecursively } from '../services/fs-walk.ts';
import { postPathToUrl } from '../services/post-urls.ts';
import { loadThemeSchemas } from '../services/theme-schemas.ts';
import { pagePathToUrl } from '../services/urls.ts';
import { enqueue } from '../services/write-queue.ts';
import { openNodeSqliteDriver } from './drivers/node-sqlite-driver.ts';

interface InstanceLike {
  id?: unknown;
  type?: unknown;
  settings?: unknown;
  blocks?: InstanceLike[];
}

interface PageForIndex {
  title?: unknown;
  type?: unknown;
  published?: unknown;
  sections?: InstanceLike[];
}

interface ApiFieldRow {
  blockType: string;
  instanceId: string;
  fieldKey: string;
  valueText: string | null;
  valueNumber: number | null;
  valueBool: number | null;
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

// Reads schema.properties for the given instance's own type, keeping
// only properties explicitly flagged "api": true (an unvalidated,
// theme-authored JSON Schema keyword - same status as "format"/
// "allowedBlocks", see docs/theme-authoring-guide.md and
// services/validation.ts's own allowedBlockTypesOf) - and pairs each
// with its actual value out of instance.settings. Only scalar values
// are meaningful to index this way; an object/array-typed field
// flagged "api": true has nothing sensible to store or compare, so
// it's silently skipped, the same way a malformed schema block already
// is elsewhere in this pipeline.
function extractInstanceApiFields(instance: InstanceLike, schemaMap: Record<string, object>, out: ApiFieldRow[]): void {
  const type = typeof instance.type === 'string' ? instance.type : undefined;
  const id = typeof instance.id === 'string' ? instance.id : undefined;
  if (!type || !id) {
    return;
  }
  const properties = (schemaMap[type] as { properties?: unknown } | undefined)?.properties;
  if (!properties || typeof properties !== 'object') {
    return;
  }
  const settings = (instance.settings && typeof instance.settings === 'object' ? instance.settings : {}) as Record<
    string,
    unknown
  >;
  for (const [key, propSchema] of Object.entries(properties as Record<string, unknown>)) {
    if ((propSchema as { api?: unknown } | null)?.api !== true) {
      continue;
    }
    const value = settings[key];
    if (typeof value === 'string') {
      out.push({ blockType: type, instanceId: id, fieldKey: key, valueText: value, valueNumber: null, valueBool: null });
    } else if (typeof value === 'number') {
      out.push({ blockType: type, instanceId: id, fieldKey: key, valueText: null, valueNumber: value, valueBool: null });
    } else if (typeof value === 'boolean') {
      out.push({ blockType: type, instanceId: id, fieldKey: key, valueText: null, valueNumber: null, valueBool: value ? 1 : 0 });
    }
  }
}

// Top-level page.sections entries are sections; every level of nested
// .blocks (arbitrarily deep - instance.schema.json's blocks is self-
// referential, same reasoning extractBody's own walk above already
// documents) is a block, so which theme-schema map applies flips
// exactly once, at the top, and stays fixed for everything nested
// underneath.
function extractApiFields(
  sections: InstanceLike[] | undefined,
  sectionSchemas: Record<string, object>,
  blockSchemas: Record<string, object>,
): ApiFieldRow[] {
  const rows: ApiFieldRow[] = [];
  const walk = (list: InstanceLike[] | undefined, schemaMap: Record<string, object>): void => {
    if (!list) {
      return;
    }
    for (const instance of list) {
      extractInstanceApiFields(instance, schemaMap, rows);
      walk(instance.blocks, blockSchemas);
    }
  };
  walk(sections, sectionSchemas);
  return rows;
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

  const themeSchemas = loadThemeSchemas(config.themeRoot);
  const driver = openNodeSqliteDriver(config.searchIndexPath);
  try {
    driver.exec('CREATE VIRTUAL TABLE pages_fts USING fts5(url UNINDEXED, title, body, page_type UNINDEXED)');
    // A plain table, not FTS5 - page_fields holds typed, exact/range-
    // comparable values (a price, a rating), the opposite of pages_fts's
    // own free-text matching. One row per exposed field per instance
    // (not one column per field name): a page can carry several
    // instances of the same block type (several "product" blocks on one
    // listing page), each with its own value, and different pages may
    // expose entirely different field sets - a fixed column-per-field
    // schema can't accommodate either. No foreign key back to
    // pages_fts.url - this whole index is disposable and rebuilt wholly
    // from scratch every time, same as pages_fts itself.
    driver.exec(
      'CREATE TABLE page_fields (url TEXT NOT NULL, block_type TEXT NOT NULL, instance_id TEXT NOT NULL, field_key TEXT NOT NULL, value_text TEXT, value_number REAL, value_bool INTEGER)',
    );
    driver.exec('CREATE INDEX page_fields_field_key ON page_fields (field_key)');
    const insert = driver.prepare('INSERT INTO pages_fts (url, title, body, page_type) VALUES (?, ?, ?, ?)');
    const insertField = driver.prepare(
      'INSERT INTO page_fields (url, block_type, instance_id, field_key, value_text, value_number, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

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
        const pageType = typeof page.type === 'string' ? page.type : '';
        const body = extractBody(page.sections);
        insert.run(url, title, body, pageType);

        for (const row of extractApiFields(page.sections, themeSchemas.sections, themeSchemas.blocks)) {
          insertField.run(url, row.blockType, row.instanceId, row.fieldKey, row.valueText, row.valueNumber, row.valueBool);
        }
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
