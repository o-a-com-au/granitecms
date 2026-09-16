import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { isValidCommitAuthor } from '../services/git.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { WRITE_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';
import { PublishError, publishDrafts, publishPage, unpublishPage } from '../services/publish.ts';
import { requireScope } from '../services/token-auth.ts';
import type { ThemeSchemas } from '../services/validation.ts';
import type { TokenEntry } from '../server-config.ts';

export interface PublishRouteOptions {
  config: SiteConfig;
  themeSchemas: ThemeSchemas;
  tokens: TokenEntry[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

interface PublishBody {
  paths: string[];
  message: string;
  author: { name: string; email: string };
}

function parsePublishBody(body: unknown): PublishBody | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { paths, message, author } = body as Record<string, unknown>;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every(isNonEmptyString)) {
    return null;
  }
  if (!isNonEmptyString(message) || !isValidCommitAuthor(author)) {
    return null;
  }
  return { paths, message, author };
}

// Shared by /unpublish/* and /publish-page/* - both take the identical
// { message, author } body, since the path itself carries which way the
// published flag is being flipped.
interface PublishedFlagBody {
  message: string;
  author: { name: string; email: string };
}

function parsePublishedFlagBody(body: unknown): PublishedFlagBody | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { message, author } = body as Record<string, unknown>;
  if (!isNonEmptyString(message) || !isValidCommitAuthor(author)) {
    return null;
  }
  return { message, author };
}

// Shared by both handlers below: each only ever sees the subset of
// reasons its own service function can actually throw.
function replyForPublishError(reply: FastifyReply, error: PublishError): void {
  if (error.reason === 'validation-failed' || error.reason === 'duplicate-path') {
    reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: error.message });
    return;
  }
  if (error.reason === 'draft-not-found' || error.reason === 'page-not-found') {
    reply.code(404).send({ statusCode: 404, error: 'Not Found', message: error.message });
    return;
  }
  throw error;
}

export const publishRoutes: FastifyPluginAsync<PublishRouteOptions> = async (
  fastify: FastifyInstance,
  opts: PublishRouteOptions,
) => {
  fastify.post(
    '/publish',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = parsePublishBody(request.body);
      if (!parsed) {
        reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Expected { paths: string[], message: string, author: { name, email } }',
        });
        return;
      }

      try {
        await publishDrafts(opts.config, opts.themeSchemas, parsed.paths, parsed.message, parsed.author);
        reply.send({ ok: true });
      } catch (error) {
        // PathSafetyError has no .statusCode - left uncaught it falls
        // through to the global handler's sanitised 500, the same gap
        // every other route touching a :path already guards against.
        if (error instanceof PathSafetyError) {
          reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'No content at that path' });
          return;
        }
        if (error instanceof PublishError) {
          replyForPublishError(reply, error);
          return;
        }
        throw error;
      }
    },
  );

  fastify.post(
    '/unpublish/*',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request, reply) => {
      const parsed = parsePublishedFlagBody(request.body);
      if (!parsed) {
        reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Expected { message: string, author: { name, email } }',
        });
        return;
      }

      const relativePath = (request as FastifyRequest<{ Params: { '*': string } }>).params['*'];
      try {
        await unpublishPage(opts.config, relativePath, parsed.message, parsed.author);
        reply.send({ ok: true });
      } catch (error) {
        // PathSafetyError has no .statusCode - left uncaught it falls
        // through to the global handler's sanitised 500, the same gap
        // every other route touching a :path already guards against.
        if (error instanceof PathSafetyError) {
          reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'No content at that path' });
          return;
        }
        if (error instanceof PublishError) {
          replyForPublishError(reply, error);
          return;
        }
        throw error;
      }
    },
  );

  // The twin of /unpublish/* above: sets published:true on a live page
  // in place and commits. Deliberately separate from /publish, which
  // promotes drafts - a page that is live but unpublished has no draft
  // to promote, so /publish cannot reach it at all (draft-not-found),
  // and promoting a draft would publish every pending edit along with
  // the flag. This only ever changes the one boolean.
  fastify.post(
    '/publish-page/*',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request, reply) => {
      const parsed = parsePublishedFlagBody(request.body);
      if (!parsed) {
        reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Expected { message: string, author: { name, email } }',
        });
        return;
      }

      const relativePath = (request as FastifyRequest<{ Params: { '*': string } }>).params['*'];
      try {
        await publishPage(opts.config, relativePath, parsed.message, parsed.author);
        reply.send({ ok: true });
      } catch (error) {
        // Same PathSafetyError guard as every other :path route here.
        if (error instanceof PathSafetyError) {
          reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'No content at that path' });
          return;
        }
        if (error instanceof PublishError) {
          replyForPublishError(reply, error);
          return;
        }
        throw error;
      }
    },
  );
};
