import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { CURRENT_SCHEMA_VERSION } from '../migrations/index.ts';
import { listFilesRecursively } from '../services/fs-walk.ts';
import { sanitisePath } from '../services/path-safety.ts';
import { loadRedirects, serialiseRedirects } from '../services/redirects.ts';
import { rebuildIndex } from '../search/rebuild-index.ts';
import { fetchLiveContent, fetchLiveMedia, readCapabilities } from './live-content.ts';
import { RemoteSite, SiteSyncError } from './remote-site.ts';
import { hashOf, sameRedirects, updateSyncRecord } from './sync-record.ts';
import { fetchLiveTheme, pullTheme, type ThemePullResult } from './theme-sync.ts';

export interface SyncParts {
  content: boolean;
  theme: boolean;
}

export interface PullSiteOptions {
  siteUrl: string;
  token: string;
  parts: SyncParts;
  // Pull even though content/ or theme/ has uncommitted local changes,
  // which the pull would overwrite or delete.
  force?: boolean;
  fetchImpl?: typeof fetch;
}

export interface PullContentResult {
  pages: number;
  menus: number;
  drafts: number;
  redirects: number;
  // Local files the live site doesn't have, content-relative
  // (e.g. "pages/old.json", "drafts/pages/x.json").
  removed: string[];
  mediaDownloaded: number;
  mediaAlreadyPresent: number;
}

export interface PullSiteResult {
  content?: PullContentResult;
  theme?: ThemePullResult;
}

function hasUncommittedChanges(config: SiteConfig, folder: 'content' | 'theme'): boolean {
  try {
    const status = execFileSync('git', ['status', '--porcelain', '--', folder], { cwd: config.siteRoot });
    return status.toString('utf-8').trim() !== '';
  } catch {
    // Not a git repository (or no git): nothing to protect via git, and
    // no way to recover what a pull overwrites - treat as changed.
    return true;
  }
}

function writeUnder(root: string, relativePath: string, bytes: Buffer): void {
  mkdirSync(root, { recursive: true });
  const target = sanitisePath(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

// Whether an address is a site this agent can pull from, checked
// without a token - so the CLI can say the address is wrong before
// asking for a token at all.
export async function checkPullableSite(siteUrl: string, fetchImpl?: typeof fetch): Promise<void> {
  const capabilities = await readCapabilities(siteUrl, fetchImpl);
  if (capabilities.contentSchemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new SiteSyncError(
      'newer-schema',
      `The live site uses content schema ${capabilities.contentSchemaVersion} (agent ${capabilities.agentVersion}), newer than this site's ${CURRENT_SCHEMA_VERSION}. Upgrade @o-a/cms-agent here first.`,
    );
  }
}

// Makes this local site a copy of a running site's, for the parts
// chosen. Content: pages, menus, drafts and redirects are mirrored
// (local files the live site doesn't have are removed), and any media
// file missing locally is downloaded. Theme: theme/ is mirrored the same
// way (theme-sync.ts), which needs a token with the "theme" scope.
// Nothing is committed: the result is left in the working tree to
// review.
//
// Everything is fetched before anything is written, so a failure part
// way through the content leaves the local site exactly as it was.
// Media is downloaded last and only ever adds files, so a failure there
// leaves the content pulled and some images still to fetch on a re-run.
//
// Records what was pulled (sync-record.ts), which is what lets a later
// push tell local changes apart from ones made on the live site since.
export async function pullSite(config: SiteConfig, options: PullSiteOptions): Promise<PullSiteResult> {
  const remote = new RemoteSite(options.siteUrl, options.token, { fetchImpl: options.fetchImpl });
  await checkPullableSite(options.siteUrl, options.fetchImpl);

  const folders = (['content', 'theme'] as const).filter((part) => options.parts[part]);
  const dirty = options.force ? [] : folders.filter((folder) => hasUncommittedChanges(config, folder));
  if (dirty.length > 0) {
    throw new SiteSyncError(
      'uncommitted-changes',
      `${dirty.map((folder) => `${folder}/`).join(' and ')} ${dirty.length === 1 ? 'has' : 'have'} uncommitted changes, which pulling would overwrite. Commit them first, or pass --force.`,
    );
  }

  const result: PullSiteResult = {};
  // Theme first: fetched and checked before any content is touched, so
  // a token without the "theme" scope fails before anything changes.
  if (options.parts.theme) {
    const fetched = await fetchLiveTheme(remote);
    if ('unavailable' in fetched) {
      throw new SiteSyncError('unauthorised', `Can't pull the theme: ${fetched.unavailable}.`);
    }
    const live = fetched.theme;
    result.theme = await pullTheme(config, remote, live);
    updateSyncRecord(config, options.siteUrl, { theme: { syncedAt: new Date().toISOString(), files: Object.fromEntries(live) } });
  }
  if (options.parts.content) {
    result.content = await pullContent(config, remote, options.siteUrl);
  }
  return result;
}

async function pullContent(config: SiteConfig, remote: RemoteSite, siteUrl: string): Promise<PullContentResult> {
  // --- Fetch everything ---
  const { live, drafts, redirects } = await fetchLiveContent(remote);

  // --- Write content (mirror) ---
  const removed: string[] = [];
  for (const local of [
    ...listFilesRecursively(config.pagesRoot, config.contentRoot, '.json'),
    ...listFilesRecursively(config.menusRoot, config.contentRoot, '.json'),
  ]) {
    if (!live.has(local)) {
      unlinkSync(sanitisePath(config.contentRoot, local));
      removed.push(local);
    }
  }
  for (const local of listFilesRecursively(config.draftsRoot, config.draftsRoot, '.json')) {
    if (!drafts.has(local)) {
      unlinkSync(sanitisePath(config.draftsRoot, local));
      removed.push(`drafts/${local}`);
    }
  }

  for (const [path, file] of live) {
    writeUnder(config.contentRoot, path, file.bytes);
  }
  for (const [path, bytes] of drafts) {
    writeUnder(config.draftsRoot, path, bytes);
  }
  // Only when they differ: rewriting identical redirects would still
  // show as a change (the file's formatting), seen on a real pull.
  const localRedirects = existsSync(config.redirectsPath) ? loadRedirects(config).entries : [];
  if (!sameRedirects(localRedirects, redirects)) {
    writeFileSync(config.redirectsPath, serialiseRedirects(redirects));
  }

  updateSyncRecord(config, siteUrl, {
    content: {
      syncedAt: new Date().toISOString(),
      files: Object.fromEntries([...live].map(([path, file]) => [path, hashOf(file.bytes)])),
      redirects,
    },
  });

  // --- Media: download what's missing ---
  // Names are content-addressed (a hash of the bytes), so a file that
  // already exists locally under the same name and size is the same
  // file. Local extras are kept: unreferenced media is harmless, and a
  // local upload not yet on the live site shouldn't vanish.
  let mediaDownloaded = 0;
  let mediaAlreadyPresent = 0;
  mkdirSync(config.mediaRoot, { recursive: true });
  for (const { name, size } of await fetchLiveMedia(remote)) {
    const target = sanitisePath(config.mediaRoot, name);
    if (existsSync(target) && statSync(target).size === size) {
      mediaAlreadyPresent += 1;
      continue;
    }
    const bytes = await remote.getBytes(`/media/${encodeURIComponent(name)}`, { auth: false });
    writeFileSync(target, bytes as Buffer);
    mediaDownloaded += 1;
  }

  // The local search index describes the content that was just
  // replaced; rebuild it from what's on disk now.
  await rebuildIndex(config);

  const paths = [...live.keys()];
  return {
    pages: paths.filter((path) => path.startsWith('pages/')).length,
    menus: paths.filter((path) => path.startsWith('menus/')).length,
    drafts: drafts.size,
    redirects: redirects.length,
    removed: removed.sort(),
    mediaDownloaded,
    mediaAlreadyPresent,
  };
}
