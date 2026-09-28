import { join } from 'node:path';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Liquid } from 'liquidjs';
import type { SiteConfig } from '../config.ts';
import { PageRenderError, renderPage } from '../renderer/render-page.ts';
import type { ThemeTemplates } from '../renderer/theme-templates.ts';
import type { ThemeState } from '../theme-state.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { requireScope } from '../services/token-auth.ts';
import { urlToPagePath } from '../services/urls.ts';
import type { TokenEntry } from '../server-config.ts';
import { resolveSiteSettings, resolveSiteSettingsFrom, type SiteSettings } from '../services/site-settings.ts';
import { validateSiteSettings, type ThemeSchemas } from '../services/validation.ts';

export interface PreviewRouteOptions {
  config: SiteConfig;
  theme: ThemeState;
  tokens: TokenEntry[];
}

// Same pagesRoot/contentRoot seam as public.ts - see that file's
// toRenderPath comment. Preview never consults redirects.json:
// redirects are a public-URL concept, and an editor previewing a
// specific page path isn't redirected.
function toRenderPath(pagesRelativePath: string): string {
  return join('pages', pagesRelativePath);
}

// ?settings=<JSON>: site settings an editor has changed in the admin but
// not saved, so the preview shows them before they go live. Never
// written anywhere. Values the theme's schema rejects (or that aren't
// JSON) are ignored and the saved settings used, the same as no query:
// a half-typed value must never break the preview.
function previewSiteSettings(query: unknown, config: SiteConfig, themeSchemas: ThemeSchemas): SiteSettings {
  const raw = (query as { settings?: unknown } | undefined)?.settings;
  if (typeof raw === 'string') {
    try {
      const given: unknown = JSON.parse(raw);
      if (validateSiteSettings(given, themeSchemas).valid) {
        return resolveSiteSettingsFrom(given as SiteSettings, themeSchemas);
      }
    } catch {
      // Not JSON: fall through to the saved settings.
    }
  }
  return resolveSiteSettings(config, themeSchemas);
}

async function handlePreviewRequest(
  request: FastifyRequest<{ Params: { '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
  themeTemplates: ThemeTemplates,
  layouts: Record<string, string>,
  engine: Liquid,
  themeSchemas: ThemeSchemas,
): Promise<void> {
  const url = `/${request.params['*']}`;

  try {
    const relativePath = urlToPagePath(url);
    const html = await renderPage(
      config,
      themeTemplates,
      layouts,
      engine,
      toRenderPath(relativePath),
      'preview',
      previewSiteSettings(request.query, config, themeSchemas),
    );
    reply.type('text/html; charset=utf-8').send(html);
  } catch (error) {
    if (error instanceof PathSafetyError) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No page at "${url}"` });
      return;
    }
    if (error instanceof PageRenderError && error.reason === 'page-not-found') {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No page at "${url}"` });
      return;
    }
    throw error;
  }
}

export const previewRoutes: FastifyPluginAsync<PreviewRouteOptions> = async (
  fastify: FastifyInstance,
  opts: PreviewRouteOptions,
) => {
  fastify.get(
    '/preview/*',
    { preHandler: requireScope(opts.tokens, 'content') },
    async (request, reply) =>
      handlePreviewRequest(
        request as FastifyRequest<{ Params: { '*': string } }>,
        reply,
        opts.config,
        opts.theme.current.themeTemplates,
        opts.theme.current.layouts,
        opts.theme.current.engine,
        opts.theme.current.themeSchemas,
      ),
  );
};
