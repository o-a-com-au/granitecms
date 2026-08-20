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

// RFC 7232 weak comparison: a compressing proxy sitting in front of a
// real deployment (confirmed live against a Railway-hosted admin - its
// edge downgrades this server's own strong ETag to weak in transit,
// since the compressed bytes on the wire differ from what computeEtag
// hashed) is standard, spec-compliant proxy behaviour, not a bug on
// the proxy's part. A client that captured and echoes back that
// now-weak value represents the exact same content a strict `===`
// would wrongly reject as changed - every If-Match check must compare
// this way, never with a bare `!==`, or any real host behind a
// compressing proxy/CDN produces spurious conflicts on every save.
function stripWeakPrefix(etag: string): string {
  return etag.startsWith('W/') ? etag.slice(2) : etag;
}

export function etagsMatch(a: string, b: string): boolean {
  return stripWeakPrefix(a) === stripWeakPrefix(b);
}
