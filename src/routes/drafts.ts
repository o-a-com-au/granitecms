import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { ContentReadError, readContentFile } from '../services/content-read.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { requireScope } from '../services/token-auth.ts';
import type { TokenEntry } from '../server-config.ts';

export interface DraftsRouteOptions {
  config: SiteConfig;
  tokens: TokenEntry[];
}

async function handleReadDraft(
  request: FastifyRequest<{ Params: { '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const relativePath = request.params['*'];
  try {
    const { bytes, etag } = readContentFile(config.draftsRoot, relativePath);
    reply.header('etag', etag).type('application/json; charset=utf-8').send(bytes);
  } catch (error) {
    if (error instanceof PathSafetyError || (error instanceof ContentReadError && error.reason === 'not-found')) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No draft at "${relativePath}"` });
      return;
    }
    throw error;
  }
}

// GET /v1/drafts/:path today (D2). Group E extends this same file with
// PUT/DELETE /v1/drafts/:path.
export const draftsRoutes: FastifyPluginAsync<DraftsRouteOptions> = async (
  fastify: FastifyInstance,
  opts: DraftsRouteOptions,
) => {
  fastify.get(
    '/drafts/*',
    { preHandler: requireScope(opts.tokens, 'content') },
    async (request, reply) =>
      handleReadDraft(request as FastifyRequest<{ Params: { '*': string } }>, reply, opts.config),
  );
};
