import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { PathSafetyError, sanitisePath } from '../services/path-safety.ts';

export interface AssetsRouteOptions {
  config: SiteConfig;
}

// A small hand-rolled lookup, not a dependency (@fastify/static would
// be the obvious ecosystem package, but this is a handful of lines and
// matches this codebase's existing minimal-dependency posture). Only
// the common web asset types - nothing here needs to be exhaustive.
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const DEFAULT_MIME_TYPE = 'application/octet-stream';

async function handleAssetRequest(
  request: FastifyRequest<{ Params: { '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const relativePath = request.params['*'];
  try {
    const fullPath = sanitisePath(config.assetsRoot, relativePath);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No asset at "${relativePath}"` });
      return;
    }
    const contentType = MIME_TYPES[extname(fullPath).toLowerCase()] ?? DEFAULT_MIME_TYPE;
    // A synchronous buffered read, not a stream: reply.send(stream)
    // was verified empirically to produce an empty body in this
    // Fastify version (confirmed both via .inject() and a real socket,
    // isolated down to a minimal repro) - a real, environment-specific
    // problem, not a mistake in this route's own logic. No Range/
    // If-Range support in this pass either way (nothing has asked for
    // large-file streaming yet), so buffering the whole file is not a
    // meaningful regression.
    reply.type(contentType).send(readFileSync(fullPath));
  } catch (error) {
    if (error instanceof PathSafetyError) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No asset at "${relativePath}"` });
      return;
    }
    throw error;
  }
}

// Deliberately and permanently unauthenticated: static assets (CSS/JS/
// images) must be fetchable by any visitor's browser without a token,
// same as the public website itself. Registered without a /v1 prefix,
// directly on app in server.ts, alongside publicRoutes. No guard
// against the public catch-all's own /* wildcard is needed here - this
// is the more specific static-prefixed route winning cleanly (verified
// empirically), not the reverse case that needed public.ts's /v1/*
// guard.
export const assetsRoutes: FastifyPluginAsync<AssetsRouteOptions> = async (
  fastify: FastifyInstance,
  opts: AssetsRouteOptions,
) => {
  fastify.get('/assets/*', async (request, reply) =>
    handleAssetRequest(request as FastifyRequest<{ Params: { '*': string } }>, reply, opts.config),
  );
};
