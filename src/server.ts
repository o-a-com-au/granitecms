import rateLimitPlugin from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { BootedSite } from './boot.ts';
import { bootSite } from './boot.ts';
import type { ServerConfig } from './server-config.ts';
import { loadServerConfig } from './server-config.ts';
import { assetsRoutes } from './routes/assets.ts';
import { v1Routes } from './routes/index.ts';
import { mediaPublicRoutes } from './routes/media-public.ts';
import { publicRoutes } from './routes/public.ts';
import { CHECKPOINT_AUTHOR, runCheckpoint } from './services/checkpoint.ts';
import { startIntervalJob } from './services/interval-job.ts';

export interface BuildServerOptions {
  logger?: boolean;
}

// Never wrap v1Routes (or any route-group plugin it registers) with
// fastify-plugin (fp()): plain app.register() gives each file its own
// encapsulation scope by default, which Group B's auth preHandler
// hooks depend on. Wrapping would silently hoist decorators/hooks to
// the parent scope and break that later.
export function buildServer(
  booted: BootedSite,
  serverConfig: ServerConfig,
  options: BuildServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: serverConfig.trustProxy });

  // global: false - only routes that explicitly opt in via a
  // config: { rateLimit: {...} } marker on their own route options
  // (see src/services/rate-limit-config.ts) are ever limited. The
  // max/timeWindow set here are the configured (or defaulted)
  // site.config.json values - an opting-in route's own empty
  // { rateLimit: {} } marker inherits these, verified empirically.
  // Registered once here, on the root app (an ancestor of v1Routes and
  // everything it nests), so no individual route file needs to import
  // this plugin itself. Its own 429 response body shape
  // ({statusCode, error, message}) already matches this project's own
  // error-JSON convention exactly - verified empirically before relying
  // on it, no errorResponseBuilder override needed.
  app.register(rateLimitPlugin, {
    global: false,
    max: serverConfig.rateLimit.max,
    timeWindow: serverConfig.rateLimit.windowMs,
  });

  // Fastify's own default 500 body leaks the raw thrown Error.message
  // to the client verbatim - confirmed empirically before this was
  // written. Anything below 500 (e.g. a future route's schema-
  // validation failure) already carries a safe, specific message and
  // is passed through unchanged; only 500-and-above gets sanitised.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(error);
      reply.code(statusCode).send({
        statusCode,
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      });
      return;
    }
    reply.code(statusCode).send({ statusCode, error: error.name || 'Bad Request', message: error.message });
  });

  app.register(v1Routes, {
    prefix: '/v1',
    config: booted.config,
    themeSchemas: booted.themeSchemas,
    themeTemplates: booted.themeTemplates,
    layouts: booted.layouts,
    engine: booted.engine,
    tokens: serverConfig.tokens,
    ipAllowlist: serverConfig.ipAllowlist,
    maxUploadBytes: serverConfig.media.maxUploadBytes,
  });

  // Registered without a /v1 prefix, alongside v1Routes: this is the
  // site's own public website, not part of the site agent API. Order
  // relative to v1Routes is not load-bearing - Fastify's router
  // prefers exact/prefixed matches over this route's wildcard
  // regardless of registration order (verified empirically). What
  // actually protects unmatched /v1/* paths from being swallowed as
  // page lookups is the explicit guard inside publicRoutes itself.
  app.register(publicRoutes, {
    config: booted.config,
    themeTemplates: booted.themeTemplates,
    layouts: booted.layouts,
    engine: booted.engine,
  });

  // A more specific static-prefixed route than the public catch-all's
  // own /* wildcard - Fastify prefers it regardless of registration
  // order (verified empirically), so no guard is needed here the way
  // publicRoutes needs one against /v1/*.
  app.register(assetsRoutes, { config: booted.config });

  // Same "more specific than the public catch-all" reasoning as
  // assetsRoutes above. Deliberately not registered inside v1Routes
  // (media.ts's own authenticated /v1/media CRUD routes are what live
  // there) - this is the public, unauthenticated read side, matching
  // assetsRoutes/publicRoutes' own placement.
  //
  // @fastify/multipart itself is NOT registered here, only inside
  // media.ts's own plugin scope - see that file's comment for why
  // (confining it to media routes only, leaving every other route
  // file's default JSON body parsing untouched).
  app.register(mediaPublicRoutes, { config: booted.config });

  return app;
}

// Neither a recurring timer nor process signal handling exists
// anywhere else in this codebase - this is genuinely new machinery for
// the low-frequency draft-checkpoint background job (checklist H4).
// Wired only here, never in buildServer: every existing route test
// uses buildServer + .inject() directly and must stay completely
// unaffected by any of this.
export async function startServer(
  siteRoot: string,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, options);

  const doCheckpoint = () => runCheckpoint(booted.config, CHECKPOINT_AUTHOR);
  const scheduler = startIntervalJob(doCheckpoint, serverConfig.checkpointIntervalMs, (error) => {
    app.log.error(error, 'background draft checkpoint failed');
  });

  // Node's default action for an unhandled SIGTERM/SIGINT is immediate
  // process termination, bypassing all JS-level cleanup - without
  // this, a real kill/Ctrl-C would never run the final checkpoint
  // (build plan: "and on graceful shutdown"). process.once (not .on)
  // self-removes after firing, and is explicitly removed again inside
  // onClose below, so a test calling app.close() leaves zero global
  // process-level listeners behind across the many startServer/
  // buildServer calls the suite makes.
  const shutdown = (): void => {
    app.close().catch((error: unknown) => app.log.error(error, 'error during shutdown'));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  app.addHook('onClose', async () => {
    scheduler.stop();
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    try {
      await doCheckpoint();
    } catch (error) {
      app.log.error(error, 'final draft checkpoint on shutdown failed');
    }
  });

  // host: '0.0.0.0' - Fastify's own default binds 127.0.0.1 only,
  // which is unreachable from outside any container or remote host.
  await app.listen({ port: serverConfig.port, host: '0.0.0.0' });
  return app;
}
