import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { ContentReadError, readContentFile } from '../services/content-read.ts';
import { DraftError, discardDraft, saveDraft } from '../services/drafts.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { requireScope } from '../services/token-auth.ts';
import type { ThemeSchemas } from '../services/validation.ts';
import type { TokenEntry } from '../server-config.ts';

export interface DraftsRouteOptions {
  config: SiteConfig;
  themeSchemas: ThemeSchemas;
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

async function handleSaveDraft(
  request: FastifyRequest<{ Params: { '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
): Promise<void> {
  const relativePath = request.params['*'];

  // A static per-request property (is the header present at all on
  // *this* request), not shared mutable state - no TOCTOU risk in
  // checking it here, before the queue, unlike the ETag comparison
  // itself (E2/E4/E6), which must happen inside saveDraftJob.
  const ifMatch = request.headers['if-match'];
  if (typeof ifMatch !== 'string' || ifMatch.length === 0) {
    reply.code(428).send({
      statusCode: 428,
      error: 'Precondition Required',
      message: 'An If-Match header is required to save a draft',
    });
    return;
  }

  try {
    const newEtag = await saveDraft(config, themeSchemas, relativePath, request.body, ifMatch);
    reply.header('etag', newEtag).send({ ok: true });
  } catch (error) {
    if (error instanceof PathSafetyError) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No draft at "${relativePath}"` });
      return;
    }
    if (error instanceof DraftError && error.reason === 'conflict') {
      reply.code(409).send({ statusCode: 409, error: 'Conflict', message: error.message });
      return;
    }
    if (error instanceof DraftError && error.reason === 'validation-failed') {
      reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: error.message });
      return;
    }
    throw error;
  }
}

async function handleDiscardDraft(
  request: FastifyRequest<{ Params: { '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const relativePath = request.params['*'];
  try {
    await discardDraft(config, relativePath);
    reply.code(204).send();
  } catch (error) {
    if (error instanceof PathSafetyError) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No draft at "${relativePath}"` });
      return;
    }
    throw error;
  }
}

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

  fastify.put(
    '/drafts/*',
    { preHandler: requireScope(opts.tokens, 'content') },
    async (request, reply) =>
      handleSaveDraft(
        request as FastifyRequest<{ Params: { '*': string } }>,
        reply,
        opts.config,
        opts.themeSchemas,
      ),
  );

  fastify.delete(
    '/drafts/*',
    { preHandler: requireScope(opts.tokens, 'content') },
    async (request, reply) =>
      handleDiscardDraft(request as FastifyRequest<{ Params: { '*': string } }>, reply, opts.config),
  );
};
