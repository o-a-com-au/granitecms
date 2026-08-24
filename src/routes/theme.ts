import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { requireScope } from '../services/token-auth.ts';
import type { ThemeSchemas } from '../services/validation.ts';
import type { PageTemplate } from '../services/theme-page-templates.ts';
import type { TokenEntry } from '../server-config.ts';

export interface ThemeRouteOptions {
  themeSchemas: ThemeSchemas;
  pageTemplates: PageTemplate[];
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

  // Group Q: lets the admin offer a template picker when creating a new
  // page. No dedicated "create from template" endpoint - pageTemplates
  // is already fully computed at boot (loadPageTemplates), same
  // verbatim read-only serialisation as /theme/schemas above; actually
  // creating a page from one is just the admin doing a normal
  // PUT /v1/drafts/* with the chosen template's own content as the body.
  fastify.get(
    '/theme/page-templates',
    { preHandler: requireScope(opts.tokens, 'content') },
    async () => ({ templates: opts.pageTemplates }),
  );
};
