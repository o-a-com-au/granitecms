import { existsSync, readFileSync, statSync } from 'node:fs';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { mimeTypeFor } from '../services/mime-types.ts';
import { PathSafetyError, sanitisePath } from '../services/path-safety.ts';

export interface AssetsRouteOptions {
  config: SiteConfig;
}

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
    const contentType = mimeTypeFor(fullPath);
    // A synchronous buffered read, not a stream: reply.send(stream)
    // was verified empirically to produce an empty body in this
    // Fastify version (confirmed both via .inject() and a real socket,
    // isolated down to a minimal repro) - a real, environment-specific
    // problem, not a mistake in this route's own logic. No Range/
    // If-Range support in this pass either way (nothing has asked for
    // large-file streaming yet), so buffering the whole file is not a
    // meaningful regression.
    // Access-Control-Allow-Origin: * - a font loaded via @font-face
    // enforces CORS unconditionally per spec, unlike CSS/images from
    // the same URL, which don't. Found live: the admin's preview route
    // proxies a site's HTML into its own origin with a <base href> fix
    // (see app-granite-cms-admin's site-preview.ts), so the browser's
    // actual font requests are genuinely cross-origin from the admin's
    // page - without this header those requests fail with a CORS
    // error even though the resource itself loads fine directly. Safe
    // here specifically because this route is already deliberately
    // unauthenticated and meant to be fetchable by any visitor's
    // browser regardless of origin.
    reply.header('Access-Control-Allow-Origin', '*').type(contentType).send(readFileSync(fullPath));
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
