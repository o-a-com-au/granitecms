import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

// The /v1 aggregator: buildServer registers this once with
// { prefix: '/v1' }, and every route-group plugin (capabilities.ts,
// and later content/drafts/publish/etc.) registers itself here with a
// bare, unprefixed path. Each route-group plugin is registered plainly
// (never wrapped in fastify-plugin's fp()), so it keeps its own
// encapsulation scope - required for Group B's auth preHandler hooks
// to gate only the routes that need them.
export const v1Routes: FastifyPluginAsync = async (_fastify: FastifyInstance) => {
  // Route-group plugins are registered here as they're built.
};
