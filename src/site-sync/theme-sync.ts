import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { listFilesRecursively } from '../services/fs-walk.ts';
import { sanitisePath } from '../services/path-safety.ts';
import { hashThemeFile, isValidThemePath } from '../services/theme-files.ts';
import { encodePath } from './live-content.ts';
import { SiteSyncError, type RemoteSite } from './remote-site.ts';

// A theme file as listed by the live site: its hash is of the exact
// bytes (unlike pages, the site stores theme files exactly as sent).
export type LiveTheme = Map<string, string>;

// Either the live theme, or why theme sync isn't possible with this
// site and token - not an error, since pulling or pushing content alone
// is still fine.
export type LiveThemeResult = { theme: LiveTheme } | { unavailable: string };

export async function fetchLiveTheme(remote: RemoteSite): Promise<LiveThemeResult> {
  let response: Response | null;
  try {
    response = await remote.get('/v1/theme/files', { allow404: true });
  } catch (error) {
    if (error instanceof SiteSyncError && error.reason === 'unauthorised') {
      return { unavailable: 'the token doesn\'t have the "theme" scope' };
    }
    throw error;
  }
  // A live site on a CMS older than 0.6.0 has no theme endpoints.
  if (response === null) {
    return { unavailable: 'the live site\'s CMS is too old to sync its theme; upgrade it first' };
  }
  const listed: unknown = await response.json().catch(() => null);
  if (!Array.isArray(listed)) {
    throw new SiteSyncError('fetch-failed', 'GET /v1/theme/files did not return a list');
  }
  const theme: LiveTheme = new Map();
  for (const entry of listed as Array<Record<string, unknown>>) {
    const { path, hash } = entry;
    if (typeof path !== 'string' || !isValidThemePath(path) || typeof hash !== 'string') {
      throw new SiteSyncError('unsafe-path', `The live site listed an unexpected theme file: ${JSON.stringify(path)}`);
    }
    theme.set(path, hash);
  }
  return { theme };
}

export function readLocalTheme(config: SiteConfig): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const path of listFilesRecursively(config.themeRoot, config.themeRoot, '').filter(isValidThemePath)) {
    files.set(path, readFileSync(sanitisePath(config.themeRoot, path)));
  }
  return files;
}

export interface ThemePullResult {
  files: number;
  downloaded: number;
  // Theme-relative paths of local files the live site doesn't have.
  removed: string[];
}

// Makes theme/ a copy of the live site's theme. Only files that differ
// are downloaded; all of them before anything is written, so a failure
// part way leaves theme/ as it was.
export async function pullTheme(config: SiteConfig, remote: RemoteSite, live: LiveTheme): Promise<ThemePullResult> {
  const local = readLocalTheme(config);
  const downloads = new Map<string, Buffer>();
  for (const [path, hash] of live) {
    const here = local.get(path);
    if (here && hashThemeFile(here) === hash) {
      continue;
    }
    const bytes = await remote.getBytes(`/v1/theme/files/${encodePath(path)}`);
    if (bytes === null || hashThemeFile(bytes) !== hash) {
      throw new SiteSyncError('fetch-failed', `theme/${path} changed on the live site while it was being pulled; pull again`);
    }
    downloads.set(path, bytes);
  }

  const removed: string[] = [];
  for (const path of local.keys()) {
    if (!live.has(path)) {
      unlinkSync(sanitisePath(config.themeRoot, path));
      removed.push(path);
    }
  }
  mkdirSync(config.themeRoot, { recursive: true });
  for (const [path, bytes] of downloads) {
    const target = sanitisePath(config.themeRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  return { files: live.size, downloaded: downloads.size, removed: removed.sort() };
}

export interface ThemeChange {
  path: string;
  action: 'create' | 'update' | 'delete';
}

export interface ThemePlan {
  changes: ThemeChange[];
  conflicts: Array<{ path: string; reason: string }>;
}

// The same three-way rule as pages (see planPush): only a file changed
// here since the pull is pushed, and never over one changed on the live
// site since.
export function planThemePush(pulled: Record<string, string>, local: Map<string, Buffer>, live: LiveTheme): ThemePlan {
  const changes: ThemeChange[] = [];
  const conflicts: ThemePlan['conflicts'] = [];
  const paths = new Set([...Object.keys(pulled), ...local.keys(), ...live.keys()]);
  for (const path of [...paths].sort()) {
    const was = pulled[path];
    const here = local.has(path) ? hashThemeFile(local.get(path) as Buffer) : undefined;
    const there = live.get(path);
    if (here === was || here === there) {
      continue;
    }
    if (there !== was) {
      conflicts.push({
        path,
        reason:
          there === undefined
            ? 'deleted on the live site since your last pull'
            : was === undefined
              ? 'created on the live site since your last pull'
              : 'changed on the live site since your last pull',
      });
      continue;
    }
    changes.push({ path, action: here === undefined ? 'delete' : there === undefined ? 'create' : 'update' });
  }
  return { changes, conflicts };
}

// Sends the whole theme change as one request: the site checks every
// file against what was expected, writes, commits once and switches to
// the new theme, or changes nothing. Returns the files pushed, with the
// hashes the live site now has for them.
export async function executeThemePush(
  remote: RemoteSite,
  plan: ThemePlan,
  local: Map<string, Buffer>,
  live: LiveTheme,
  author: { name: string; email: string },
): Promise<{ warnings: string[] }> {
  const writes = plan.changes
    .filter((change) => change.action !== 'delete')
    .map((change) => ({
      path: change.path,
      content: (local.get(change.path) as Buffer).toString('base64'),
      expected: live.get(change.path) ?? null,
    }));
  const deletes = plan.changes
    .filter((change) => change.action === 'delete')
    .map((change) => ({ path: change.path, expected: live.get(change.path) as string }));
  const result = (await remote.sendJson('POST', '/v1/theme/push', {
    writes,
    deletes,
    message: `Push ${plan.changes.length} theme file${plan.changes.length === 1 ? '' : 's'} from a local copy`,
    author,
  })) as { warnings?: unknown } | null;
  const warnings = Array.isArray(result?.warnings) ? result.warnings.filter((entry): entry is string => typeof entry === 'string') : [];
  return { warnings };
}
