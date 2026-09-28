import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { isValidCommitAuthor } from '../services/git.ts';
import { WRITE_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';
import { readSiteSettings, resolveSiteSettings, SaveSiteSettingsError, saveSiteSettings } from '../services/site-settings.ts';
import { requireScope } from '../services/token-auth.ts';
import type { ThemeState } from '../theme-state.ts';
import type { TokenEntry } from '../server-config.ts';

export interface SettingsRouteOptions {
  config: SiteConfig;
  theme: ThemeState;
  tokens: TokenEntry[];
}

interface SaveSettingsBody {
  settings: unknown;
  message: string;
  author: { name: string; email: string };
}

function parseSaveSettingsBody(body: unknown): SaveSettingsBody | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { settings, message, author } = body as Record<string, unknown>;
  if (settings === undefined || typeof message !== 'string' || message === '' || !isValidCommitAuthor(author)) {
    return null;
  }
  return { settings, message, author };
}

// GET: everything the admin needs to build the Site Settings form - the
// theme's schema (null when it defines no settings), the values saved so
// far, what templates actually see (saved values, defaults filling the
// rest), and the ETag a save must present.
async function handleGetSettings(reply: FastifyReply, opts: SettingsRouteOptions): Promise<void> {
  const { themeSchemas } = opts.theme.current;
  const stored = readSiteSettings(opts.config);
  if (stored.etag !== null) {
    reply.header('etag', stored.etag);
  }
  reply.send({
    schema: themeSchemas.settings ?? null,
    settings: stored.settings,
    resolved: resolveSiteSettings(opts.config, themeSchemas),
  });
}

// PUT: saves and commits at once, like a menu - no draft state. If-Match
// is required; "*" (or anything) is accepted while no settings file
// exists yet.
async function handleSaveSettings(request: FastifyRequest, reply: FastifyReply, opts: SettingsRouteOptions): Promise<void> {
  const ifMatch = request.headers['if-match'];
  if (typeof ifMatch !== 'string' || ifMatch.length === 0) {
    reply.code(428).send({ statusCode: 428, error: 'Precondition Required', message: 'An If-Match header is required to save site settings' });
    return;
  }
  const parsed = parseSaveSettingsBody(request.body);
  if (!parsed) {
    reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Expected { settings: object, message: string, author: { name, email } }',
    });
    return;
  }
  try {
    const etag = await saveSiteSettings(opts.config, opts.theme.current.themeSchemas, parsed.settings, ifMatch, parsed.message, parsed.author);
    reply.header('etag', etag).send({ ok: true });
  } catch (error) {
    if (error instanceof SaveSiteSettingsError && error.reason === 'conflict') {
      reply.code(409).send({ statusCode: 409, error: 'Conflict', message: error.message });
      return;
    }
    if (error instanceof SaveSiteSettingsError && error.reason === 'validation-failed') {
      reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: error.message, errors: error.errors });
      return;
    }
    throw error;
  }
}

export const settingsRoutes: FastifyPluginAsync<SettingsRouteOptions> = async (
  fastify: FastifyInstance,
  opts: SettingsRouteOptions,
) => {
  fastify.get('/settings', { preHandler: requireScope(opts.tokens, 'content') }, async (_request, reply) =>
    handleGetSettings(reply, opts),
  );
  fastify.put(
    '/settings',
    { preHandler: requireScope(opts.tokens, 'content'), config: WRITE_ROUTE_RATE_LIMIT },
    async (request, reply) => handleSaveSettings(request, reply, opts),
  );
};
