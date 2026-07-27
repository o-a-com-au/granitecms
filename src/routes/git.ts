import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { commitWorkingTreeChanges } from '../services/git-commit.ts';
import { GitShowError, getCommitLog, readFileAtRevision } from '../services/git-history.ts';
import { RevertError, revertPaths } from '../services/git-revert.ts';
import { isValidCommitAuthor, isValidGitRef } from '../services/git.ts';
import { mimeTypeFor } from '../services/mime-types.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { WRITE_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';
import { requireScope } from '../services/token-auth.ts';
import type { TokenEntry } from '../server-config.ts';

export interface GitRouteOptions {
  config: SiteConfig;
  tokens: TokenEntry[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

interface LogQuery {
  path?: string;
  limit?: string;
}

async function handleGitLog(
  request: FastifyRequest<{ Querystring: LogQuery }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const { path, limit: rawLimit } = request.query;

  let limit: number | undefined;
  if (rawLimit !== undefined) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: '"limit" must be a positive integer',
      });
      return;
    }
    limit = parsed;
  }

  try {
    const result = getCommitLog(config, { path, limit });
    reply.send(result);
  } catch (error) {
    // PathSafetyError has no .statusCode - left uncaught it falls
    // through to the global handler's sanitised 500, the same gap
    // every other route touching a :path already guards against.
    if (error instanceof PathSafetyError) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'No content at that path' });
      return;
    }
    throw error;
  }
}

async function handleGitShow(
  request: FastifyRequest<{ Params: { ref: string; '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const { ref } = request.params;
  const relativePath = request.params['*'];

  if (!isValidGitRef(ref)) {
    reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: `Invalid ref: "${ref}"` });
    return;
  }

  try {
    const content = readFileAtRevision(config, ref, relativePath);
    reply.type(mimeTypeFor(relativePath)).send(content);
  } catch (error) {
    if (error instanceof PathSafetyError) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'No content at that path' });
      return;
    }
    if (error instanceof GitShowError) {
      // Two distinct codes, not collapsed to one 404: unlike public.ts's
      // deliberate traversal-vs-miss collapse (justified there because
      // that route is unauthenticated, where leaking which case
      // occurred would aid enumeration), this route sits behind
      // requireScope already - there's no equivalent risk, and
      // collapsing here would only make an admin's diff/history UI
      // worse for no security benefit.
      const code = error.reason === 'invalid-ref' ? 400 : 404;
      reply.code(code).send({
        statusCode: code,
        error: code === 400 ? 'Bad Request' : 'Not Found',
        message: error.message,
      });
      return;
    }
    throw error;
  }
}

interface RevertBody {
  ref: string;
  paths: string[];
  message: string;
  author: { name: string; email: string };
}

function parseRevertBody(body: unknown): RevertBody | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { ref, paths, message, author } = body as Record<string, unknown>;
  if (!isNonEmptyString(ref)) {
    return null;
  }
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every(isNonEmptyString)) {
    return null;
  }
  if (!isNonEmptyString(message) || !isValidCommitAuthor(author)) {
    return null;
  }
  return { ref, paths, message, author };
}

async function handleGitRevert(
  request: FastifyRequest,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const parsed = parseRevertBody(request.body);
  if (!parsed) {
    reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Expected { ref: string, paths: string[], message: string, author: { name, email } }',
    });
    return;
  }

  try {
    await revertPaths(config, parsed.ref, parsed.paths, parsed.message, parsed.author);
    reply.send({ ok: true });
  } catch (error) {
    if (error instanceof PathSafetyError) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'No content at that path' });
      return;
    }
    if (error instanceof RevertError) {
      if (error.reason === 'invalid-ref') {
        reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: error.message });
        return;
      }
      if (error.reason === 'path-not-found-at-ref') {
        reply.code(404).send({ statusCode: 404, error: 'Not Found', message: error.message });
        return;
      }
      // write-failed/commit-failed/rollback-failed: no client-side fix
      // applies, fall through to the global handler's sanitised 500.
    }
    throw error;
  }
}

interface CommitBody {
  message: string;
  author: { name: string; email: string };
}

function parseCommitBody(body: unknown): CommitBody | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { message, author } = body as Record<string, unknown>;
  if (!isNonEmptyString(message) || !isValidCommitAuthor(author)) {
    return null;
  }
  return { message, author };
}

async function handleGitCommit(
  request: FastifyRequest,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const parsed = parseCommitBody(request.body);
  if (!parsed) {
    reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Expected { message: string, author: { name, email } }',
    });
    return;
  }

  // Any GitOperationError here is not caught - it rethrows to the
  // global error handler's sanitised 500, same as every other route's
  // uncaught commitPaths failure.
  const result = await commitWorkingTreeChanges(config, parsed.message, parsed.author);
  reply.send({ ok: true, committed: result === 'committed' });
}

export const gitRoutes: FastifyPluginAsync<GitRouteOptions> = async (
  fastify: FastifyInstance,
  opts: GitRouteOptions,
) => {
  fastify.get(
    '/git/log',
    { preHandler: requireScope(opts.tokens, 'content') },
    async (request, reply) =>
      handleGitLog(request as FastifyRequest<{ Querystring: LogQuery }>, reply, opts.config),
  );

  fastify.get(
    '/git/show/:ref/*',
    { preHandler: requireScope(opts.tokens, 'content') },
    async (request, reply) =>
      handleGitShow(
        request as FastifyRequest<{ Params: { ref: string; '*': string } }>,
        reply,
        opts.config,
      ),
  );

  fastify.post(
    '/git/revert',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request, reply) => handleGitRevert(request, reply, opts.config),
  );

  fastify.post(
    '/git/commit',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request, reply) => handleGitCommit(request, reply, opts.config),
  );
};
