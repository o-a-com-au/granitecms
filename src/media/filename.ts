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
// Truncated to 12 hex chars (48 bits), not the full 64-char digest -
// git itself only shows short hashes for the same reason. At this
// length a collision between two different files stays astronomically
// unlikely (well past a 1-in-a-trillion chance even at tens of
// thousands of uploads to one site), while keeping filenames/URLs/git
// history actually readable.
//
// Slug regex matches generate-site.ts's own sanitisePackageName -
// lowercase, non [a-z0-9-] runs collapsed to a single "-", trimmed -
// not a second, independently-invented convention.
const HASH_LENGTH = 12;

export function buildMediaFilename(originalFilename: string, bytes: Buffer): string {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, HASH_LENGTH);
  const base = basename(originalFilename, extname(originalFilename));
  const cleaned = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const slug = cleaned.length > 0 ? cleaned : 'file';
  const extension = extname(originalFilename).toLowerCase();
  return `${hash}-${slug}${extension}`;
}
