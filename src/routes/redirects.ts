import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { isValidCommitAuthor } from '../services/git.ts';
import { ManageRedirectError, createRedirect, deleteRedirect, updateRedirect } from '../services/manage-redirects.ts';
import { loadRedirects } from '../services/redirects.ts';
import { WRITE_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';
import { requireScope } from '../services/token-auth.ts';
import type { TokenEntry } from '../server-config.ts';

export interface RedirectsRouteOptions {
  config: SiteConfig;
  tokens: TokenEntry[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

interface UpsertRedirectBody {
  from: string;
  to: string;
  note?: string;
  message: string;
  author: { name: string; email: string };
}

function parseUpsertRedirectBody(body: unknown): UpsertRedirectBody | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { from, to, note, message, author } = body as Record<string, unknown>;
  if (!isNonEmptyString(from) || !isNonEmptyString(to)) {
    return null;
  }
  if (note !== undefined && typeof note !== 'string') {
    return null;
  }
  if (!isNonEmptyString(message) || !isValidCommitAuthor(author)) {
    return null;
  }
  return { from, to, note, message, author };
}

interface DeleteRedirectBody {
  from: string;
  message: string;
  author: { name: string; email: string };
}

function parseDeleteRedirectBody(body: unknown): DeleteRedirectBody | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { from, message, author } = body as Record<string, unknown>;
  if (!isNonEmptyString(from) || !isNonEmptyString(message) || !isValidCommitAuthor(author)) {
    return null;
  }
  return { from, message, author };
}

function sendManageRedirectError(reply: FastifyReply, error: ManageRedirectError): void {
  if (error.reason === 'invalid-from' || error.reason === 'invalid-target' || error.reason === 'redirect-cycle') {
    reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: error.message });
    return;
  }
  if (error.reason === 'not-found') {
    reply.code(404).send({ statusCode: 404, error: 'Not Found', message: error.message });
    return;
  }
  if (error.reason === 'already-exists' || error.reason === 'live-content-exists') {
    reply.code(409).send({ statusCode: 409, error: 'Conflict', message: error.message });
    return;
  }
  throw error;
}

async function handleListRedirects(_request: FastifyRequest, reply: FastifyReply, config: SiteConfig): Promise<void> {
  reply.send(loadRedirects(config));
}

async function handleCreateRedirect(request: FastifyRequest, reply: FastifyReply, config: SiteConfig): Promise<void> {
  const parsed = parseUpsertRedirectBody(request.body);
  if (!parsed) {
    reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Expected { from: string, to: string, note?: string, message: string, author: { name, email } }',
    });
    return;
  }

  try {
    const result = await createRedirect(config, parsed.from, parsed.to, parsed.note, parsed.message, parsed.author);
    reply.send(result);
  } catch (error) {
    if (error instanceof ManageRedirectError) {
      sendManageRedirectError(reply, error);
      return;
    }
    throw error;
  }
}

async function handleUpdateRedirect(request: FastifyRequest, reply: FastifyReply, config: SiteConfig): Promise<void> {
  const parsed = parseUpsertRedirectBody(request.body);
  if (!parsed) {
    reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Expected { from: string, to: string, note?: string, message: string, author: { name, email } }',
    });
    return;
  }

  try {
    const result = await updateRedirect(config, parsed.from, parsed.to, parsed.note, parsed.message, parsed.author);
    reply.send(result);
  } catch (error) {
    if (error instanceof ManageRedirectError) {
      sendManageRedirectError(reply, error);
      return;
    }
    throw error;
  }
}

async function handleDeleteRedirect(request: FastifyRequest, reply: FastifyReply, config: SiteConfig): Promise<void> {
  const parsed = parseDeleteRedirectBody(request.body);
  if (!parsed) {
    reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Expected { from: string, message: string, author: { name, email } }',
    });
    return;
  }

  try {
    await deleteRedirect(config, parsed.from, parsed.message, parsed.author);
    reply.code(204).send();
  } catch (error) {
    if (error instanceof ManageRedirectError) {
      sendManageRedirectError(reply, error);
      return;
    }
    throw error;
  }
}

// from/to are always taken from the JSON body, never a URL path
// segment: they are arbitrary public URLs that may contain slashes,
// and critically none of these operations address a filesystem path
// at all (this mutates one entry inside redirects.json, not a file at
// a client-supplied path) - sanitisePath/path-traversal simply doesn't
// apply here, matching POST /content/move's existing body-carries-the-
// identity precedent rather than forcing an arbitrary URL into a route
// segment.
export const redirectsRoutes: FastifyPluginAsync<RedirectsRouteOptions> = async (
  fastify: FastifyInstance,
  opts: RedirectsRouteOptions,
) => {
  fastify.get(
    '/redirects',
    { preHandler: requireScope(opts.tokens, 'content') },
    async (request, reply) => handleListRedirects(request, reply, opts.config),
  );

  fastify.post(
    '/redirects',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request, reply) => handleCreateRedirect(request, reply, opts.config),
  );

  fastify.put(
    '/redirects',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request, reply) => handleUpdateRedirect(request, reply, opts.config),
  );

  fastify.delete(
    '/redirects',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request, reply) => handleDeleteRedirect(request, reply, opts.config),
  );
};
