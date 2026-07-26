import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { SiteConfig } from '../config.ts';
import type { ThemeTemplates } from '../renderer/theme-templates.ts';
import type { TokenEntry } from '../server-config.ts';
import type { ThemeSchemas } from '../services/validation.ts';
import { capabilitiesRoutes } from './capabilities.ts';
import { contentRoutes } from './content.ts';
import { draftsRoutes } from './drafts.ts';
import { previewRoutes } from './preview.ts';
import { publishRoutes } from './publish.ts';

export interface V1RouteOptions {
  config: SiteConfig;
  themeSchemas: ThemeSchemas;
  themeTemplates: ThemeTemplates;
  tokens: TokenEntry[];
}

// The /v1 aggregator: buildServer registers this once with
// { prefix: '/v1', ...V1RouteOptions }, and every route-group plugin
// (capabilities.ts, preview.ts, and later content/drafts/publish/etc.)
// registers itself here with a bare, unprefixed path. Each route-group
// plugin is registered plainly (never wrapped in fastify-plugin's
// fp()), so it keeps its own encapsulation scope - required for Group
// B's auth preHandler hooks to gate only the routes that need them.
// Plugins that don't need site data (capabilities.ts) simply ignore
// the passed-through opts.
export const v1Routes: FastifyPluginAsync<V1RouteOptions> = async (
  fastify: FastifyInstance,
  opts: V1RouteOptions,
) => {
  fastify.register(capabilitiesRoutes);

  // Fastify passes the *entire* options object a plugin was registered
  // with - including `prefix` - through as this plugin's own second
  // argument. Passing `opts` straight through to a nested register()
  // call would carry that `prefix: '/v1'` along with it, double-
  // applying the prefix (confirmed empirically: routes ended up
  // registered at /v1/v1/preview/*). Re-pack only the site-data
  // fields, never `opts` itself, for any nested plugin registration.
  fastify.register(previewRoutes, {
    config: opts.config,
    themeTemplates: opts.themeTemplates,
    tokens: opts.tokens,
  });

  // contentRoutes needs no themeTemplates (it never renders anything),
  // so it gets its own narrower options shape rather than the full
  // bundle out of convenience - matching capabilities.ts's precedent
  // of registering with only what it actually uses.
  fastify.register(contentRoutes, { config: opts.config, tokens: opts.tokens });
  fastify.register(draftsRoutes, {
    config: opts.config,
    themeSchemas: opts.themeSchemas,
    tokens: opts.tokens,
  });
  fastify.register(publishRoutes, {
    config: opts.config,
    themeSchemas: opts.themeSchemas,
    tokens: opts.tokens,
  });
};
