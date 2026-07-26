import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { ContentReadError, listContent, readContentFile } from '../services/content-read.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { requireScope } from '../services/token-auth.ts';
import type { TokenEntry } from '../server-config.ts';

export interface ContentRouteOptions {
  config: SiteConfig;
  tokens: TokenEntry[];
}

async function handleReadContent(
  request: FastifyRequest<{ Params: { '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const relativePath = request.params['*'];
  try {
    const { bytes, etag } = readContentFile(config.contentRoot, relativePath);
    reply.header('etag', etag).type('application/json; charset=utf-8').send(bytes);
  } catch (error) {
    // PathSafetyError has no .statusCode - left uncaught it would fall
    // through to the global handler's generic sanitised 500, matching
    // the gap preview.ts's precedent already guards against.
    if (error instanceof PathSafetyError || (error instanceof ContentReadError && error.reason === 'not-found')) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No content at "${relativePath}"` });
      return;
    }
    throw error;
  }
}

interface ListContentQuery {
  type?: string;
  prefix?: string;
  draftStatus?: 'has-draft' | 'no-draft';
}

async function handleListContent(
  request: FastifyRequest<{ Querystring: ListContentQuery }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const { type, prefix, draftStatus } = request.query;
  const entries = listContent(config, { type, prefix, draftStatus });
  reply.send(entries);
}

export const contentRoutes: FastifyPluginAsync<ContentRouteOptions> = async (
  fastify: FastifyInstance,
  opts: ContentRouteOptions,
) => {
  fastify.get(
    '/content',
    { preHandler: requireScope(opts.tokens, 'content') },
    async (request, reply) =>
      handleListContent(request as FastifyRequest<{ Querystring: ListContentQuery }>, reply, opts.config),
  );

  fastify.get(
    '/content/*',
    { preHandler: requireScope(opts.tokens, 'content') },
    async (request, reply) =>
      handleReadContent(request as FastifyRequest<{ Params: { '*': string } }>, reply, opts.config),
  );
};
