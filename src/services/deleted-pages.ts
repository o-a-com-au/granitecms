import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { SiteConfig } from '../config.ts';
import { readFileAtRevision } from './git-history.ts';
import { sanitisePath } from './path-safety.ts';
import { pagePathToUrl } from './urls.ts';

// Pages deleted in the last 90 days that aren't back: what the admin's "Recently
// deleted" lists, each restorable from the commit just before it was
// deleted (POST /v1/git/revert with ref and the page's path). Read from
// git's own record of deletions, so nothing extra is stored - a delete
// is already a commit. A page moved elsewhere isn't a deletion (git sees
// a rename), and a page that exists again, live or as a draft, is left
// out.
export interface DeletedPage {
  // Content-relative, e.g. "pages/old-offers.json".
  path: string;
  url: string;
  // The page's name, as the admin's page tree shows it.
  name: string;
  title: string;
  deletedAt: string;
  deletedBy: string;
  // The version to restore: the commit before the delete.
  ref: string;
}

const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';
const DEFAULT_LIMIT = 50;
// How far back "recently" reaches (agreed with the owner). Older deletions
// can still be restored from git; they just aren't listed.
const RECENT_DAYS = 90;

function hasCommits(config: SiteConfig): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: config.siteRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function existsNow(config: SiteConfig, path: string): boolean {
  try {
    return existsSync(sanitisePath(config.contentRoot, path)) || (existsSync(config.draftsRoot) && existsSync(sanitisePath(config.draftsRoot, path)));
  } catch {
    return false;
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// The page's name and title as they were at ref, each falling back to
// the other (and to its address) when missing.
function labelsAt(config: SiteConfig, ref: string, path: string, url: string): { name: string; title: string } {
  let name: string | null = null;
  let title: string | null = null;
  try {
    const page = JSON.parse(readFileAtRevision(config, ref, `content/${path}`).toString('utf-8')) as { title?: unknown; name?: unknown };
    name = nonEmpty(page.name);
    title = nonEmpty(page.title);
  } catch {
    // Unreadable at ref: fall back to the address.
  }
  return { name: name ?? title ?? url, title: title ?? name ?? url };
}

export function listDeletedPages(config: SiteConfig, limit = DEFAULT_LIMIT): DeletedPage[] {
  if (!hasCommits(config)) {
    return [];
  }
  const raw = execFileSync(
    'git',
    ['log', `--since=${RECENT_DAYS} days ago`, '--diff-filter=D', '--name-only', `--format=${RECORD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%aI`, '--', 'content/pages'],
    { cwd: config.siteRoot, maxBuffer: 32 * 1024 * 1024 },
  ).toString('utf-8');

  const seen = new Set<string>();
  const deleted: DeletedPage[] = [];
  for (const record of raw.split(RECORD_SEP)) {
    const [header, ...files] = record.split('\n');
    // %P: the deleting commit's parent - the last version with the page.
    // A full commit id, since refs like "abc^" aren't accepted.
    const [parents, author, date] = (header ?? '').split(FIELD_SEP);
    const parent = parents?.split(' ')[0];
    if (!parent || !author || !date) {
      continue;
    }
    for (const file of files) {
      const path = file.trim().replace(/^content\//, '');
      if (!/^pages\/.+\.json$/.test(path) || seen.has(path)) {
        continue;
      }
      // Most recent deletion first: an older one of the same path is
      // history, not something to restore.
      seen.add(path);
      if (existsNow(config, path)) {
        continue;
      }
      const ref = parent;
      const url = pagePathToUrl(path.slice('pages/'.length));
      deleted.push({ path, url, ...labelsAt(config, ref, path, url), deletedAt: date, deletedBy: author, ref });
      if (deleted.length >= limit) {
        return deleted;
      }
    }
  }
  return deleted;
}
