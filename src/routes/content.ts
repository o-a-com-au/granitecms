import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { ContentReadError, listContent, readContentFile } from '../services/content-read.ts';
import { DeleteContentError, deleteContent } from '../services/delete-content.ts';
import { isValidCommitAuthor } from '../services/git.ts';
import { MoveError, movePage } from '../services/move.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { WRITE_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';
import { requireScope } from '../services/token-auth.ts';
import type { TokenEntry } from '../server-config.ts';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

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

interface DeleteContentBody {
  redirectTo?: string;
  message: string;
  author: { name: string; email: string };
}

function parseDeleteContentBody(body: unknown): DeleteContentBody | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { redirectTo, message, author } = body as Record<string, unknown>;
  if (redirectTo !== undefined && !isNonEmptyString(redirectTo)) {
    return null;
  }
  if (!isNonEmptyString(message) || !isValidCommitAuthor(author)) {
    return null;
  }
  return { redirectTo, message, author };
}

async function handleDeleteContent(
  request: FastifyRequest<{ Params: { '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const relativePath = request.params['*'];
  const parsed = parseDeleteContentBody(request.body);
  if (!parsed) {
    reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Expected { redirectTo?: string, message: string, author: { name, email } }',
    });
    return;
  }

  try {
    await deleteContent(config, relativePath, parsed.redirectTo, parsed.message, parsed.author);
    reply.code(204).send();
  } catch (error) {
    if (error instanceof PathSafetyError) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No content at "${relativePath}"` });
      return;
    }
    if (error instanceof DeleteContentError) {
      if (error.reason === 'page-not-found') {
        reply.code(404).send({ statusCode: 404, error: 'Not Found', message: error.message });
        return;
      }
      if (error.reason === 'has-children') {
        reply.code(409).send({ statusCode: 409, error: 'Conflict', message: error.message });
        return;
      }
      if (error.reason === 'redirect-cycle') {
        reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: error.message });
        return;
      }
    }
    throw error;
  }
}

interface MoveContentBody {
  from: string;
  to: string;
  message: string;
  author: { name: string; email: string };
}

function parseMoveContentBody(body: unknown): MoveContentBody | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { from, to, message, author } = body as Record<string, unknown>;
  if (!isNonEmptyString(from) || !isNonEmptyString(to)) {
    return null;
  }
  if (!isNonEmptyString(message) || !isValidCommitAuthor(author)) {
    return null;
  }
  return { from, to, message, author };
}

async function handleMoveContent(request: FastifyRequest, reply: FastifyReply, config: SiteConfig): Promise<void> {
  const parsed = parseMoveContentBody(request.body);
  if (!parsed) {
    reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Expected { from: string, to: string, message: string, author: { name, email } }',
    });
    return;
  }

  try {
    await movePage(config, parsed.from, parsed.to, parsed.message, parsed.author);
    reply.send({ ok: true });
  } catch (error) {
    if (error instanceof PathSafetyError) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No page at "${parsed.from}"` });
      return;
    }
    if (error instanceof MoveError) {
      if (error.reason === 'source-not-found') {
        reply.code(404).send({ statusCode: 404, error: 'Not Found', message: error.message });
        return;
      }
      if (error.reason === 'destination-exists') {
        reply.code(409).send({ statusCode: 409, error: 'Conflict', message: error.message });
        return;
      }
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

  fastify.delete(
    '/content/*',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request, reply) =>
      handleDeleteContent(request as FastifyRequest<{ Params: { '*': string } }>, reply, opts.config),
  );

  // A static path, distinct from the GET/DELETE /content/* wildcard
  // above by method as well as by not matching the wildcard's own
  // prefix shape at all (POST here, GET/DELETE there) - no routing
  // collision, per Group C's own verified precedent that Fastify
  // prefers static/exact matches over a wildcard regardless of
  // registration order.
  fastify.post(
    '/content/move',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request, reply) => handleMoveContent(request, reply, opts.config),
  );
};
