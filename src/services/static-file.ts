import { existsSync, readFileSync, statSync } from 'node:fs';
import type { FastifyReply } from 'fastify';
import { mimeTypeFor } from './mime-types.ts';
import { PathSafetyError, sanitisePath } from './path-safety.ts';

// Shared between routes/assets.ts and routes/public.ts's root-mirror
// check - the same "does a real file exist under this root, safely"
// logic, but the two callers need different behaviour on a miss
// (assets.ts always 404s; public.ts falls through to page lookup), so
// this returns a result rather than sending a response itself.
export interface StaticFileMatch {
  fullPath: string;
  contentType: string;
}

export function findStaticFile(root: string, relativePath: string): StaticFileMatch | null {
  // sanitisePath's own symlink-escape check calls realpathSync on the
  // root itself, which throws (a raw ENOENT, not a PathSafetyError) if
  // the root doesn't exist at all. theme/assets/ is always created by
  // scaffoldSite, but theme/root/ is genuinely optional (found live:
  // this crashed with a 500 on a fixture site with no theme/root/ at
  // all) - checked here rather than in sanitisePath itself, since
  // every other caller of that shared, security-audited function
  // legitimately expects its root to exist.
  if (!existsSync(root)) {
    return null;
  }
  try {
    const fullPath = sanitisePath(root, relativePath);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      return null;
    }
    return { fullPath, contentType: mimeTypeFor(fullPath) };
  } catch (error) {
    if (error instanceof PathSafetyError) {
      return null;
    }
    throw error;
  }
}

// Access-Control-Allow-Origin: * - both callers are already
// deliberately unauthenticated, public routes (see assets.ts's own
// comment for the full reasoning: a font loaded via @font-face
// enforces CORS unconditionally, and the admin's preview route makes
// genuinely cross-origin requests for paths that look same-origin).
export function sendStaticFile(reply: FastifyReply, match: StaticFileMatch): void {
  reply.header('Access-Control-Allow-Origin', '*').type(match.contentType).send(readFileSync(match.fullPath));
}
