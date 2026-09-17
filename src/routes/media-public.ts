import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { openLocalFsMediaDriver } from '../media/drivers/local-fs-driver.ts';
import { mimeTypeFor } from '../services/mime-types.ts';

// A single "bytes=start-end" range, resolved against the real file
// size. Deliberately narrow: an open-ended ("bytes=500-") and a suffix
// ("bytes=-500") form are both real and both used by browsers, but a
// MULTI-range request is not answered as multipart/byteranges here -
// it falls back to a plain 200, which is explicitly allowed (a server
// may always ignore Range) and is far better than emitting a subtly
// wrong multipart body. Nothing in this CMS's own use case (a short
// looping video) ever asks for one.
//
// Returns null for "no usable range, send the whole thing", and
// 'unsatisfiable' for a syntactically valid range that falls outside
// the file - which has its own required 416 response, not a 200.
type ResolvedRange = { start: number; end: number } | null | 'unsatisfiable';

export function resolveRange(header: string | undefined, size: number): ResolvedRange {
  if (header === undefined) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return null;
  }
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') {
    return null;
  }

  // "bytes=-500" means the LAST 500 bytes, not "from 0 to 500" - a
  // classic misreading, and one that silently serves the wrong part of
  // a file rather than failing.
  if (rawStart === '') {
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0) {
      return 'unsatisfiable';
    }
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) {
    return 'unsatisfiable';
  }
  // An end past the last byte is clamped, not rejected: browsers
  // routinely ask for more than exists (e.g. bytes=0-999999 on a small
  // file) and expect the server to simply return what it has.
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) {
    return 'unsatisfiable';
  }
  return { start, end };
}

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
  //
  // Cache-Control: immutable, a full year - safe unconditionally
  // because filenames are content-addressed (a hash of the file's own
  // bytes, see media/filename.ts): a given URL's content can never
  // change, so there is no invalidation case to ever design for here.
  // Accept-Ranges on every media response, not just ranged ones - it is
  // how a client learns ranges are available at all before asking.
  //
  // This matters far beyond scrubbing: Safari and iOS open a <video>
  // with "Range: bytes=0-1" and will refuse to play at all if answered
  // with a plain 200, so range support is what makes video work in
  // those browsers rather than an optimisation. It also lets
  // preload="metadata" fetch just the header instead of pulling the
  // whole file down to read a duration.
  //
  // Sliced from the already-buffered read rather than streamed: the
  // driver's own get() contract returns a whole Buffer (drivers/
  // driver.ts) and assets.ts documents reply.send(stream) returning an
  // empty body in this Fastify version, verified there with a minimal
  // repro. With uploads capped (10MB by default) the memory held per
  // request is bounded and no worse than this route's existing
  // behaviour, so slicing buys correct semantics without taking on
  // that risk or widening the driver interface a future object-storage
  // driver would have to satisfy.
  reply
    .header('X-Content-Type-Options', 'nosniff')
    .header('Access-Control-Allow-Origin', '*')
    .header('Cache-Control', 'public, max-age=31536000, immutable')
    .header('Accept-Ranges', 'bytes')
    .type(mimeTypeFor(relativePath));

  const range = resolveRange(request.headers.range, bytes.length);

  if (range === 'unsatisfiable') {
    // 416 carries its own required Content-Range naming the real size,
    // which is how a client corrects itself rather than retrying blind.
    reply.code(416).header('Content-Range', `bytes */${bytes.length}`).send();
    return;
  }

  if (range !== null) {
    const slice = bytes.subarray(range.start, range.end + 1);
    reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${bytes.length}`)
      .header('Content-Length', slice.length)
      .send(slice);
    return;
  }

  reply.send(bytes);
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
