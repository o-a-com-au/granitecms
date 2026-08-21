import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { findStaticFile, sendStaticFile } from '../services/static-file.ts';

export interface AssetsRouteOptions {
  config: SiteConfig;
}

async function handleAssetRequest(
  request: FastifyRequest<{ Params: { '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const relativePath = request.params['*'];
  const match = findStaticFile(config.assetsRoot, relativePath);
  if (!match) {
    reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No asset at "${relativePath}"` });
    return;
  }
  // A synchronous buffered read, not a stream: reply.send(stream) was
  // verified empirically to produce an empty body in this Fastify
  // version (confirmed both via .inject() and a real socket, isolated
  // down to a minimal repro) - a real, environment-specific problem,
  // not a mistake in this route's own logic. No Range/If-Range support
  // in this pass either way (nothing has asked for large-file
  // streaming yet), so buffering the whole file is not a meaningful
  // regression. sendStaticFile (services/static-file.ts) does this
  // read, shared with routes/public.ts's root-mirror check.
  sendStaticFile(reply, match);
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
