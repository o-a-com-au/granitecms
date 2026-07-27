import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import type { BatchOperation, BatchPublish } from '../services/batch.ts';
import { BatchError, runBatch } from '../services/batch.ts';
import { isValidCommitAuthor } from '../services/git.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { WRITE_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';
import { requireScope } from '../services/token-auth.ts';
import type { ThemeSchemas } from '../services/validation.ts';
import type { TokenEntry } from '../server-config.ts';

export interface BatchRouteOptions {
  config: SiteConfig;
  themeSchemas: ThemeSchemas;
  tokens: TokenEntry[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseOperation(value: unknown): BatchOperation | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const { type } = value;
  switch (type) {
    case 'draft-write': {
      const { path, content, expectedEtag } = value;
      if (!isNonEmptyString(path) || !isPlainObject(content) || !isNonEmptyString(expectedEtag)) {
        return null;
      }
      return { type, path, content, expectedEtag };
    }
    case 'draft-discard': {
      const { path } = value;
      if (!isNonEmptyString(path)) {
        return null;
      }
      return { type, path };
    }
    case 'content-delete': {
      const { path, redirectTo } = value;
      if (!isNonEmptyString(path) || (redirectTo !== undefined && !isNonEmptyString(redirectTo))) {
        return null;
      }
      return { type, path, redirectTo };
    }
    case 'move': {
      const { from, to } = value;
      if (!isNonEmptyString(from) || !isNonEmptyString(to)) {
        return null;
      }
      return { type, from, to };
    }
    default:
      return null;
  }
}

function parsePublish(value: unknown): BatchPublish | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const { paths } = value;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every(isNonEmptyString)) {
    return null;
  }
  return { relativePaths: paths };
}

interface BatchBody {
  operations: BatchOperation[];
  publish?: BatchPublish;
  message: string;
  author: { name: string; email: string };
}

const BATCH_BODY_SHAPE =
  'Expected { operations: BatchOperation[], publish?: { paths: string[] }, message: string, author: { name, email } }';

function parseBatchBody(body: unknown): BatchBody | null {
  if (!isPlainObject(body)) {
    return null;
  }
  const { operations, publish, message, author } = body;
  if (!Array.isArray(operations)) {
    return null;
  }
  const parsedOperations: BatchOperation[] = [];
  for (const raw of operations) {
    const operation = parseOperation(raw);
    if (!operation) {
      return null;
    }
    parsedOperations.push(operation);
  }

  let parsedPublish: BatchPublish | undefined;
  if (publish !== undefined) {
    const result = parsePublish(publish);
    if (!result) {
      return null;
    }
    parsedPublish = result;
  }

  if (!isNonEmptyString(message) || !isValidCommitAuthor(author)) {
    return null;
  }

  return { operations: parsedOperations, publish: parsedPublish, message, author };
}

// Maps every BatchReason to a status code, mirroring the same mapping
// each originating service's own route already applies (publish.ts's
// replyForPublishError, content.ts's move/delete handlers, drafts.ts's
// conflict/validation-failed handling) - kept as one switch here since
// batch.ts's BatchReason is a superset drawn from all four services.
function replyForBatchError(reply: FastifyReply, error: BatchError): void {
  switch (error.reason) {
    case 'conflict':
      reply.code(409).send({ statusCode: 409, error: 'Conflict', message: error.message });
      return;
    case 'destination-exists':
      reply.code(409).send({ statusCode: 409, error: 'Conflict', message: error.message });
      return;
    case 'has-children':
      reply.code(409).send({ statusCode: 409, error: 'Conflict', message: error.message });
      return;
    case 'validation-failed':
    case 'duplicate-path':
    case 'redirect-cycle':
      reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: error.message });
      return;
    case 'page-not-found':
    case 'source-not-found':
    case 'draft-not-found':
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: error.message });
      return;
    default:
      // write-failed / commit-failed / rollback-failed: no client-side
      // fix applies, fall through to the global handler's sanitised 500.
      throw error;
  }
}

export const batchRoutes: FastifyPluginAsync<BatchRouteOptions> = async (
  fastify: FastifyInstance,
  opts: BatchRouteOptions,
) => {
  fastify.post(
    '/batch',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = parseBatchBody(request.body);
      if (!parsed) {
        reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: BATCH_BODY_SHAPE });
        return;
      }

      try {
        await runBatch(
          opts.config,
          opts.themeSchemas,
          parsed.operations,
          parsed.publish,
          parsed.message,
          parsed.author,
        );
        reply.send({ ok: true });
      } catch (error) {
        // PathSafetyError has no .statusCode - left uncaught it falls
        // through to the global handler's sanitised 500, the same gap
        // every other route touching a :path already guards against.
        if (error instanceof PathSafetyError) {
          reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'No content at that path' });
          return;
        }
        if (error instanceof BatchError) {
          replyForBatchError(reply, error);
          return;
        }
        throw error;
      }
    },
  );
};
