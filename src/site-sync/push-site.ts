import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { SiteConfig } from '../config.ts';
import { CURRENT_SCHEMA_VERSION } from '../migrations/index.ts';
import { listFilesRecursively } from '../services/fs-walk.ts';
import { sanitisePath } from '../services/path-safety.ts';
import { loadRedirects, type RedirectEntry } from '../services/redirects.ts';
import { encodePath, fetchLiveContent, fetchLiveMedia, readCapabilities, type LiveContent, type LiveFile } from './live-content.ts';
import { RemoteSite, SiteSyncError } from './remote-site.ts';
import { hashOf, readSyncRecord, sameRedirects, updateSyncRecord, type ContentRecord } from './sync-record.ts';
import { executeThemePush, fetchLiveTheme, planThemePush, readLocalTheme, type LiveTheme, type ThemePlan } from './theme-sync.ts';
import { hashThemeFile } from '../services/theme-files.ts';

// --- Planning: pure, so every rule is testable without a site ---

export type PushAction = 'create' | 'update' | 'delete';

export interface PushChange {
  path: string;
  action: PushAction;
}

export interface PushConflict {
  path: string;
  reason: string;
}

export interface RedirectOperation {
  method: 'POST' | 'PUT' | 'DELETE';
  entry: RedirectEntry;
}

export interface PushPlan {
  changes: PushChange[];
  conflicts: PushConflict[];
  redirectOperations: RedirectOperation[];
  // Media names the pushed content refers to that the live site lacks.
  mediaToUpload: string[];
  // Referred to by pushed content, but missing locally too.
  mediaMissing: string[];
}

export interface LocalContent {
  files: Map<string, Buffer>;
  redirects: RedirectEntry[];
  mediaNames: Set<string>;
}

// Three versions of every page and menu: as last pulled (the record),
// here, and on the live site now. Only a local change is pushed:
//
//   local same as pulled               -> nothing to push (any live edit is kept)
//   local same as live                 -> nothing to push (already there)
//   live changed since the pull too    -> conflict: never overwritten
//   otherwise                          -> create, update or delete
//
// So a page an editor changed on the live site is never overwritten, a
// page an editor created there is never deleted, and a page is only
// deleted if it existed at the pull and was deleted here since. A page
// with an unpublished draft on the live site is a conflict too: writing
// it would replace that draft. Redirects are compared as one list the
// same way, then turned into per-redirect operations.
export function planPush(record: ContentRecord, local: LocalContent, live: LiveContent, liveMedia: Set<string>): PushPlan {
  const changes: PushChange[] = [];
  const conflicts: PushConflict[] = [];

  const paths = new Set([...Object.keys(record.files), ...local.files.keys(), ...live.live.keys()]);
  for (const path of [...paths].sort()) {
    const pulled = record.files[path];
    const here = local.files.has(path) ? hashOf(local.files.get(path) as Buffer) : undefined;
    const liveFile = live.live.get(path);
    const there = liveFile ? hashOf(liveFile.bytes) : undefined;

    if (here === pulled || here === there) {
      continue;
    }
    if (there !== pulled) {
      conflicts.push({
        path,
        reason:
          there === undefined
            ? 'deleted on the live site since your last pull'
            : pulled === undefined
              ? 'created on the live site since your last pull'
              : 'changed on the live site since your last pull',
      });
      continue;
    }
    if (live.drafts.has(path)) {
      conflicts.push({ path, reason: 'has unpublished draft changes on the live site' });
      continue;
    }
    changes.push({ path, action: here === undefined ? 'delete' : there === undefined ? 'create' : 'update' });
  }

  const redirectOperations: RedirectOperation[] = [];
  if (!sameRedirects(local.redirects, record.redirects) && !sameRedirects(local.redirects, live.redirects)) {
    if (!sameRedirects(live.redirects, record.redirects)) {
      conflicts.push({ path: 'redirects.json', reason: 'redirects changed on the live site since your last pull' });
    } else {
      const liveByFrom = new Map(live.redirects.map((entry) => [entry.from, entry]));
      const localByFrom = new Map(local.redirects.map((entry) => [entry.from, entry]));
      for (const entry of live.redirects) {
        if (!localByFrom.has(entry.from)) {
          redirectOperations.push({ method: 'DELETE', entry });
        }
      }
      for (const entry of local.redirects) {
        const existing = liveByFrom.get(entry.from);
        if (!existing) {
          redirectOperations.push({ method: 'POST', entry });
        } else if (existing.to !== entry.to || (existing.note ?? '') !== (entry.note ?? '')) {
          redirectOperations.push({ method: 'PUT', entry });
        }
      }
    }
  }

  // Only media the pushed pages actually use: local media/ can hold
  // uploads nothing refers to, which have no business on the live site.
  const referenced = new Set<string>();
  for (const change of changes) {
    if (change.action === 'delete') {
      continue;
    }
    const text = (local.files.get(change.path) as Buffer).toString('utf-8');
    for (const match of text.matchAll(/\/media\/([A-Za-z0-9_-][A-Za-z0-9._-]*)/g)) {
      referenced.add(match[1] as string);
    }
  }
  const mediaToUpload: string[] = [];
  const mediaMissing: string[] = [];
  for (const name of [...referenced].sort()) {
    if (liveMedia.has(name)) {
      continue;
    }
    (local.mediaNames.has(name) ? mediaToUpload : mediaMissing).push(name);
  }

  return { changes, conflicts, redirectOperations, mediaToUpload, mediaMissing };
}

// --- Reading this site, and the live one ---

function readLocalContent(config: SiteConfig): LocalContent {
  const files = new Map<string, Buffer>();
  for (const path of [
    ...listFilesRecursively(config.pagesRoot, config.contentRoot, '.json'),
    ...listFilesRecursively(config.menusRoot, config.contentRoot, '.json'),
  ]) {
    files.set(path, readFileSync(sanitisePath(config.contentRoot, path)));
  }
  const mediaNames = new Set(existsSync(config.mediaRoot) ? listFilesRecursively(config.mediaRoot, config.mediaRoot, '') : []);
  return { files, redirects: loadRedirects(config).entries, mediaNames };
}

// The live site's history should say who pushed, so the author is this
// copy's own git identity rather than anything invented.
function readGitAuthor(config: SiteConfig): { name: string; email: string } {
  const read = (key: string) => {
    try {
      return execFileSync('git', ['config', key], { cwd: config.siteRoot }).toString('utf-8').trim();
    } catch {
      return '';
    }
  };
  const name = read('user.name');
  const email = read('user.email');
  if (!name || !email) {
    throw new SiteSyncError(
      'no-author',
      'Push records who made the change in the live site\'s history, from git: set user.name and user.email (git config --global user.name "Your Name").',
    );
  }
  return { name, email };
}

export interface PreparedContent {
  plan: PushPlan;
  record: ContentRecord;
  local: LocalContent;
  live: LiveContent;
}

export interface PreparedTheme {
  plan: ThemePlan;
  local: Map<string, Buffer>;
  live: LiveTheme;
}

// Each part is either ready (with its plan) or unavailable, with why -
// so the CLI can offer only what can actually be pushed.
export type Prepared<T> = { ready: true; value: T } | { ready: false; reason: string };

export interface PreparedPush {
  // Everything execution needs, gathered while planning, so what is
  // confirmed is exactly what is sent.
  config: SiteConfig;
  remote: RemoteSite;
  siteUrl: string;
  author: { name: string; email: string };
  content: Prepared<PreparedContent>;
  theme: Prepared<PreparedTheme>;
}

export interface PushSiteOptions {
  siteUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (seconds: number) => void;
}

export async function preparePush(config: SiteConfig, options: PushSiteOptions): Promise<PreparedPush> {
  const record = readSyncRecord(config);
  if (!record || (!record.content && !record.theme)) {
    throw new SiteSyncError(
      'no-sync-record',
      'Push needs to know what the live site looked like when you last pulled, and this copy has never pulled. Run npm run pull first.',
    );
  }
  if (record.siteUrl !== options.siteUrl) {
    throw new SiteSyncError(
      'different-site',
      `This copy was last pulled from ${record.siteUrl}, not ${options.siteUrl}. Push only goes back to the site it came from.`,
    );
  }

  const capabilities = await readCapabilities(options.siteUrl, options.fetchImpl);
  if (capabilities.contentSchemaVersion < CURRENT_SCHEMA_VERSION) {
    throw new SiteSyncError(
      'older-live-schema',
      `The live site runs content schema ${capabilities.contentSchemaVersion} (agent ${capabilities.agentVersion}), older than this copy's ${CURRENT_SCHEMA_VERSION}, and could reject what it's sent. Upgrade the live site first.`,
    );
  }

  const author = readGitAuthor(config);
  const remote = new RemoteSite(options.siteUrl, options.token, {
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    onWait: options.onWait,
  });

  let content: Prepared<PreparedContent>;
  if (!record.content) {
    content = { ready: false, reason: 'content has never been pulled into this copy' };
  } else {
    const live = await fetchLiveContent(remote);
    const liveMedia = new Set((await fetchLiveMedia(remote)).map((item) => item.name));
    const local = readLocalContent(config);
    content = { ready: true, value: { plan: planPush(record.content, local, live, liveMedia), record: record.content, local, live } };
  }

  let theme: Prepared<PreparedTheme>;
  const fetchedTheme = await fetchLiveTheme(remote);
  if ('unavailable' in fetchedTheme) {
    theme = { ready: false, reason: fetchedTheme.unavailable };
  } else if (!record.theme) {
    theme = { ready: false, reason: 'the theme has never been pulled into this copy' };
  } else {
    const local = readLocalTheme(config);
    const live = fetchedTheme.theme;
    theme = { ready: true, value: { plan: planThemePush(record.theme.files, local, live), local, live } };
  }

  return { config, remote, siteUrl: options.siteUrl, author, content, theme };
}

// --- Executing a confirmed plan ---

// An uploaded file is named "<slug>-<hash of its bytes>.<ext>" by the
// site. Sent under its local name, the site would slug that whole name
// and add a second hash. Sent as "<slug>.<ext>", it gets back exactly
// the local name - same slug, same bytes, same hash - which is checked.
function uploadName(name: string): string {
  return name.replace(/-[0-9a-f]{12}(\.[A-Za-z0-9]+)$/, '$1');
}

export interface PushContentResult {
  created: number;
  updated: number;
  deleted: number;
  redirects: number;
  mediaUploaded: number;
}

export interface PushSiteResult {
  content?: PushContentResult;
  theme?: { files: number; warnings: string[] };
}

export interface PushParts {
  content: boolean;
  theme: boolean;
}

// The theme goes first: a page using a new section type can only be
// accepted once the theme that defines it is live. Nothing at all is
// sent while any chosen part has a conflict or missing media.
export async function executePush(prepared: PreparedPush, parts: PushParts): Promise<PushSiteResult> {
  const content = parts.content && prepared.content.ready ? prepared.content.value : null;
  const theme = parts.theme && prepared.theme.ready ? prepared.theme.value : null;
  if ((content && (content.plan.conflicts.length > 0 || content.plan.mediaMissing.length > 0)) || (theme && theme.plan.conflicts.length > 0)) {
    throw new SiteSyncError('conflicts', 'This push has conflicts or missing media and cannot go ahead.');
  }

  const result: PushSiteResult = {};
  if (theme && theme.plan.changes.length > 0) {
    const { warnings } = await executeThemePush(prepared.remote, theme.plan, theme.local, theme.live, prepared.author);
    // The site stores theme files exactly as sent, so a pushed file's
    // hash is its local one. Only pushed files move on; anything else
    // keeps its pulled state, so a live-only edit is still recognised as
    // one next time.
    const merged = { ...(readSyncRecord(prepared.config)?.theme?.files ?? {}) };
    for (const change of theme.plan.changes) {
      if (change.action === 'delete') {
        delete merged[change.path];
      } else {
        merged[change.path] = hashThemeFile(theme.local.get(change.path) as Buffer);
      }
    }
    updateSyncRecord(prepared.config, prepared.siteUrl, { theme: { syncedAt: new Date().toISOString(), files: merged } });
    result.theme = { files: theme.plan.changes.length, warnings };
  }
  if (content) {
    result.content = await executeContentPush(prepared, content);
  }
  return result;
}

// Order: media first (additive, and pages need it to exist), then every
// page and menu change as ONE batch - draft writes, deletes and a
// publish, which the site applies as a single commit or rolls back
// entirely - then redirects, one commit each. Each draft write carries
// the ETag fetched while planning, so a page an editor saves in the
// meantime fails the whole batch rather than being overwritten.
async function executeContentPush(prepared: PreparedPush, prepContent: PreparedContent): Promise<PushContentResult> {
  const { config, remote, author } = prepared;
  const { plan, record, local, live } = prepContent;
  for (const name of plan.mediaToUpload) {
    const bytes = readFileSync(sanitisePath(config.mediaRoot, name));
    const result = (await remote.upload('/v1/media', uploadName(name), bytes)) as { name?: unknown } | null;
    if (result?.name !== name) {
      throw new SiteSyncError(
        'rejected',
        `The live site stored ${name} as ${String(result?.name)}, so pages referring to it would break. Nothing else was pushed.`,
      );
    }
  }

  const written = plan.changes.filter((change) => change.action !== 'delete');
  if (plan.changes.length > 0) {
    const operations = plan.changes.map((change) =>
      change.action === 'delete'
        ? { type: 'content-delete', path: change.path }
        : {
            type: 'draft-write',
            path: change.path,
            content: JSON.parse((local.files.get(change.path) as Buffer).toString('utf-8')) as unknown,
            expectedEtag: (live.live.get(change.path) as LiveFile | undefined)?.etag ?? 'new',
          },
    );
    await remote.sendJson('POST', '/v1/batch', {
      operations,
      ...(written.length > 0 ? { publish: { paths: written.map((change) => change.path) } } : {}),
      message: `Push ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'} from a local copy`,
      author,
    });
  }

  for (const operation of plan.redirectOperations) {
    const { from, to, note } = operation.entry;
    const verb = operation.method === 'DELETE' ? 'Remove' : operation.method === 'POST' ? 'Add' : 'Update';
    await remote.sendJson(operation.method, '/v1/redirects', {
      from,
      ...(operation.method === 'DELETE' ? {} : { to, ...(note === undefined ? {} : { note }) }),
      message: `${verb} redirect ${from} (pushed from a local copy)`,
      author,
    });
  }

  // The record now reflects the live site for everything pushed: the
  // bytes the site actually stored (it re-serialises a draft write),
  // not what was sent. Anything not pushed keeps its pulled state, so a
  // live-only edit is still recognised as one next time.
  const files = { ...record.files };
  for (const change of plan.changes) {
    if (change.action === 'delete') {
      delete files[change.path];
      continue;
    }
    const stored = await remote.getBytes(`/v1/content/${encodePath(change.path)}`, { allow404: true });
    if (stored !== null) {
      files[change.path] = hashOf(stored);
    }
  }
  updateSyncRecord(config, prepared.siteUrl, {
    content: {
      syncedAt: new Date().toISOString(),
      files,
      redirects: plan.redirectOperations.length > 0 ? local.redirects : record.redirects,
    },
  });

  return {
    created: plan.changes.filter((change) => change.action === 'create').length,
    updated: plan.changes.filter((change) => change.action === 'update').length,
    deleted: plan.changes.filter((change) => change.action === 'delete').length,
    redirects: plan.redirectOperations.length,
    mediaUploaded: plan.mediaToUpload.length,
  };
}
