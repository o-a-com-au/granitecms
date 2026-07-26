import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Scope, TokenEntry } from '../server-config.ts';

export type AuthReason = 'missing-token' | 'invalid-token' | 'missing-scope';

// The first domain error in this codebase's established XxxError+
// reason convention that has to cross the Fastify HTTP boundary -
// every prior one throws pre-HTTP (at boot) or predates Phase 2
// entirely. statusCode is set explicitly in the constructor so the
// existing global error handler (server.ts, which branches on
// error.statusCode) passes these through with their real message
// intact, never sanitising them as a generic 500 - confirmed
// empirically that a preHandler-thrown error with .statusCode set
// reaches that same handler correctly.
export class AuthError extends Error {
  readonly reason: AuthReason;
  readonly statusCode: number;

  constructor(reason: AuthReason, message: string) {
    super(message);
    this.name = 'AuthError';
    this.reason = reason;
    this.statusCode = reason === 'missing-scope' ? 403 : 401;
  }
}

const BEARER_PREFIX = 'Bearer ';

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

// Never compare token digests (or hex strings) with === or
// Buffer.equals() - neither is guaranteed constant-time. Only
// timingSafeEqual, which is why both sides must first be reduced to
// a fixed-length digest: it throws on mismatched buffer lengths, and
// a raw incoming token is never the same length as another token in
// general (confirmed empirically before this was written).
export function verifyToken(tokens: TokenEntry[], presentedToken: string): Scope[] | null {
  const presentedDigest = hashToken(presentedToken);
  for (const entry of tokens) {
    const storedDigest = Buffer.from(entry.hash, 'hex');
    if (timingSafeEqual(presentedDigest, storedDigest)) {
      return entry.scopes;
    }
  }
  return null;
}

// Applied as a per-route preHandler option
// (fastify.get(path, { preHandler: requireScope(tokens, 'content') }, handler)),
// not a whole-file addHook: a single route-group file may eventually
// mix scopes (e.g. a content-scoped GET and a media-scoped POST in
// the same file), so the check is granular to the route, not the
// file. Each route-group file still registers plainly, never wrapped
// in fastify-plugin's fp(), preserving the per-plugin encapsulation
// this design depends on.
export function requireScope(tokens: TokenEntry[], scope: Scope) {
  return async function scopeGuard(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new AuthError('missing-token', 'Missing or malformed Authorization header');
    }

    const presentedToken = header.slice(BEARER_PREFIX.length);
    const scopes = verifyToken(tokens, presentedToken);
    if (scopes === null) {
      throw new AuthError('invalid-token', 'The presented token does not match any configured token');
    }

    if (!scopes.includes(scope)) {
      throw new AuthError('missing-scope', `This route requires the "${scope}" scope`);
    }
  };
}
