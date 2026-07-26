import { createHash } from 'node:crypto';

// A plain content hash, not a git blob hash: git.ts only shells out to
// git for actual commits, never for a per-request read, and nothing
// downstream needs the ETag to coincide with a real git blob hash
// (the git log/show endpoints address content by ref+path, not by
// hash lookup). A quoted strong ETag, matching HTTP's own syntax -
// this is a byte-for-byte digest, so strong semantics are correct.
//
// The one hash function every ETag-producing read (D1/D2) and every
// future If-Match comparison (Group E) must share - never inlined
// separately, or the two could silently drift.
export function computeEtag(bytes: Buffer): string {
  return `"${createHash('sha256').update(bytes).digest('hex')}"`;
}
