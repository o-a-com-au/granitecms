import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

// Content-addressed: the filename is derived from a hash of the
// file's own bytes, so two uploads can never collide, and an
// identical re-upload naturally produces the identical filename (a
// harmless overwrite in local-fs-driver.ts's put(), not a duplicate).
// No separate manifest/index recording original filenames - this
// codebase avoids a second source of truth on principle (the same
// reasoning that keeps the SQLite search index disposable rather than
// authoritative), so the original name is folded into the filename
// itself instead of tracked anywhere else.
//
// Slug regex matches generate-site.ts's own sanitisePackageName -
// lowercase, non [a-z0-9-] runs collapsed to a single "-", trimmed -
// not a second, independently-invented convention.
export function buildMediaFilename(originalFilename: string, bytes: Buffer): string {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const base = basename(originalFilename, extname(originalFilename));
  const cleaned = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const slug = cleaned.length > 0 ? cleaned : 'file';
  const extension = extname(originalFilename).toLowerCase();
  return `${hash}-${slug}${extension}`;
}
