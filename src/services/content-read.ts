import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { computeEtag } from './etag.ts';
import { listFilesRecursively } from './fs-walk.ts';
import { sanitisePath } from './path-safety.ts';

export type ContentReadReason = 'not-found';

export class ContentReadError extends Error {
  readonly reason: ContentReadReason;

  constructor(reason: ContentReadReason, message: string) {
    super(message);
    this.name = 'ContentReadError';
    this.reason = reason;
  }
}

export interface ReadResult {
  bytes: Buffer;
  etag: string;
}

// Shared by both content.ts (root = config.contentRoot) and drafts.ts
// (root = config.draftsRoot) - identical read+hash logic, just a
// different root. sanitisePath's PathSafetyError is left to propagate
// uncaught: the route handlers catch it explicitly and map it to 404,
// the same precedent preview.ts already established (PathSafetyError
// has no .statusCode, so left uncaught it would fall through to the
// global handler's generic sanitised 500).
export function readContentFile(root: string, relativePath: string): ReadResult {
  const fullPath = sanitisePath(root, relativePath);
  if (!existsSync(fullPath)) {
    throw new ContentReadError('not-found', `No file at "${relativePath}"`);
  }
  const bytes = readFileSync(fullPath);
  return { bytes, etag: computeEtag(bytes) };
}

export interface ContentListFilters {
  type?: string;
  prefix?: string;
  draftStatus?: 'has-draft' | 'no-draft';
}

export interface ContentListEntry {
  path: string;
  title: string;
  type: string;
  published: boolean;
  hasDraft: boolean;
}

interface PageSummaryShape {
  title?: unknown;
  type?: unknown;
  published?: unknown;
}

// Defensive, not the strict PageContent shape from render-page.ts:
// boot.ts deliberately never auto-migrates content at startup, so a
// file sitting at an old schemaVersion (and therefore missing a field
// as new as "type") is a real, persistent possibility, not a
// hypothetical - matching rebuild-index.ts's PageForIndex precedent.
function readSummary(fullPath: string): PageSummaryShape | null {
  try {
    return JSON.parse(readFileSync(fullPath, 'utf-8')) as PageSummaryShape;
  } catch {
    return null;
  }
}

// GET /v1/content lists the union of contentRoot and draftsRoot paths,
// not live content alone: Group D's own checklist heading is "content
// AND draft reads", and there is no separate "list drafts" endpoint
// anywhere in the build plan - this is the only place a draft-only
// page (never yet published) is discoverable at all.
export function listContent(config: SiteConfig, filters: ContentListFilters): ContentListEntry[] {
  const contentPaths = new Set(listFilesRecursively(config.contentRoot, config.contentRoot, '.json'));
  const draftPaths = new Set(listFilesRecursively(config.draftsRoot, config.draftsRoot, '.json'));

  const allPaths = new Set([...contentPaths, ...draftPaths]);
  const entries: ContentListEntry[] = [];

  for (const relativePath of allPaths) {
    const hasDraft = draftPaths.has(relativePath);
    const hasLive = contentPaths.has(relativePath);

    // Prefer the live file's fields on conflict - the draft is a
    // pending edit, not yet the source of truth for a content
    // inventory view - but hasDraft still reports the draft's
    // presence either way.
    const summary = hasLive
      ? readSummary(join(config.contentRoot, relativePath))
      : readSummary(join(config.draftsRoot, relativePath));
    if (!summary) {
      continue;
    }

    const entry: ContentListEntry = {
      path: relativePath,
      title: typeof summary.title === 'string' ? summary.title : '',
      type: typeof summary.type === 'string' ? summary.type : '',
      published: summary.published === true,
      hasDraft,
    };

    if (filters.type !== undefined && entry.type !== filters.type) {
      continue;
    }
    if (filters.prefix !== undefined && !entry.path.startsWith(filters.prefix)) {
      continue;
    }
    if (filters.draftStatus === 'has-draft' && !entry.hasDraft) {
      continue;
    }
    if (filters.draftStatus === 'no-draft' && entry.hasDraft) {
      continue;
    }

    entries.push(entry);
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}
