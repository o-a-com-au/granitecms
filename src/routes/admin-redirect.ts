import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { NO_AUTH_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';

export interface AdminRedirectRouteOptions {
  adminBaseUrl: string;
}

// Only ever registered by server.ts when serverConfig.adminBaseUrl is
// actually set - that's what makes this genuinely opt-in, not a
// reserved namespace like /media or /assets. A site that hasn't
// configured this can still use "admin" as an ordinary page path,
// same reasoning as GET /search.json over reserving all of /search.
//
// Redirects to adminBaseUrl with the requesting host appended as
// ?site=, never a deep link with a site ID baked in - keeps this
// agent completely decoupled from any particular admin app's own URL
// scheme, so a self-hoster running a different admin frontend just
// points adminBaseUrl at it. request.host (not request.hostname,
// which strips the port - same reasoning sitemap.ts already
// documents) so the admin side can match it directly against
// new URL(registeredSiteUrl).host.
//
// Deliberately unauthenticated: this is a discovery aid an operator
// (or anyone) can hit before they have a token, same class of
// zero-credential route as GET /v1/capabilities and GET /search.json.
export const adminRedirectRoutes: FastifyPluginAsync<AdminRedirectRouteOptions> = async (
  fastify: FastifyInstance,
  opts: AdminRedirectRouteOptions,
) => {
  fastify.get('/admin', { config: NO_AUTH_ROUTE_RATE_LIMIT }, async (request, reply) => {
    const target = new URL(opts.adminBaseUrl);
    target.searchParams.set('site', request.host);
    reply.code(302).header('location', target.toString()).send();
  });
};
