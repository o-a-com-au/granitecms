import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { rebuildIndex } from '../search/rebuild-index.ts';
import { requireScope } from '../services/token-auth.ts';
import type { TokenEntry } from '../server-config.ts';

export interface SearchRouteOptions {
  config: SiteConfig;
  tokens: TokenEntry[];
}

export const searchRoutes: FastifyPluginAsync<SearchRouteOptions> = async (
  fastify: FastifyInstance,
  opts: SearchRouteOptions,
) => {
  fastify.post(
    '/search/rebuild',
    { preHandler: requireScope(opts.tokens, 'content') },
    async (_request, reply) => {
      // rebuildIndex is already self-enqueue()d (search/rebuild-index.ts) -
      // never wrap it in a second enqueue() here, nested calls deadlock.
      await rebuildIndex(opts.config);
      reply.send({ ok: true });
    },
  );
};
