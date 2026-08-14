import type { SiteConfig } from '../config.ts';
import { enqueue } from '../services/write-queue.ts';
import { openLocalFsMediaDriver } from './drivers/local-fs-driver.ts';
import { buildMediaFilename } from './filename.ts';

// Deliberately much simpler than manage-redirects.ts/manage-menus.ts -
// no commit, no author, no snapshot/undo. Media is never git-tracked
// (docs/cms-build-plan.md constraint 2), so there's no commit step to
// roll back from in the first place.
export type ManageMediaReason = 'not-found' | 'invalid-file-type';

export class ManageMediaError extends Error {
  readonly reason: ManageMediaReason;

  constructor(reason: ManageMediaReason, message: string) {
    super(message);
    this.name = 'ManageMediaError';
    this.reason = reason;
  }
}

export interface MediaEntry {
  name: string;
  size: number;
  mtimeMs: number;
  url: string;
}

function mediaUrl(name: string): string {
  return `/media/${name}`;
}

// Opens a fresh driver per call rather than threading one long-lived
// instance through BootedSite - unlike DatabaseSync, plain fs calls
// have no connection/handle to reuse, so there's no driver-lifecycle
// wiring needed. The only call site that decides which driver to open
// is here, hardcoded, matching how rebuild-index.ts hardcodes
// openNodeSqliteDriver today with no config-driven selection either -
// this is where a future config-driven driver choice would go.
function driverFor(config: SiteConfig) {
  return openLocalFsMediaDriver(config.mediaRoot);
}

// Not enqueued - reads bypass the write queue, matching
// handleListRedirects' own precedent of only serialising mutations.
export async function listMedia(config: SiteConfig): Promise<MediaEntry[]> {
  const entries = await driverFor(config).list();
  return entries.map((entry) => ({ ...entry, url: mediaUrl(entry.name) }));
}

export function putMedia(
  config: SiteConfig,
  originalFilename: string,
  bytes: Buffer,
): Promise<{ name: string; size: number; url: string }> {
  return enqueue(async () => {
    const name = buildMediaFilename(originalFilename, bytes);
    await driverFor(config).put(name, bytes);
    return { name, size: bytes.length, url: mediaUrl(name) };
  });
}

export function deleteMedia(config: SiteConfig, filename: string): Promise<void> {
  return enqueue(async () => {
    const existed = await driverFor(config).delete(filename);
    if (!existed) {
      throw new ManageMediaError('not-found', `No media file at "${filename}"`);
    }
  });
}
