import { existsSync, readFileSync } from 'node:fs';
import type { SiteConfig } from '../config.ts';
import { validateRedirects } from './validation.ts';

export type RedirectReason = 'redirect-cycle' | 'malformed-file' | 'invalid-target';

export class RedirectError extends Error {
  readonly reason: RedirectReason;

  constructor(reason: RedirectReason, message: string) {
    super(message);
    this.name = 'RedirectError';
    this.reason = reason;
  }
}

export interface RedirectEntry {
  from: string;
  to: string;
  note?: string;
}

export interface Redirects {
  schemaVersion: number;
  entries: RedirectEntry[];
}

export const CURRENT_REDIRECTS_SCHEMA_VERSION = 1;

const EMPTY_REDIRECTS: Redirects = { schemaVersion: CURRENT_REDIRECTS_SCHEMA_VERSION, entries: [] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The old shape (pre-Group M) was a flat { from: to } map, with no
// schemaVersion or entries key at all. Identified purely by the
// ABSENCE of both new-shape keys - a file that has an `entries` key is
// always treated as new-shape from here on, even if malformed, so a
// corrupt new-shape file is never silently reinterpreted as an empty
// old-shape map (which would look like "no redirects" and risk a
// write-time caller clobbering real data - see loadRedirectsStrict).
function isOldFlatShape(value: Record<string, unknown>): boolean {
  return !('schemaVersion' in value) && !('entries' in value);
}

function upgradeOldFlatShape(value: Record<string, unknown>): Redirects {
  const entries: RedirectEntry[] = Object.entries(value)
    .filter((pair): pair is [string, string] => typeof pair[1] === 'string')
    .map(([from, to]) => ({ from, to }));
  return { schemaVersion: CURRENT_REDIRECTS_SCHEMA_VERSION, entries };
}

// Read-time loader, used by public request handling (resolve-url.ts,
// resolve-blog-url.ts) as well as by write paths before they call
// loadRedirectsStrict for the extra guarantee. Graceful-empty on any
// failure - including a malformed new-shape file - matching
// theme-schemas.ts's established pattern: a corrupt redirects.json
// must never crash public page serving, it should just mean redirects
// don't resolve until the file is fixed.
export function loadRedirects(config: SiteConfig): Redirects {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(config.redirectsPath, 'utf-8'));
  } catch {
    return EMPTY_REDIRECTS;
  }

  if (!isPlainObject(raw)) {
    return EMPTY_REDIRECTS;
  }

  if (isOldFlatShape(raw)) {
    return upgradeOldFlatShape(raw);
  }

  const result = validateRedirects(raw);
  if (!result.valid) {
    return EMPTY_REDIRECTS;
  }
  return raw as unknown as Redirects;
}

// Stricter sibling of loadRedirects, for write paths only (manage-
// redirects.ts, and any other future direct redirect writer). Unlike
// the graceful read-time loader, this throws on a malformed new-shape
// file instead of silently treating it as empty - a write that follows
// an incorrectly-"empty" load would overwrite and destroy whatever
// real entries the file actually held, which is a much worse outcome
// for a write than for a page render.
export function loadRedirectsStrict(config: SiteConfig): Redirects {
  if (!existsSync(config.redirectsPath)) {
    return EMPTY_REDIRECTS;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(config.redirectsPath, 'utf-8'));
  } catch {
    throw new RedirectError(
      'malformed-file',
      'redirects.json exists but is not valid JSON; refusing to write until it is fixed',
    );
  }

  if (!isPlainObject(raw)) {
    throw new RedirectError('malformed-file', 'redirects.json exists but is not a JSON object');
  }

  if (isOldFlatShape(raw)) {
    return upgradeOldFlatShape(raw);
  }

  const result = validateRedirects(raw);
  if (!result.valid) {
    throw new RedirectError(
      'malformed-file',
      `redirects.json exists but does not match the expected shape: ${result.errors.map((e) => e.message).join(', ')}`,
    );
  }
  return raw as unknown as Redirects;
}

export function serialiseRedirects(entries: RedirectEntry[]): string {
  const redirects: Redirects = { schemaVersion: CURRENT_REDIRECTS_SCHEMA_VERSION, entries };
  return JSON.stringify(redirects, null, 2);
}

export function buildRedirectLookup(entries: RedirectEntry[]): Map<string, string> {
  return new Map(entries.map((entry) => [entry.from, entry.to]));
}

export interface AddRedirectResult {
  entries: RedirectEntry[];
  // Existing entries whose `to` was rewritten by chain-collapse as a
  // side effect of this add (post-rewrite state) - callers that expose
  // this to a human (manage-redirects.ts) should surface it, since an
  // entry with a human-authored note can be silently retargeted here.
  retargeted: RedirectEntry[];
}

// Collapses chains at write time. Walks `to` forward through any
// existing chain to its final destination (not just one hop), then
// rewrites every existing entry that pointed at the just-added `from`
// to point at that final destination too, so old entries stay
// collapsed alongside the new one. Also handles updating an existing
// entry in place: if `from` already has an entry, it is replaced.
export function addRedirect(
  entries: RedirectEntry[],
  from: string,
  to: string,
  note?: string,
): AddRedirectResult {
  const byFrom = new Map(entries.map((entry) => [entry.from, entry]));
  let target = to;
  const visited = new Set<string>();

  for (;;) {
    const next = byFrom.get(target)?.to;
    if (next === undefined) {
      break;
    }
    if (visited.has(target)) {
      throw new RedirectError(
        'redirect-cycle',
        `redirects.json already contains a cycle reachable from "${to}"`,
      );
    }
    visited.add(target);
    target = next;
  }

  // The walk above only detects a cycle among *pre-existing* entries.
  // A walk that terminates normally can still resolve back to `from`
  // itself (e.g. adding "/b" -> "/a" when "/a" -> "/b" already exists:
  // the walk hits "/b", which has no further mapping, and stops without
  // revisiting anything) - that's a self-referential redirect, checked
  // separately here.
  if (target === from) {
    throw new RedirectError(
      'redirect-cycle',
      `Adding redirect "${from}" -> "${to}" would create a cycle (resolves back to "${from}")`,
    );
  }

  const retargeted: RedirectEntry[] = [];
  const updated: RedirectEntry[] = [];

  for (const entry of entries) {
    if (entry.from === from) {
      continue;
    }
    if (entry.to === from) {
      const rewritten: RedirectEntry = { ...entry, to: target };
      retargeted.push(rewritten);
      updated.push(rewritten);
      continue;
    }
    updated.push(entry);
  }

  const newEntry: RedirectEntry = note !== undefined ? { from, to: target, note } : { from, to: target };
  updated.push(newEntry);

  return { entries: updated, retargeted };
}

export function removeRedirectForPath(entries: RedirectEntry[], url: string): RedirectEntry[] {
  if (!entries.some((entry) => entry.from === url)) {
    return entries;
  }
  return entries.filter((entry) => entry.from !== url);
}

// Checked by char code rather than a regex control-character class, to
// avoid embedding literal control characters in source.
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

// Shared by manage-redirects.ts (POST/PUT /v1/redirects) and the
// retroactive fix to delete-content.ts's client-supplied redirectTo -
// both must enforce the same rule on a redirect target, or the two
// write paths would silently disagree on what's allowed into the same
// file. Internal-only: must start with a single "/", never a scheme,
// host, or protocol-relative "//" - closes an open-redirect vector.
// Control characters are rejected regardless of the internal/external
// question, since public.ts writes this value directly into the
// Location response header.
export function isValidRedirectTarget(value: string): boolean {
  if (value.length === 0 || hasControlCharacter(value)) {
    return false;
  }
  return value.startsWith('/') && !value.startsWith('//');
}
