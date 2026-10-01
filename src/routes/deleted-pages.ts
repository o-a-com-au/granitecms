import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { listDeletedPages } from '../services/deleted-pages.ts';
import { requireScope } from '../services/token-auth.ts';
import type { TokenEntry } from '../server-config.ts';

export interface DeletedPagesRouteOptions {
  config: SiteConfig;
  tokens: TokenEntry[];
}

// GET /v1/deleted-pages: pages that were deleted and aren't back, newest
// first, each with the ref to restore it from (POST /v1/git/revert).
export const deletedPagesRoutes: FastifyPluginAsync<DeletedPagesRouteOptions> = async (
  fastify: FastifyInstance,
  opts: DeletedPagesRouteOptions,
) => {
  fastify.get('/deleted-pages', { preHandler: requireScope(opts.tokens, 'content') }, async (_request, reply) => {
    reply.send({ pages: listDeletedPages(opts.config) });
  });
};
