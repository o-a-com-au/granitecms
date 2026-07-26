import { join } from 'node:path';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { PageRenderError, renderPage } from '../renderer/render-page.ts';
import type { ThemeTemplates } from '../renderer/theme-templates.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { requireScope } from '../services/token-auth.ts';
import { urlToPagePath } from '../services/urls.ts';
import type { TokenEntry } from '../server-config.ts';

export interface PreviewRouteOptions {
  config: SiteConfig;
  themeTemplates: ThemeTemplates;
  tokens: TokenEntry[];
}

// Same pagesRoot/contentRoot seam as public.ts - see that file's
// toRenderPath comment. Preview never consults redirects.json:
// redirects are a public-URL concept, and an editor previewing a
// specific page path isn't redirected.
function toRenderPath(pagesRelativePath: string): string {
  return join('pages', pagesRelativePath);
}

async function handlePreviewRequest(
  request: FastifyRequest<{ Params: { '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
  themeTemplates: ThemeTemplates,
): Promise<void> {
  const url = `/${request.params['*']}`;
  const relativePath = urlToPagePath(url);

  try {
    const html = await renderPage(config, themeTemplates, toRenderPath(relativePath), 'preview');
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
        opts.themeTemplates,
      ),
  );
};
