import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { isValidCommitAuthor } from '../services/git.ts';
import { ManageMenuError, saveMenu } from '../services/manage-menus.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { WRITE_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';
import { requireScope } from '../services/token-auth.ts';
import type { TokenEntry } from '../server-config.ts';

export interface MenusRouteOptions {
  config: SiteConfig;
  tokens: TokenEntry[];
}

interface SaveMenuBody {
  content: unknown;
  message: string;
  author: { name: string; email: string };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

// The body is wrapped ({ content, message, author }), not raw menu
// content the way PUT /v1/drafts/:path is: unlike a draft save, this
// commits immediately, so it needs the same message/author metadata
// every other commit-creating write in this API takes in its body
// (redirects, publish, delete, move) - a header-based convention would
// be a new, inconsistent pattern for no reason.
function parseSaveMenuBody(body: unknown): SaveMenuBody | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { content, message, author } = body as Record<string, unknown>;
  if (content === undefined || !isNonEmptyString(message) || !isValidCommitAuthor(author)) {
    return null;
  }
  return { content, message, author };
}

async function handleSaveMenu(
  request: FastifyRequest<{ Params: { '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const relativePath = request.params['*'];

  // A static per-request property (is the header present at all on
  // *this* request), not shared mutable state - no TOCTOU risk in
  // checking it here, before the queue, matching drafts.ts's own
  // precedent exactly (the ETag comparison itself must happen inside
  // the queued job, this presence check does not).
  const ifMatch = request.headers['if-match'];
  if (typeof ifMatch !== 'string' || ifMatch.length === 0) {
    reply.code(428).send({
      statusCode: 428,
      error: 'Precondition Required',
      message: 'An If-Match header is required to save a menu',
    });
    return;
  }

  const parsed = parseSaveMenuBody(request.body);
  if (!parsed) {
    reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Expected { content: object, message: string, author: { name, email } }',
    });
    return;
  }

  try {
    const newEtag = await saveMenu(config, relativePath, parsed.content, ifMatch, parsed.message, parsed.author);
    reply.header('etag', newEtag).send({ ok: true });
  } catch (error) {
    if (error instanceof PathSafetyError) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No menu at "${relativePath}"` });
      return;
    }
    if (error instanceof ManageMenuError && error.reason === 'conflict') {
      reply.code(409).send({ statusCode: 409, error: 'Conflict', message: error.message });
      return;
    }
    if (error instanceof ManageMenuError && error.reason === 'validation-failed') {
      reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: error.message });
      return;
    }
    throw error;
  }
}

// GET/DELETE/move for menus/ paths deliberately stay on the existing
// generic /v1/content routes (Group N) - only this write path is new.
// Its own namespace (/v1/menus, not wedged into /v1/content), matching
// how redirects got /v1/redirects rather than overloading /v1/content
// with type-conditional write behaviour.
export const menusRoutes: FastifyPluginAsync<MenusRouteOptions> = async (
  fastify: FastifyInstance,
  opts: MenusRouteOptions,
) => {
  fastify.put(
    '/menus/*',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request, reply) =>
      handleSaveMenu(request as FastifyRequest<{ Params: { '*': string } }>, reply, opts.config),
  );
};
