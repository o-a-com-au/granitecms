import type { FastifyRequest } from 'fastify';

// Mirrors token-auth.ts's AuthError shape: statusCode set explicitly
// in the constructor so the existing global error handler passes this
// through with its real message intact, never sanitising it as a
// generic 500.
export class IpAllowlistError extends Error {
  readonly statusCode = 403;

  constructor() {
    super('This IP address is not permitted to access this API');
    this.name = 'IpAllowlistError';
  }
}

// An empty allowlist is a no-op (checklist H3), not "nothing is
// allowed" - exact-IP-only for this pass, no CIDR ranges: IP
// allowlisting is "optional, not the backbone" per the build plan, a
// deliberate scope reduction rather than an oversight.
export function isIpAllowed(allowlist: string[], ip: string): boolean {
  return allowlist.length === 0 || allowlist.includes(ip);
}

// Applied as a whole-file addHook('onRequest', ...) inside v1Routes's
// own plugin body (routes/index.ts), not a per-route preHandler like
// requireScope - an IP allowlist is a coarse "is this client's network
// address allowed to talk to the API at all" gate, orthogonal to
// token-scope exemption, so it applies to the entire /v1 surface
// uniformly, including capabilities.ts and every GET route.
export function ipAllowlistGuard(allowlist: string[]) {
  return async function guard(request: FastifyRequest): Promise<void> {
    if (!isIpAllowed(allowlist, request.ip)) {
      throw new IpAllowlistError();
    }
  };
}
