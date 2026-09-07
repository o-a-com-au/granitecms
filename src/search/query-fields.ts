import { openNodeSqliteDriver } from './drivers/node-sqlite-driver.ts';

export type FieldOp = 'eq' | 'gt' | 'gte' | 'lt' | 'lte';

export interface FieldQueryParams {
  fieldKey: string;
  op: FieldOp;
  value: string;
  pageType?: string;
}

export interface FieldQueryResult {
  url: string;
  title: string;
  pageType: string;
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

// Never queued - same reasoning query-index.ts documents for its own
// read: an in-flight query holding an open handle during a concurrent
// rebuild's unlink just keeps reading the pre-rebuild inode (stale but
// consistent, never torn).
export function queryFields(searchIndexPath: string, params: FieldQueryParams): FieldQueryResult[] {
  const driver = openNodeSqliteDriver(searchIndexPath);
  try {
    const conditions = ['pf.field_key = ?'];
    const args: unknown[] = [params.fieldKey];

    if (params.op === 'eq') {
      // A field's value only ever lives in ONE of value_text/value_
      // number/value_bool (rebuild-index.ts's own extractInstanceApiFields),
      // so only the branches the incoming string could actually
      // represent are included - a text field's own row has value_number
      // NULL, and SQLite's = against NULL is never true, so there's no
      // need to positively exclude it, just nothing to gain from
      // comparing against it either.
      const branches = ['pf.value_text = ?'];
      args.push(params.value);
      const numeric = toFiniteNumber(params.value);
      if (numeric !== undefined) {
        branches.push('pf.value_number = ?');
        args.push(numeric);
      }
      if (params.value === 'true' || params.value === 'false') {
        branches.push('pf.value_bool = ?');
        args.push(params.value === 'true' ? 1 : 0);
      }
      conditions.push(`(${branches.join(' OR ')})`);
    } else {
      // Range operators only ever compare the numeric column - a text
      // or boolean field's own rows have value_number NULL, so they
      // simply never match, rather than needing a separate type check.
      const numeric = toFiniteNumber(params.value);
      if (numeric === undefined) {
        // The route validates this before ever calling in (a numeric
        // op paired with a non-numeric value is a 400) - reaching here
        // regardless just means "nothing could possibly match", not an
        // error this layer needs to raise itself.
        return [];
      }
      conditions.push(`pf.value_number ${COMPARATORS[params.op]} ?`);
      args.push(numeric);
    }

    if (params.pageType !== undefined) {
      conditions.push('f.page_type = ?');
      args.push(params.pageType);
    }

    // JOIN against pages_fts (a virtual FTS5 table) on its own
    // UNINDEXED url/page_type columns - plain equality on an UNINDEXED
    // column is exactly what that keyword is for (see rebuild-index.ts's
    // own comment), the same "store/retrieve, never full-text match"
    // role url already had before page_type joined it.
    // ORDER BY url - SQLite gives no ordering guarantee at all without
    // one (not insertion order, not any other implicit order a query
    // plan happens to produce today), so callers get a deterministic
    // result every time rather than an incidental one that could shift
    // if the query plan ever changes.
    const sql = `SELECT DISTINCT pf.url, f.title, f.page_type FROM page_fields pf JOIN pages_fts f ON f.url = pf.url WHERE ${conditions.join(' AND ')} ORDER BY pf.url`;
    const rows = driver.prepare(sql).all(...args);
    // node:sqlite returns rows as [Object: null prototype] instances -
    // rebuilt here as plain objects, same reasoning query-index.ts's
    // own mapping already documents.
    return rows.map((row) => {
      const { url, title, page_type: pageType } = row as { url: string; title: string; page_type: string };
      return { url, title, pageType };
    });
  } finally {
    driver.close();
  }
}
