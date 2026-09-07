import { existsSync } from 'node:fs';
import { openNodeSqliteDriver } from './drivers/node-sqlite-driver.ts';

export type FieldOp = 'eq' | 'gt' | 'gte' | 'lt' | 'lte';

export interface FieldFilter {
  field: string;
  op: FieldOp;
  value: string;
}

export interface SortParam {
  field: string;
  direction: 'asc' | 'desc';
}

export interface SearchParams {
  q?: string;
  pageType?: string;
  filters: FieldFilter[];
  sort?: SortParam;
  limit: number;
  offset: number;
}

export type FieldValue = string | number | boolean;

export interface SearchResultItem {
  url: string;
  title: string;
  pageType: string;
  fields: Record<string, FieldValue | FieldValue[]>;
}

export interface SearchResponse {
  results: SearchResultItem[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

function toFiniteNumber(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const COMPARATORS: Record<Exclude<FieldOp, 'eq'>, string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

// Never passes raw user input straight into FTS5 MATCH - a public
// search box gets real, messy input (unbalanced quotes, a lone
// trailing "-", a word FTS5 treats as an operator like "AND" or "NOT")
// which throws a syntax error against a bare MATCH ? (the previous
// query-index.ts never guarded this at all). Each whitespace-separated
// token becomes its own quoted, prefix-matched literal - "hello world"
// becomes "hello"* AND "world"*, embedded quotes doubled per FTS5's own
// escaping rule - so the constructed expression can never be
// misinterpreted as an operator, regardless of what the user typed.
function buildMatchExpression(q: string): string | undefined {
  const tokens = q
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return undefined;
  }
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ');
}

// One INNER JOIN per filter - a page must satisfy every filter to
// appear at all, so a page missing that field entirely (or with a
// non-matching value) is correctly excluded, not just left with a
// null comparison. Same typed-column branch logic query-fields.ts
// (now retired) already proved out for a single filter.
function buildFilterJoin(alias: string, filter: FieldFilter): { sql: string; args: unknown[] } {
  const args: unknown[] = [filter.field];
  if (filter.op === 'eq') {
    const branches = [`${alias}.value_text = ?`];
    args.push(filter.value);
    const numeric = toFiniteNumber(filter.value);
    if (numeric !== undefined) {
      branches.push(`${alias}.value_number = ?`);
      args.push(numeric);
    }
    if (filter.value === 'true' || filter.value === 'false') {
      branches.push(`${alias}.value_bool = ?`);
      args.push(filter.value === 'true' ? 1 : 0);
    }
    return {
      sql: `JOIN page_fields ${alias} ON ${alias}.url = f.url AND ${alias}.field_key = ? AND (${branches.join(' OR ')})`,
      args,
    };
  }

  const numeric = toFiniteNumber(filter.value);
  if (numeric === undefined) {
    // The route validates a numeric op against a numeric value before
    // ever calling in - reaching here regardless just means "nothing
    // could possibly match", not an error this layer needs to raise.
    return { sql: `JOIN page_fields ${alias} ON ${alias}.url = f.url AND ${alias}.field_key = ? AND 1 = 0`, args };
  }
  args.push(numeric);
  return {
    sql: `JOIN page_fields ${alias} ON ${alias}.url = f.url AND ${alias}.field_key = ? AND ${alias}.value_number ${COMPARATORS[filter.op]} ?`,
    args,
  };
}

// LEFT, not INNER - unlike a filter, sorting by a field a given page
// doesn't have shouldn't drop that page from the results, just leave
// it ordered with a null value (SQLite sorts NULL first in ASC order).
// COALESCE across both typed columns since this layer has no schema in
// hand at query time to know in advance which one a given field
// actually uses.
function buildSortJoin(field: string): { sql: string; args: unknown[]; column: string } {
  return {
    sql: 'LEFT JOIN page_fields sort_field ON sort_field.url = f.url AND sort_field.field_key = ?',
    args: [field],
    column: 'COALESCE(sort_field.value_number, sort_field.value_text)',
  };
}

interface MainRow {
  url: string;
  title: string;
  page_type: string;
}

interface FieldRow {
  url: string;
  field_key: string;
  value_text: string | null;
  value_number: number | null;
  value_bool: number | null;
}

function fieldRowValue(row: FieldRow): FieldValue | undefined {
  if (row.value_text !== null) {
    return row.value_text;
  }
  if (row.value_number !== null) {
    return row.value_number;
  }
  if (row.value_bool !== null) {
    return row.value_bool === 1;
  }
  return undefined;
}

// The one query surface a front-end talks to directly - covers a
// blog listing (pageType + sort by publishDate + pagination), a
// product grid (several ANDed filters + sort by a numeric field), and
// general site search (q), rather than three narrow endpoints each
// covering one of those. Two queries total, never N+1: one for the
// (already paginated) matching urls, one gathering every indexed
// field for just that page of urls to build each result's own
// "fields" map - a product grid needs price to render, not just to
// have matched.
export function queryContent(searchIndexPath: string, params: SearchParams): SearchResponse {
  // readOnly: true (below) throws if the file doesn't exist rather
  // than silently auto-creating an empty one the way a normal open
  // would - checked here instead, so "no rebuild has ever run yet" (a
  // real, expected state for a brand new site) reads as an empty
  // result set, not a 500.
  if (!existsSync(searchIndexPath)) {
    return { results: [], limit: params.limit, offset: params.offset, hasMore: false };
  }

  const driver = openNodeSqliteDriver(searchIndexPath, { readOnly: true, timeout: 2000 });
  try {
    const joins: string[] = [];
    const joinArgs: unknown[] = [];
    params.filters.forEach((filter, index) => {
      const built = buildFilterJoin(`pf${index}`, filter);
      joins.push(built.sql);
      joinArgs.push(...built.args);
    });

    const where: string[] = [];
    const whereArgs: unknown[] = [];
    const matchExpression = params.q ? buildMatchExpression(params.q) : undefined;
    if (matchExpression) {
      // FTS5's own "tbl MATCH expr" special syntax only recognises the
      // real table name here, not an alias (confirmed live - "f MATCH
      // ?" throws "no such column: f" even though ordinary column
      // references through the same alias work fine everywhere else in
      // this query).
      where.push('pages_fts MATCH ?');
      whereArgs.push(matchExpression);
    }
    if (params.pageType !== undefined) {
      where.push('f.page_type = ?');
      whereArgs.push(params.pageType);
    }

    let orderJoin = '';
    const orderJoinArgs: unknown[] = [];
    let orderBy = 'f.url ASC';
    if (params.sort) {
      const built = buildSortJoin(params.sort.field);
      orderJoin = built.sql;
      orderJoinArgs.push(...built.args);
      orderBy = `${built.column} ${params.sort.direction === 'desc' ? 'DESC' : 'ASC'}`;
    } else if (matchExpression) {
      // FTS5's own bm25-derived rank: more negative is more relevant,
      // so plain ascending order is "best match first".
      orderBy = 'rank';
    }

    const sql = [
      'SELECT DISTINCT f.url, f.title, f.page_type',
      'FROM pages_fts f',
      ...joins,
      orderJoin,
      where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      `ORDER BY ${orderBy}`,
      'LIMIT ? OFFSET ?',
    ]
      .filter((part) => part !== '')
      .join(' ');

    // Request one extra row to know whether there's a next page,
    // rather than a separate COUNT(*) query - a real, doubled cost on
    // every single paginated request neither stated use case (infinite
    // scroll, a grid's own "next" button) actually needs an exact
    // total for.
    const args = [...joinArgs, ...orderJoinArgs, ...whereArgs, params.limit + 1, params.offset];
    const mainRows = driver.prepare(sql).all(...args) as MainRow[];
    const hasMore = mainRows.length > params.limit;
    const pageRows = mainRows.slice(0, params.limit);

    const fieldsByUrl = new Map<string, Record<string, FieldValue | FieldValue[]>>();
    if (pageRows.length > 0) {
      const placeholders = pageRows.map(() => '?').join(', ');
      const fieldRows = driver
        .prepare(
          `SELECT url, field_key, value_text, value_number, value_bool FROM page_fields WHERE url IN (${placeholders})`,
        )
        .all(...pageRows.map((row) => row.url)) as FieldRow[];
      for (const row of fieldRows) {
        const value = fieldRowValue(row);
        if (value === undefined) {
          continue;
        }
        const entry = fieldsByUrl.get(row.url) ?? {};
        const existing = entry[row.field_key];
        if (existing === undefined) {
          entry[row.field_key] = value;
        } else if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          entry[row.field_key] = [existing, value];
        }
        fieldsByUrl.set(row.url, entry);
      }
    }

    const results: SearchResultItem[] = pageRows.map((row) => ({
      url: row.url,
      title: row.title,
      pageType: row.page_type,
      fields: fieldsByUrl.get(row.url) ?? {},
    }));

    return { results, limit: params.limit, offset: params.offset, hasMore };
  } finally {
    driver.close();
  }
}
