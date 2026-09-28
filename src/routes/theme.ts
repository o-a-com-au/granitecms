import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { isValidCommitAuthor } from '../services/git.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { WRITE_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';
import {
  isValidThemePath,
  listThemeFiles,
  pushTheme,
  readThemeFile,
  ThemePushError,
  type ThemeDelete,
  type ThemeWrite,
} from '../services/theme-files.ts';
import { requireScope } from '../services/token-auth.ts';
import type { ThemeState } from '../theme-state.ts';
import type { TokenEntry } from '../server-config.ts';

export interface ThemeRouteOptions {
  config: SiteConfig;
  theme: ThemeState;
  tokens: TokenEntry[];
}

// A whole theme in one request, fonts and images included, sent as
// base64 - far past Fastify's 1 MB default, so this route sets its own.
const THEME_PUSH_BODY_LIMIT = 100 * 1024 * 1024;

interface ThemePushBody {
  writes: ThemeWrite[];
  deletes: ThemeDelete[];
  message: string;
  author: { name: string; email: string };
}

function parseThemePushBody(body: unknown): ThemePushBody | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { writes, deletes, message, author } = body as Record<string, unknown>;
  if (!Array.isArray(writes) || !Array.isArray(deletes) || typeof message !== 'string' || message === '') {
    return null;
  }
  if (!isValidCommitAuthor(author)) {
    return null;
  }
  const parsedWrites: ThemeWrite[] = [];
  for (const raw of writes as unknown[]) {
    const { path, content, expected } = (raw ?? {}) as Record<string, unknown>;
    if (typeof path !== 'string' || typeof content !== 'string' || (expected !== null && typeof expected !== 'string')) {
      return null;
    }
    parsedWrites.push({ path, bytes: Buffer.from(content, 'base64'), expected });
  }
  const parsedDeletes: ThemeDelete[] = [];
  for (const raw of deletes as unknown[]) {
    const { path, expected } = (raw ?? {}) as Record<string, unknown>;
    if (typeof path !== 'string' || typeof expected !== 'string') {
      return null;
    }
    parsedDeletes.push({ path, expected });
  }
  if (parsedWrites.length === 0 && parsedDeletes.length === 0) {
    return null;
  }
  return { writes: parsedWrites, deletes: parsedDeletes, message, author };
}

async function handleThemePush(request: FastifyRequest, reply: FastifyReply, opts: ThemeRouteOptions): Promise<void> {
  const parsed = parseThemePushBody(request.body);
  if (!parsed) {
    reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message:
        'Expected { writes: { path, content (base64), expected (hash or null) }[], deletes: { path, expected }[], message, author: { name, email } }, with at least one write or delete',
    });
    return;
  }
  try {
    const result = await pushTheme(opts.config, opts.theme, parsed.writes, parsed.deletes, parsed.message, parsed.author);
    reply.send({ ok: true, ...result });
  } catch (error) {
    if (error instanceof PathSafetyError || (error instanceof ThemePushError && error.reason === 'invalid-path')) {
      reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: error.message });
      return;
    }
    if (error instanceof ThemePushError && error.reason === 'invalid-liquid') {
      reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: error.message });
      return;
    }
    if (error instanceof ThemePushError && error.reason === 'conflict') {
      reply.code(409).send({ statusCode: 409, error: 'Conflict', message: error.message });
      return;
    }
    throw error;
  }
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
  fastify.get('/theme/schemas', { preHandler: requireScope(opts.tokens, 'content') }, async () => opts.theme.current.themeSchemas);

  // Group Q: lets the admin offer a template picker when creating a new
  // page. No dedicated "create from template" endpoint - pageTemplates
  // is already fully computed at boot (loadPageTemplates), same
  // verbatim read-only serialisation as /theme/schemas above; actually
  // creating a page from one is just the admin doing a normal
  // PUT /v1/drafts/* with the chosen template's own content as the body.
  fastify.get(
    '/theme/page-templates',
    { preHandler: requireScope(opts.tokens, 'content') },
    async () => ({ templates: opts.theme.current.pageTemplates }),
  );

  // The theme's own files, for npm run pull / push. All three need the
  // "theme" scope: a token that can only edit content can't read or
  // change the site's code.
  fastify.get('/theme/files', { preHandler: requireScope(opts.tokens, 'theme') }, async () => listThemeFiles(opts.config));

  fastify.get('/theme/files/*', { preHandler: requireScope(opts.tokens, 'theme') }, async (request, reply) => {
    const path = (request.params as { '*': string })['*'];
    let bytes: Buffer | null = null;
    try {
      bytes = isValidThemePath(path) ? readThemeFile(opts.config, path) : null;
    } catch (error) {
      if (!(error instanceof PathSafetyError)) {
        throw error;
      }
    }
    if (bytes === null) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No theme file at "${path}"` });
      return;
    }
    reply.type('application/octet-stream').send(bytes);
  });

  // Writes and deletes theme files as one commit, then switches the
  // running site to the new theme with no restart. Refused (409) if any
  // file changed on the site since the client last saw it, and (400) if
  // any Liquid template can't be parsed.
  fastify.post(
    '/theme/push',
    {
      preHandler: requireScope(opts.tokens, 'theme'),
      config: WRITE_ROUTE_RATE_LIMIT,
      bodyLimit: THEME_PUSH_BODY_LIMIT,
    },
    async (request, reply) => handleThemePush(request, reply, opts),
  );
};
