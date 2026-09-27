import type { RedirectEntry } from '../services/redirects.ts';
import { RemoteSite, SiteSyncError } from './remote-site.ts';

// Every path from the server is untrusted input that becomes a local
// file path (pull) or is compared against one (push). Checked here for
// shape - a pages/ or menus/ JSON file, no dot segments; a flat media
// name - and again by sanitisePath before any local write.
export const CONTENT_PATH = /^(pages|menus)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/;
export const MEDIA_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export interface SiteCapabilities {
  agentVersion: string;
  contentSchemaVersion: number;
}

// GET /v1/capabilities is public, so an address can be checked before a
// token is asked for.
export async function readCapabilities(siteUrl: string, fetchImpl?: typeof fetch): Promise<SiteCapabilities> {
  const body = (await new RemoteSite(siteUrl, '', { fetchImpl }).getJson('/v1/capabilities', { auth: false })) as Record<
    string,
    unknown
  >;
  if (typeof body.agentVersion !== 'string' || typeof body.contentSchemaVersion !== 'number') {
    throw new SiteSyncError('not-a-site', `${siteUrl} is not a Granite site`);
  }
  return { agentVersion: body.agentVersion, contentSchemaVersion: body.contentSchemaVersion };
}

export interface LiveFile {
  bytes: Buffer;
  etag: string;
}

export interface LiveContent {
  // Content-relative paths ("pages/about.json", "menus/main.json").
  live: Map<string, LiveFile>;
  drafts: Map<string, Buffer>;
  redirects: RedirectEntry[];
}

export async function fetchLiveContent(remote: RemoteSite): Promise<LiveContent> {
  const listed = await remote.getJson('/v1/content');
  if (!Array.isArray(listed)) {
    throw new SiteSyncError('fetch-failed', 'GET /v1/content did not return a list');
  }

  const live = new Map<string, LiveFile>();
  const drafts = new Map<string, Buffer>();
  for (const entry of listed as Array<Record<string, unknown>>) {
    const path = entry.path;
    if (typeof path !== 'string' || !CONTENT_PATH.test(path)) {
      throw new SiteSyncError('unsafe-path', `The live site listed an unexpected content path: ${JSON.stringify(path)}`);
    }
    const file = await remote.getFile(`/v1/content/${encodePath(path)}`);
    if (file !== null) {
      live.set(path, file);
    }
    if (entry.hasDraft === true) {
      const draft = await remote.getBytes(`/v1/drafts/${encodePath(path)}`, { allow404: true });
      if (draft !== null) {
        drafts.set(path, draft);
      }
    }
  }

  const redirectsBody = (await remote.getJson('/v1/redirects')) as { entries?: unknown };
  const redirects = Array.isArray(redirectsBody.entries) ? (redirectsBody.entries as RedirectEntry[]) : [];

  return { live, drafts, redirects };
}

export interface LiveMediaItem {
  name: string;
  size: number;
}

export async function fetchLiveMedia(remote: RemoteSite): Promise<LiveMediaItem[]> {
  const listed = await remote.getJson('/v1/media');
  if (!Array.isArray(listed)) {
    throw new SiteSyncError('fetch-failed', 'GET /v1/media did not return a list');
  }
  return (listed as Array<Record<string, unknown>>).map((item) => {
    const { name, size } = item;
    if (typeof name !== 'string' || !MEDIA_NAME.test(name)) {
      throw new SiteSyncError('unsafe-path', `The live site listed an unexpected media name: ${JSON.stringify(name)}`);
    }
    return { name, size: typeof size === 'number' ? size : -1 };
  });
}
