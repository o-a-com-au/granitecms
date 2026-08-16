import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Liquid } from 'liquidjs';
import type { SiteConfig } from '../config.ts';
import type { ThemeTemplates } from '../renderer/theme-templates.ts';
import type { TokenEntry } from '../server-config.ts';
import type { ThemeSchemas } from '../services/validation.ts';
import { batchRoutes } from './batch.ts';
import { capabilitiesRoutes } from './capabilities.ts';
import { contentRoutes } from './content.ts';
import { draftsRoutes } from './drafts.ts';
import { gitRoutes } from './git.ts';
import { mediaRoutes } from './media.ts';
import { menusRoutes } from './menus.ts';
import { previewRevisionRoutes } from './preview-revision.ts';
import { previewRoutes } from './preview.ts';
import { publishRoutes } from './publish.ts';
import { redirectsRoutes } from './redirects.ts';
import { searchRoutes } from './search.ts';
import { themeRoutes } from './theme.ts';
import { ipAllowlistGuard } from '../services/ip-allowlist.ts';

export interface V1RouteOptions {
  config: SiteConfig;
  themeSchemas: ThemeSchemas;
  themeTemplates: ThemeTemplates;
  layouts: Record<string, string>;
  engine: Liquid;
  tokens: TokenEntry[];
  ipAllowlist: string[];
  maxUploadBytes: number;
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
  // A coarse "is this client's network address allowed to talk to the
  // API at all" gate, applied to the entire /v1 surface uniformly
  // (including capabilities.ts and every GET route) - orthogonal to
  // requireScope's per-route, per-scope exemptions. Added on this
  // fastify instance (v1Routes's own parameter, never wrapped in fp())
  // before any nested register() call, so it cascades to every plugin
  // registered as a child below but never to publicRoutes/assetsRoutes
  // (siblings registered directly on the root app, outside this
  // encapsulation context) - verified with a real request, not just
  // asserted.
  fastify.addHook('onRequest', ipAllowlistGuard(opts.ipAllowlist));

  fastify.register(capabilitiesRoutes, { maxUploadBytes: opts.maxUploadBytes });

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
    layouts: opts.layouts,
    engine: opts.engine,
    tokens: opts.tokens,
  });
  fastify.register(previewRevisionRoutes, {
    config: opts.config,
    themeTemplates: opts.themeTemplates,
    layouts: opts.layouts,
    engine: opts.engine,
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
  fastify.register(batchRoutes, {
    config: opts.config,
    themeSchemas: opts.themeSchemas,
    tokens: opts.tokens,
  });
  fastify.register(gitRoutes, { config: opts.config, tokens: opts.tokens });
  fastify.register(mediaRoutes, { config: opts.config, tokens: opts.tokens, maxUploadBytes: opts.maxUploadBytes });
  fastify.register(searchRoutes, { config: opts.config, tokens: opts.tokens });
  fastify.register(redirectsRoutes, { config: opts.config, tokens: opts.tokens });
  fastify.register(menusRoutes, { config: opts.config, tokens: opts.tokens });
  fastify.register(themeRoutes, { themeSchemas: opts.themeSchemas, tokens: opts.tokens });
};
