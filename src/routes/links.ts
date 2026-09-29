import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { findReferences, linkTarget } from '../services/links.ts';
import { requireScope } from '../services/token-auth.ts';
import type { TokenEntry } from '../server-config.ts';

export interface LinksRouteOptions {
  config: SiteConfig;
  tokens: TokenEntry[];
}

// GET /v1/links?to=/about: every page, draft, menu and the site settings
// that link to that page - what the admin lists before a page is
// deleted. `to` is only ever compared against links found in content,
// never used as a file path. Found by reading the content each time
// rather than kept in an index: always current, and cheap at a site's
// size.
export const linksRoutes: FastifyPluginAsync<LinksRouteOptions> = async (fastify: FastifyInstance, opts: LinksRouteOptions) => {
  fastify.get('/links', { preHandler: requireScope(opts.tokens, 'content') }, async (request, reply) => {
    const to = (request.query as { to?: unknown }).to;
    if (typeof to !== 'string' || linkTarget(to) === null) {
      reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'Expected ?to=/a-page-path' });
      return;
    }
    reply.send({ to: linkTarget(to), references: findReferences(opts.config, to) });
  });
};
