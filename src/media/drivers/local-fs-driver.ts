import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PathSafetyError, sanitisePath } from '../../services/path-safety.ts';
import type { MediaListEntry, MediaStorageDriver } from './driver.ts';

// A plain string constant, matching node-sqlite-driver.ts's own
// DRIVER_NAME convention - safe for the capabilities endpoint to
// report without needing to import anything fs-touching.
export const DRIVER_NAME = 'local-fs';

// The default (and, for this build increment, only) MediaStorageDriver
// implementation. No driver-containment static-analysis test exists
// for this yet, unlike search/drivers' own G5 check for node:sqlite -
// node:fs is a single already-pervasive Node builtin, not a swappable
// third-party library the way node:sqlite/better-sqlite3 are, so
// there's no "which alternative" question to fence off yet. The
// natural trigger for that kind of test is a future object-storage
// driver's own third-party SDK import.
//
// Every method resolves filename through sanitisePath itself before
// touching disk - this file importing both node:fs and sanitisePath
// is what satisfies the B7 static-analysis rule with no allowlist
// entry needed, matching assets.ts/content.ts's own pattern of the
// fs-touching file being the one that calls it.
export function openLocalFsMediaDriver(root: string): MediaStorageDriver {
  return {
    async list(): Promise<MediaListEntry[]> {
      mkdirSync(root, { recursive: true });
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const stats = statSync(sanitisePath(root, entry.name));
          return { name: entry.name, size: stats.size, mtimeMs: stats.mtimeMs };
        });
    },

    async put(filename: string, bytes: Buffer): Promise<void> {
      const resolved = sanitisePath(root, filename);
      // Harmless no-op for a flat, content-addressed namespace (media
      // filenames never contain subdirectories) - matches
      // manage-menus.ts's own defensive precedent of creating the
      // parent directory before a write rather than assuming it
      // already exists.
      mkdirSync(dirname(resolved), { recursive: true });
      // No existence check first: content-addressed naming means an
      // identical re-upload writes identical bytes over identical
      // bytes - a harmless idempotent overwrite, not something that
      // needs special-casing.
      writeFileSync(resolved, bytes);
    },

    async get(filename: string): Promise<Buffer | null> {
      let resolved: string;
      try {
        resolved = sanitisePath(root, filename);
      } catch (error) {
        // An invalid/traversal-shaped filename reads as "not found"
        // from this method's own contract - the route layer is what
        // decides whether that's a 404 or something else, the driver
        // itself stays mechanical.
        if (error instanceof PathSafetyError) {
          return null;
        }
        throw error;
      }
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        return null;
      }
      return readFileSync(resolved);
    },

    async delete(filename: string): Promise<boolean> {
      // Unlike get(), a malformed delete path is let through
      // uncaught - worth surfacing distinctly rather than silently
      // reading as "already didn't exist", matching
      // manage-redirects.ts's own not-found-is-a-distinct-reason
      // precedent.
      const resolved = sanitisePath(root, filename);
      if (!existsSync(resolved)) {
        return false;
      }
      unlinkSync(resolved);
      return true;
    },
  };
}
