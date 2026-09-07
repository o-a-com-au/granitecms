import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { rebuildIndex } from '../search/rebuild-index.ts';
import { queryFields, type FieldOp } from '../search/query-fields.ts';
import { WRITE_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';
import { requireScope } from '../services/token-auth.ts';
import type { TokenEntry } from '../server-config.ts';

export interface SearchRouteOptions {
  config: SiteConfig;
  tokens: TokenEntry[];
}

const FIELD_OPS: FieldOp[] = ['eq', 'gt', 'gte', 'lt', 'lte'];

interface QueryFieldsQuery {
  field?: string;
  op?: string;
  value?: string;
  pageType?: string;
}

function badRequest(reply: FastifyReply, message: string): void {
  reply.code(400).send({ statusCode: 400, error: 'Bad Request', message });
}

async function handleQueryFields(
  request: FastifyRequest<{ Querystring: QueryFieldsQuery }>,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  const { field, value, pageType } = request.query;
  const op = request.query.op ?? 'eq';

  if (!field) {
    badRequest(reply, 'field is required');
    return;
  }
  if (value === undefined) {
    badRequest(reply, 'value is required');
    return;
  }
  if (!FIELD_OPS.includes(op as FieldOp)) {
    badRequest(reply, `op must be one of: ${FIELD_OPS.join(', ')}`);
    return;
  }
  if (op !== 'eq' && !Number.isFinite(Number(value))) {
    badRequest(reply, `value must be numeric for op "${op}"`);
    return;
  }

  const results = queryFields(config.searchIndexPath, { fieldKey: field, op: op as FieldOp, value, pageType });
  reply.send(results);
}

export const searchRoutes: FastifyPluginAsync<SearchRouteOptions> = async (
  fastify: FastifyInstance,
  opts: SearchRouteOptions,
) => {
  fastify.post(
    '/search/rebuild',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (_request, reply) => {
      // rebuildIndex is already self-enqueue()d (search/rebuild-index.ts) -
      // never wrap it in a second enqueue() here, nested calls deadlock.
      await rebuildIndex(opts.config);
      reply.send({ ok: true });
    },
  );

  // Reads the index built above - a plain scoped read, same guard GET
  // /v1/content already uses (routes/content.ts), no rate limit (this
  // isn't a write).
  fastify.get(
    '/search/fields',
    { preHandler: requireScope(opts.tokens, 'content') },
    async (request, reply) =>
      handleQueryFields(request as FastifyRequest<{ Querystring: QueryFieldsQuery }>, reply, opts.config),
  );
};
