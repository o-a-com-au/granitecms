import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

// POSIX-only by deliberate scope decision: this agent is self-hosted on a
// server with a real git binary, not a target for Windows deployment.

export type PathSafetyReason =
  | 'absolute-path'
  | 'traversal-segment'
  | 'malformed-encoding'
  | 'outside-root'
  | 'resolves-to-root'
  | 'symlink-escape';

export class PathSafetyError extends Error {
  readonly reason: PathSafetyReason;

  constructor(reason: PathSafetyReason, message: string) {
    super(message);
    this.name = 'PathSafetyError';
    this.reason = reason;
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

// Only existing path segments can be symlinks, so for a target that
// doesn't exist yet (e.g. a new draft being written for the first time)
// it is sufficient to realpath the nearest existing ancestor and confirm
// that stays within the root; segments that don't exist can't smuggle a
// symlink escape.
function realpathOfNearestExisting(candidate: string): string {
  let current = candidate;
  for (;;) {
    try {
      return realpathSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

// The single shared path-sanitisation helper. Every fs-touching code
// path that handles a request-supplied :path parameter must resolve it
// through this function before touching disk (enforced by a grep test,
// see test/static/static-analysis.test.ts).
export function sanitisePath(root: string, requestedPath: string): string {
  const normalisedRoot = resolve(root);

  // Step 1: reject a raw absolute path before any decoding.
  if (isAbsolute(requestedPath)) {
    throw new PathSafetyError('absolute-path', `Path must be relative, got "${requestedPath}"`);
  }

  // Step 2: percent-decode. Decoding before splitting into segments (not
  // decoding each segment independently) is what's actually required to
  // catch an encoded slash disguising a segment boundary, e.g.
  // "a%2f..%2fetc" decodes to "a/../etc" and is then caught by the
  // segment scan below; decoding per-segment would miss it. Malformed
  // encoding is rejected outright rather than passed through: this will
  // also reject a benign filename containing a literal unencoded "%",
  // which is an acceptable reject-on-ambiguity trade-off, not a bug.
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    throw new PathSafetyError(
      'malformed-encoding',
      `Path contains malformed percent-encoding: "${requestedPath}"`,
    );
  }

  // Step 3: an encoded absolute path (e.g. "%2fetc%2fpasswd") doesn't
  // look absolute in raw form, so check again after decoding.
  if (isAbsolute(decoded)) {
    throw new PathSafetyError('absolute-path', `Path must be relative, got "${requestedPath}"`);
  }

  // Step 4: reject any ".." segment, covering both plain and encoded
  // traversal now that decoding has already happened.
  if (decoded.split('/').includes('..')) {
    throw new PathSafetyError(
      'traversal-segment',
      `Path must not contain ".." segments: "${requestedPath}"`,
    );
  }

  // Step 5: string-only containment check, still no fs call.
  const resolved = resolve(normalisedRoot, decoded);
  if (!isWithin(normalisedRoot, resolved)) {
    throw new PathSafetyError(
      'outside-root',
      `Path resolves outside the allowed root: "${requestedPath}"`,
    );
  }

  // Step 6: deliberate hardening beyond the literal B3-B6 wording. A
  // request that resolves to exactly the root (e.g. "", ".") must not be
  // handed to a caller expecting a single file path.
  if (resolved === normalisedRoot) {
    throw new PathSafetyError(
      'resolves-to-root',
      `Path must not resolve to the root itself: "${requestedPath}"`,
    );
  }

  // Step 7: only now touch the filesystem, to catch a symlink inside the
  // tree pointing outside the root.
  const realRoot = realpathSync(normalisedRoot);
  const realResolved = realpathOfNearestExisting(resolved);
  if (!isWithin(realRoot, realResolved)) {
    throw new PathSafetyError(
      'symlink-escape',
      `Path escapes the allowed root via a symlink: "${requestedPath}"`,
    );
  }

  return resolved;
}
