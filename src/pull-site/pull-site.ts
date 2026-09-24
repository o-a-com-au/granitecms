import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { CURRENT_SCHEMA_VERSION } from '../migrations/index.ts';
import { listFilesRecursively } from '../services/fs-walk.ts';
import { sanitisePath } from '../services/path-safety.ts';
import { serialiseRedirects, type RedirectEntry } from '../services/redirects.ts';
import { rebuildIndex } from '../search/rebuild-index.ts';

export type PullSiteReason =
  | 'not-a-site'
  | 'unauthorised'
  | 'newer-schema'
  | 'uncommitted-changes'
  | 'fetch-failed'
  | 'unsafe-path';

export class PullSiteError extends Error {
  readonly reason: PullSiteReason;

  constructor(reason: PullSiteReason, message: string) {
    super(message);
    this.name = 'PullSiteError';
    this.reason = reason;
  }
}

export interface PullSiteOptions {
  siteUrl: string;
  token: string;
  // Pull even though content/ has uncommitted local changes, which the
  // pull would overwrite or delete.
  force?: boolean;
  fetchImpl?: typeof fetch;
}

export interface PullSiteResult {
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

// What the server sent back for one content-relative path. Bytes, not
// parsed JSON: they're written exactly as the live site has them, so a
// git diff afterwards shows only real changes.
interface RemoteFile {
  path: string;
  bytes: Buffer;
}

// Every path from the server is untrusted input that becomes a local
// file path. Checked here for shape (a pages/ or menus/ JSON file, no
// dot segments), then again by sanitisePath before any write.
const CONTENT_PATH = /^(pages|menus)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/;
const MEDIA_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

class RemoteSite {
  private readonly siteUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(siteUrl: string, token: string, fetchImpl: typeof fetch | undefined) {
    this.siteUrl = siteUrl;
    this.token = token;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private url(path: string): URL {
    return new URL(path, this.siteUrl);
  }

  async get(path: string, { auth = true, allow404 = false } = {}): Promise<Response | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        headers: auth ? { authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PullSiteError('fetch-failed', `Could not reach ${this.url(path).toString()}: ${detail}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new PullSiteError(
        'unauthorised',
        `The live site rejected the token (${response.status}). It needs the "content" and "media" scopes.`,
      );
    }
    if (allow404 && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new PullSiteError('fetch-failed', `GET ${path} returned ${response.status}`);
    }
    return response;
  }

  async getJson(path: string, options: { auth?: boolean } = {}): Promise<unknown> {
    const response = await this.get(path, options);
    try {
      return await (response as Response).json();
    } catch {
      throw new PullSiteError('fetch-failed', `GET ${path} did not return JSON`);
    }
  }

  async getBytes(path: string, options: { auth?: boolean; allow404?: boolean } = {}): Promise<Buffer | null> {
    const response = await this.get(path, options);
    return response === null ? null : Buffer.from(await response.arrayBuffer());
  }
}

function hasUncommittedContentChanges(config: SiteConfig): boolean {
  try {
    const status = execFileSync('git', ['status', '--porcelain', '--', 'content'], { cwd: config.siteRoot });
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

// Makes this local site's content a copy of a running site's: pages,
// menus, drafts and redirects are mirrored (local files the live site
// doesn't have are removed), and any media file missing locally is
// downloaded. The theme is never touched - the API doesn't serve it,
// and it's the developer's code rather than the site's content. Nothing
// is committed: the result is left in the working tree to review.
//
// Everything is fetched before anything is written, so a failure part
// way through the content leaves the local site exactly as it was.
// Media is downloaded last and only ever adds files, so a failure there
// leaves the content pulled and some images still to fetch on a re-run.
export async function pullSite(config: SiteConfig, options: PullSiteOptions): Promise<PullSiteResult> {
  const remote = new RemoteSite(options.siteUrl, options.token, options.fetchImpl);

  const capabilities = (await remote.getJson('/v1/capabilities', { auth: false })) as Record<string, unknown>;
  if (typeof capabilities.agentVersion !== 'string' || typeof capabilities.contentSchemaVersion !== 'number') {
    throw new PullSiteError('not-a-site', `${options.siteUrl} is not a Granite site`);
  }
  if (capabilities.contentSchemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new PullSiteError(
      'newer-schema',
      `The live site uses content schema ${capabilities.contentSchemaVersion} (agent ${capabilities.agentVersion}), newer than this site's ${CURRENT_SCHEMA_VERSION}. Upgrade @o-a/cms-agent here first.`,
    );
  }

  if (!options.force && hasUncommittedContentChanges(config)) {
    throw new PullSiteError(
      'uncommitted-changes',
      'content/ has uncommitted changes, which pulling would overwrite. Commit them first, or pass --force.',
    );
  }

  // --- Fetch everything ---
  const listed = await remote.getJson('/v1/content');
  if (!Array.isArray(listed)) {
    throw new PullSiteError('fetch-failed', 'GET /v1/content did not return a list');
  }

  const live: RemoteFile[] = [];
  const drafts: RemoteFile[] = [];
  for (const entry of listed as Array<Record<string, unknown>>) {
    const path = entry.path;
    if (typeof path !== 'string' || !CONTENT_PATH.test(path)) {
      throw new PullSiteError('unsafe-path', `The live site listed an unexpected content path: ${JSON.stringify(path)}`);
    }
    const liveBytes = await remote.getBytes(`/v1/content/${encodePath(path)}`, { allow404: true });
    if (liveBytes !== null) {
      live.push({ path, bytes: liveBytes });
    }
    if (entry.hasDraft === true) {
      const draftBytes = await remote.getBytes(`/v1/drafts/${encodePath(path)}`, { allow404: true });
      if (draftBytes !== null) {
        drafts.push({ path, bytes: draftBytes });
      }
    }
  }

  const redirectsBody = (await remote.getJson('/v1/redirects')) as { entries?: unknown };
  const redirectEntries = Array.isArray(redirectsBody.entries) ? (redirectsBody.entries as RedirectEntry[]) : [];

  // --- Write content (mirror) ---
  const remoteLive = new Set(live.map((file) => file.path));
  const remoteDrafts = new Set(drafts.map((file) => file.path));
  const removed: string[] = [];

  for (const local of [
    ...listFilesRecursively(config.pagesRoot, config.contentRoot, '.json'),
    ...listFilesRecursively(config.menusRoot, config.contentRoot, '.json'),
  ]) {
    if (!remoteLive.has(local)) {
      unlinkSync(sanitisePath(config.contentRoot, local));
      removed.push(local);
    }
  }
  for (const local of listFilesRecursively(config.draftsRoot, config.draftsRoot, '.json')) {
    if (!remoteDrafts.has(local)) {
      unlinkSync(sanitisePath(config.draftsRoot, local));
      removed.push(`drafts/${local}`);
    }
  }

  for (const file of live) {
    writeUnder(config.contentRoot, file.path, file.bytes);
  }
  for (const file of drafts) {
    writeUnder(config.draftsRoot, file.path, file.bytes);
  }
  if (redirectEntries.length > 0 || existsSync(config.redirectsPath)) {
    writeFileSync(config.redirectsPath, serialiseRedirects(redirectEntries));
  }

  // --- Media: download what's missing ---
  // Names are content-addressed (a hash of the bytes), so a file that
  // already exists locally under the same name and size is the same
  // file. Local extras are kept: unreferenced media is harmless, and a
  // local upload not yet on the live site shouldn't vanish.
  const mediaList = await remote.getJson('/v1/media');
  if (!Array.isArray(mediaList)) {
    throw new PullSiteError('fetch-failed', 'GET /v1/media did not return a list');
  }
  let mediaDownloaded = 0;
  let mediaAlreadyPresent = 0;
  mkdirSync(config.mediaRoot, { recursive: true });
  for (const item of mediaList as Array<Record<string, unknown>>) {
    const { name, size } = item;
    if (typeof name !== 'string' || !MEDIA_NAME.test(name)) {
      throw new PullSiteError('unsafe-path', `The live site listed an unexpected media name: ${JSON.stringify(name)}`);
    }
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

  return {
    pages: live.filter((file) => file.path.startsWith('pages/')).length,
    menus: live.filter((file) => file.path.startsWith('menus/')).length,
    drafts: drafts.length,
    redirects: redirectEntries.length,
    removed: removed.sort(),
    mediaDownloaded,
    mediaAlreadyPresent,
  };
}
