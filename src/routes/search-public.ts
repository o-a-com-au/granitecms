import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { queryContent, type FieldFilter, type FieldOp, type SortParam } from '../search/query-content.ts';
import { NO_AUTH_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';

export interface SearchPublicRouteOptions {
  config: SiteConfig;
}

const FIELD_OPS: FieldOp[] = ['eq', 'gt', 'gte', 'lt', 'lte'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface SearchQuery {
  q?: string;
  pageType?: string;
  filter?: string | string[];
  sort?: string;
  limit?: string;
  offset?: string;
}

function badRequest(reply: FastifyReply, message: string): void {
  reply.code(400).send({ statusCode: 400, error: 'Bad Request', message });
}

// field:value (op implied "eq") or field:op:value. Split on the FIRST
// colon, then check whether the next segment up to a second colon is
// one of the known op words - a value that itself contains a colon
// (unlikely for the fields this targets, but not impossible) still
// parses correctly either way, since only a genuine, recognised op
// token is ever treated as one.
function parseFilter(raw: string): FieldFilter | undefined {
  const firstColon = raw.indexOf(':');
  if (firstColon <= 0) {
    return undefined;
  }
  const field = raw.slice(0, firstColon);
  const rest = raw.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  if (secondColon !== -1) {
    const maybeOp = rest.slice(0, secondColon);
    if (FIELD_OPS.includes(maybeOp as FieldOp)) {
      const value = rest.slice(secondColon + 1);
      return value === '' ? undefined : { field, op: maybeOp as FieldOp, value };
    }
  }
  return rest === '' ? undefined : { field, op: 'eq', value: rest };
}

function parseSort(raw: string): SortParam {
  return raw.startsWith('-') ? { field: raw.slice(1), direction: 'desc' } : { field: raw, direction: 'asc' };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

function parseOffset(raw: string | undefined): number {
  if (raw === undefined) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function handleSearch(
  request: FastifyRequest<{ Querystring: SearchQuery }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const { q, pageType, sort } = request.query;
  const rawFilters = request.query.filter;
  const filterStrings = rawFilters === undefined ? [] : Array.isArray(rawFilters) ? rawFilters : [rawFilters];

  const filters: FieldFilter[] = [];
  for (const raw of filterStrings) {
    const parsed = parseFilter(raw);
    if (!parsed) {
      badRequest(reply, `invalid filter "${raw}" - expected field:value or field:op:value`);
      return;
    }
    if (parsed.op !== 'eq' && !Number.isFinite(Number(parsed.value))) {
      badRequest(reply, `value must be numeric for op "${parsed.op}" (filter "${raw}")`);
      return;
    }
    filters.push(parsed);
  }

  const response = queryContent(config.searchIndexPath, {
    q,
    pageType,
    filters,
    sort: sort ? parseSort(sort) : undefined,
    limit: parseLimit(request.query.limit),
    offset: parseOffset(request.query.offset),
  });
  reply.send(response);
}

// The one public query surface - full-text (q), structured filters,
// sort, and pagination all in one endpoint (query-content.ts's own
// queryContent), rather than three narrow ones. Deliberately no
// requireScope, unlike every other route in this codebase: it's
// read-only and can only ever surface already-published data
// (rebuild-index.ts never indexes drafts or unpublished content), so
// there's nothing here a site visitor couldn't already see by
// browsing the live site directly - the whole point of this route is
// that a theme's own front-end JS can call it directly, which a
// token requirement would rule out entirely (a bearer token embedded
// in public client-side JS is not a secret - anyone's dev tools can
// read it straight back out, and this agent's tokens all carry real
// write scopes, not just search). NO_AUTH_ROUTE_RATE_LIMIT, the same
// defense-in-depth GET /v1/capabilities already has.
//
// GET /search.json, not GET /v1/search: this is a stable, public,
// front-end-facing contract, not part of the versioned admin/
// integration surface under /v1 - registered without a prefix in
// server.ts, alongside mediaPublicRoutes/assetsRoutes/sitemapRoutes.
// A single reserved path, not a whole prefix (unlike /media/* or
// /assets/*): a site's own content page can still live at the bare
// /search URL (see granite-starter/theme/sections/search-demo.liquid,
// which does exactly that) - only this one exact path is claimed.
export const searchPublicRoutes: FastifyPluginAsync<SearchPublicRouteOptions> = async (
  fastify: FastifyInstance,
  opts: SearchPublicRouteOptions,
) => {
  fastify.get(
    '/search.json',
    { config: NO_AUTH_ROUTE_RATE_LIMIT },
    async (request, reply) => handleSearch(request as FastifyRequest<{ Querystring: SearchQuery }>, reply, opts.config),
  );
};
