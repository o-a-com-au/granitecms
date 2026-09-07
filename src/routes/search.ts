import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { rebuildIndex } from '../search/rebuild-index.ts';
import { WRITE_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';
import { requireScope } from '../services/token-auth.ts';
import type { TokenEntry } from '../server-config.ts';

export interface SearchRouteOptions {
  config: SiteConfig;
  tokens: TokenEntry[];
}

// The read side (GET /search.json) lives in routes/search-public.ts,
// registered separately, unprefixed, in server.ts - this file only
// ever holds the authenticated write side, matching media.ts (write,
// under /v1) vs media-public.ts (public read, unprefixed).
export const searchRoutes: FastifyPluginAsync<SearchRouteOptions> = async (
  fastify: FastifyInstance,
  opts: SearchRouteOptions,
) => {
  fastify.post(
    '/search/rebuild',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (_request, reply) => {
      // rebuildIndex is already self-enqueue()d (search/rebuild-index.ts) -
      // never wrap it in a second enqueue() here, nested calls deadlock.
      await rebuildIndex(opts.config);
      reply.send({ ok: true });
    },
  );
};
