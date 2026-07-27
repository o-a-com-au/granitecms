import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { BootedSite } from './boot.ts';
import { bootSite } from './boot.ts';
import type { ServerConfig } from './server-config.ts';
import { loadServerConfig } from './server-config.ts';
import { v1Routes } from './routes/index.ts';
import { publicRoutes } from './routes/public.ts';

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
  const app = Fastify({ logger: options.logger ?? false });

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

  return app;
}

export async function startServer(
  siteRoot: string,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, options);
  await app.listen({ port: serverConfig.port });
  return app;
}
