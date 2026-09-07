import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { SiteConfig } from '../config.ts';
import { listFilesRecursively } from '../services/fs-walk.ts';
import { loadThemeSchemas } from '../services/theme-schemas.ts';
import { pagePathToUrl } from '../services/urls.ts';
import { enqueue } from '../services/write-queue.ts';
import { openNodeSqliteDriver } from './drivers/node-sqlite-driver.ts';

// How many content files the rebuild loop processes between yields to
// the event loop (see the yield's own comment below for why this
// exists at all). Large enough that setImmediate's own overhead is
// negligible next to the real per-file work (a parse plus several
// SQLite inserts); small enough that no single slice runs long enough
// to meaningfully stall another request. Not a config knob - no
// evidence yet this needs to be tunable per site.
const YIELD_EVERY_N_FILES = 25;

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
  author?: unknown;
  publishDate?: unknown;
  tags?: unknown;
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

// Epoch milliseconds for a date-like string - undefined if it doesn't
// parse, so a malformed date is silently skipped rather than indexed
// as a nonsensical NaN row (the same "malformed input skipped, not a
// rebuild failure" tolerance every other part of this pipeline
// already has for a bad file or a missing theme type).
function parseDateValue(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Turns one raw value into ApiFieldRow entries for a given field key -
// shared by both theme-flagged fields (extractInstanceApiFields below)
// and the built-in post envelope fields (extractEnvelopeApiFields),
// since both need the identical "what does this value actually mean
// for indexing" logic. Three shapes:
// - an array: one row per scalar element, all under the same
//   fieldKey (e.g. a post's own "tags") - a plain "eq" filter then
//   matches via the exact same mechanism a single-valued field already
//   uses, no separate array-aware query logic needed anywhere else.
// - a date-like string (isDateField true - a theme field schema'd
//   "type": "string", "format": "date", reusing the existing format
//   convention, or the post envelope's own publishDate): stored as an
//   epoch-ms number in valueNumber, not text, so range operators work
//   on it through the same numeric path a flagged price field uses.
// - a plain scalar (string/number/boolean): stored in its own typed
//   column. Anything else (object, null, undefined) has nothing
//   sensible to store or compare and is silently skipped, the same way
//   a malformed schema block already is elsewhere in this pipeline.
function pushFieldValue(
  blockType: string,
  instanceId: string,
  fieldKey: string,
  value: unknown,
  isDateField: boolean,
  out: ApiFieldRow[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      pushFieldValue(blockType, instanceId, fieldKey, item, isDateField, out);
    }
    return;
  }
  if (typeof value === 'string' && isDateField) {
    const epoch = parseDateValue(value);
    if (epoch !== undefined) {
      out.push({ blockType, instanceId, fieldKey, valueText: null, valueNumber: epoch, valueBool: null });
    }
    return;
  }
  if (typeof value === 'string') {
    out.push({ blockType, instanceId, fieldKey, valueText: value, valueNumber: null, valueBool: null });
  } else if (typeof value === 'number') {
    out.push({ blockType, instanceId, fieldKey, valueText: null, valueNumber: value, valueBool: null });
  } else if (typeof value === 'boolean') {
    out.push({ blockType, instanceId, fieldKey, valueText: null, valueNumber: null, valueBool: value ? 1 : 0 });
  }
}

// Reads schema.properties for the given instance's own type, keeping
// only properties explicitly flagged "api": true (an unvalidated,
// theme-authored JSON Schema keyword - same status as "format"/
// "allowedBlocks", see docs/theme-authoring-guide.md and
// services/validation.ts's own allowedBlockTypesOf) - and pairs each
// with its actual value out of instance.settings via pushFieldValue.
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
    const schema = propSchema as { api?: unknown; type?: unknown; format?: unknown } | null;
    if (schema?.api !== true) {
      continue;
    }
    const isDateField = schema.type === 'string' && schema.format === 'date';
    pushFieldValue(type, id, key, settings[key], isDateField, out);
  }
}

// Built-in envelope fields, auto-indexed with no "api": true needed -
// author/publishDate/tags are optional on every page (page.schema.json),
// so indexing is presence-based rather than gated on a specific "type"
// value: any page carrying one of these fields gets it indexed,
// regardless of what its own type string is. block_type '__page__' is a
// sentinel (never a real theme type, which always matches a *.liquid
// filename) marking these rows as envelope-level rather than a real
// section/block instance; instanceId is the page's own url - stable
// and unique enough, since there's exactly one envelope per page.
function extractEnvelopeApiFields(page: PageForIndex, url: string): ApiFieldRow[] {
  const rows: ApiFieldRow[] = [];
  pushFieldValue('__page__', url, 'author', page.author, false, rows);
  pushFieldValue('__page__', url, 'publishDate', page.publishDate, true, rows);
  pushFieldValue('__page__', url, 'tags', page.tags, false, rows);
  return rows;
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

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

// A fresh sqlite file is never actually left in WAL mode by this
// module (nothing here turns that on), but cleaning up any stray
// -wal/-shm sidecar files defensively costs nothing and avoids ever
// leaving one behind next to an abandoned temp build.
function cleanupSqliteArtifacts(path: string): void {
  unlinkIfExists(path);
  unlinkIfExists(`${path}-wal`);
  unlinkIfExists(`${path}-shm`);
}

async function rebuildIndexJob(config: SiteConfig): Promise<void> {
  mkdirSync(config.dataRoot, { recursive: true });

  // Built into a fresh temp file, then renamed atomically over the
  // real path (below) - not the old delete-then-recreate-in-place
  // approach, which left a real window where a concurrent read saw
  // either a missing file or one that exists but has no tables in it
  // yet. POSIX rename() is atomic: a reader always sees either the
  // complete old index or the complete new one, never an in-between
  // state, and never has to retry an open that landed in the gap.
  const tmpPath = `${config.searchIndexPath}.tmp-${randomUUID()}`;
  cleanupSqliteArtifacts(tmpPath);

  const themeSchemas = loadThemeSchemas(config.themeRoot);
  try {
    const driver = openNodeSqliteDriver(tmpPath);
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
      // Composite, not a bare field_key index - field_key alone only
      // narrows to one field's rows; leading with it here still serves
      // that same narrowing (the leftmost-column rule), but the second
      // column also covers the typed value comparison itself (an
      // equality or range check) without a further per-row scan. url
      // supports the self-join a multi-field query ANDs together
      // (queryContent, query-content.ts) - with no index there, ANDing a
      // second filter means scanning page_fields in full for every row
      // the first filter matched.
      driver.exec('CREATE INDEX page_fields_key_number ON page_fields (field_key, value_number)');
      driver.exec('CREATE INDEX page_fields_key_text ON page_fields (field_key, value_text)');
      driver.exec('CREATE INDEX page_fields_url ON page_fields (url)');
      const insert = driver.prepare('INSERT INTO pages_fts (url, title, body, page_type) VALUES (?, ?, ?, ?)');
      const insertField = driver.prepare(
        'INSERT INTO page_fields (url, block_type, instance_id, field_key, value_text, value_number, value_bool) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );

      // Menus are deliberately never walked here at all: they have no
      // public URL to point a search result at.
      const collections = [{ root: config.pagesRoot, toUrl: pagePathToUrl }];

      driver.exec('BEGIN');
      let filesExamined = 0;
      for (const { root, toUrl } of collections) {
        for (const relativePath of listFilesRecursively(root, root, '.json')) {
          // A genuine macrotask yield (setImmediate, not a microtask like
          // Promise.resolve()/queueMicrotask - Node drains every queued
          // microtask before the event loop ever reaches its I/O phases,
          // so a chain of only-microtask yields still fully blocks an
          // incoming HTTP request from being processed). Without this,
          // this loop's entire body - potentially thousands of files -
          // runs as one uninterruptible synchronous block: since Node is
          // single-threaded, that means every other request the server
          // is handling (auth, content reads, publishes) stalls for the
          // rebuild's whole duration, not just other search queries.
          // Counted once per file examined regardless of whether it
          // ends up skipped below, so the cadence tracks total work
          // done, not just files actually indexed.
          filesExamined += 1;
          if (filesExamined % YIELD_EVERY_N_FILES === 0) {
            await yieldToEventLoop();
          }

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

          const apiFields = [
            ...extractApiFields(page.sections, themeSchemas.sections, themeSchemas.blocks),
            ...extractEnvelopeApiFields(page, url),
          ];
          for (const row of apiFields) {
            insertField.run(url, row.blockType, row.instanceId, row.fieldKey, row.valueText, row.valueNumber, row.valueBool);
          }
        }
      }
      driver.exec('COMMIT');
    } finally {
      driver.close();
    }

    renameSync(tmpPath, config.searchIndexPath);
  } catch (error) {
    cleanupSqliteArtifacts(tmpPath);
    throw error;
  }
}

// Queued via enqueue() - two concurrent rebuilds could otherwise both
// build their own temp file and both attempt the final rename; the
// second rename would still win cleanly (rename() just replaces
// whatever is there), but the first rebuild's now-orphaned temp file
// would never get cleaned up. enqueue() is a generic, domain-agnostic
// primitive, so reusing it for self-exclusion costs nothing.
export function rebuildIndex(config: SiteConfig): Promise<void> {
  return enqueue(() => rebuildIndexJob(config));
}
