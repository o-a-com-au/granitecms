import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { openLocalFsMediaDriver } from '../media/drivers/local-fs-driver.ts';
import { mimeTypeFor } from '../services/mime-types.ts';

async function handleMediaRequest(
  request: FastifyRequest<{ Params: { '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const relativePath = request.params['*'];
  // Never read: Fastify doesn't require query params to be declared or
  // consumed, so a Shopify-style ?width=1500 suffix
  // (docs/cms-build-plan.md's Phase 4) is automatically inert with no
  // code needed to "ignore" it - this route is the MVP passthrough
  // driver, real resizing is separately-scoped future work.
  const bytes = await openLocalFsMediaDriver(config.mediaRoot).get(relativePath);
  if (bytes === null) {
    reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No media file at "${relativePath}"` });
    return;
  }
  // nosniff: mimeTypeFor() falls back to application/octet-stream for
  // anything outside its small known-extension table (uploads aren't
  // restricted to that table, only to the images-only allowlist in
  // media.ts), and without this header some browsers will still
  // content-sniff an octet-stream response - the same stored-content
  // risk class SVG rejection already exists to avoid for that specific
  // case.
  // Access-Control-Allow-Origin: * - same reasoning as assets.ts:
  // fonts specifically enforce CORS unconditionally, and the admin's
  // preview route proxies a site's HTML into its own origin (with a
  // <base href> fix), making genuinely cross-origin browser requests
  // for what looks like a same-origin path. Consistent with this
  // route already being deliberately unauthenticated and public.
  reply
    .header('X-Content-Type-Options', 'nosniff')
    .header('Access-Control-Allow-Origin', '*')
    .type(mimeTypeFor(relativePath))
    .send(bytes);
}

// Deliberately and permanently unauthenticated, same reasoning as
// assets.ts: uploaded media must be fetchable by any visitor's browser
// without a token, same as the public website itself. Registered
// without a /v1 prefix, directly on app in server.ts, alongside
// assetsRoutes/publicRoutes.
//
// Reads go through MediaStorageDriver.get() rather than raw fs calls
// (unlike assets.ts, which touches fs directly since theme assets are
// always local) - the one deliberate deviation from assets.ts's own
// shape, since a future object-storage driver needs this route to
// stay storage-agnostic. sanitisePath is called inside the driver
// itself (local-fs-driver.ts), not here - see that file's own comment.
export const mediaPublicRoutes: FastifyPluginAsync<{ config: SiteConfig }> = async (
  fastify: FastifyInstance,
  opts: { config: SiteConfig },
) => {
  fastify.get('/media/*', async (request, reply) =>
    handleMediaRequest(request as FastifyRequest<{ Params: { '*': string } }>, reply, opts.config),
  );
};
