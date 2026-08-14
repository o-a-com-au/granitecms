import { extname } from 'node:path';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { ManageMediaError, deleteMedia, listMedia, putMedia } from '../media/manage-media.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { WRITE_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';
import { requireScope } from '../services/token-auth.ts';
import type { TokenEntry } from '../server-config.ts';

export interface MediaRouteOptions {
  config: SiteConfig;
  tokens: TokenEntry[];
  maxUploadBytes: number;
}

// Images only - confirmed with the user, not a general document
// library. Checked against the *original* uploaded filename, not the
// client-supplied mimetype header (trivially spoofable) and not the
// stored content-addressed filename (built only after this check
// passes, from the same already-validated extension). .svg is
// rejected regardless of this list even though it's technically an
// image format - docs/cms-build-plan.md's own "SVG rejected outright,
// not sanitised" decision.
const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function sendManageMediaError(reply: FastifyReply, error: ManageMediaError): void {
  if (error.reason === 'not-found') {
    reply.code(404).send({ statusCode: 404, error: 'Not Found', message: error.message });
    return;
  }
  throw error;
}

async function handleListMedia(_request: FastifyRequest, reply: FastifyReply, config: SiteConfig): Promise<void> {
  reply.send(await listMedia(config));
}

async function handleUploadMedia(request: FastifyRequest, reply: FastifyReply, config: SiteConfig): Promise<void> {
  const data = await request.file();
  if (!data) {
    reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'Expected a multipart file upload' });
    return;
  }

  const extension = extname(data.filename).toLowerCase();
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
    reply.code(415).send({
      statusCode: 415,
      error: 'Unsupported Media Type',
      message: `"${extension}" is not an accepted image type`,
    });
    return;
  }

  // No try/catch around toBuffer(): @fastify/multipart's own
  // RequestFileTooLargeError already carries .statusCode = 413, so it
  // passes straight through server.ts's existing global error handler
  // unchanged - the same "just throw and let the existing handler map
  // it" pattern already used for AuthError elsewhere. busboy enforces
  // limits.fileSize *during* the stream (rejecting once the cap is
  // hit, never silently truncating), not after buffering an unbounded
  // body into memory first - this is what "capped at the stream
  // level" actually means in practice.
  const bytes = await data.toBuffer();
  const result = await putMedia(config, data.filename, bytes);
  reply.code(201).send(result);
}

async function handleDeleteMedia(
  request: FastifyRequest<{ Params: { '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const filename = request.params['*'];
  try {
    await deleteMedia(config, filename);
    reply.code(204).send();
  } catch (error) {
    if (error instanceof PathSafetyError) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No media file at "${filename}"` });
      return;
    }
    if (error instanceof ManageMediaError) {
      sendManageMediaError(reply, error);
      return;
    }
    throw error;
  }
}

export const mediaRoutes: FastifyPluginAsync<MediaRouteOptions> = async (
  fastify: FastifyInstance,
  opts: MediaRouteOptions,
) => {
  // Registered inside this plugin's own encapsulation scope (media.ts
  // is registered plainly, never wrapped in fastify-plugin's fp() -
  // matching this codebase's house rule so Group B's auth preHandler
  // hooks keep working), not globally in server.ts - confines the
  // multipart content-type parser and .file()/.files() decorations to
  // media routes only, leaving every other route file's default JSON
  // body parsing completely untouched.
  await fastify.register(multipart, { limits: { fileSize: opts.maxUploadBytes } });

  fastify.get(
    '/media',
    { preHandler: requireScope(opts.tokens, 'media') },
    async (request, reply) => handleListMedia(request, reply, opts.config),
  );

  fastify.post(
    '/media',
    { preHandler: requireScope(opts.tokens, 'media'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request, reply) => handleUploadMedia(request, reply, opts.config),
  );

  fastify.delete(
    '/media/*',
    { preHandler: requireScope(opts.tokens, 'media'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request, reply) =>
      handleDeleteMedia(request as FastifyRequest<{ Params: { '*': string } }>, reply, opts.config),
  );
};
