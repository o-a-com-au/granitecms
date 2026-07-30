import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { requireScope } from '../services/token-auth.ts';
import type { ThemeSchemas } from '../services/validation.ts';
import type { TokenEntry } from '../server-config.ts';

export interface ThemeRouteOptions {
  themeSchemas: ThemeSchemas;
  tokens: TokenEntry[];
}

// Group I: the only place a caller can learn what section/block types
// the active theme supports and what settings each one accepts - the
// admin needs this to build a schema-driven editing UI instead of a
// hardcoded one. themeSchemas is already fully computed at boot
// (loadThemeSchemas) purely for internal write-time validation; this
// route just serialises the same object out, verbatim, read-only.
export const themeRoutes: FastifyPluginAsync<ThemeRouteOptions> = async (
  fastify: FastifyInstance,
  opts: ThemeRouteOptions,
) => {
  fastify.get('/theme/schemas', { preHandler: requireScope(opts.tokens, 'content') }, async () => opts.themeSchemas);
};
