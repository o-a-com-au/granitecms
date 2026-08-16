import { join } from 'node:path';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Liquid } from 'liquidjs';
import type { SiteConfig } from '../config.ts';
import { PageRenderError, parsePageContent, renderLoadedPage } from '../renderer/render-page.ts';
import type { ThemeTemplates } from '../renderer/theme-templates.ts';
import { GitShowError, readFileAtRevision } from '../services/git-history.ts';
import { isValidGitRef } from '../services/git.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { isBlogUrl, urlToPostPath } from '../services/post-urls.ts';
import { requireScope } from '../services/token-auth.ts';
import { urlToPagePath } from '../services/urls.ts';
import type { TokenEntry } from '../server-config.ts';

export interface PreviewRevisionRouteOptions {
  config: SiteConfig;
  themeTemplates: ThemeTemplates;
  layouts: Record<string, string>;
  engine: Liquid;
  tokens: TokenEntry[];
}

// A dedicated top-level route rather than nesting under /preview/*
// (e.g. /preview/:ref/*): page URLs can be arbitrarily nested
// (E1 - content/pages/about/team.json resolves at /about/team), so a
// parametric+wildcard sibling registered under the same prefix as the
// existing bare /preview/* wildcard would make any multi-segment
// preview URL genuinely ambiguous between "page team under about" and
// "ref=about, page /team". Keeping this on its own /preview-revision
// prefix, a sibling of /preview rather than nested inside it, avoids
// that collision entirely - the same shape /git/show/:ref/* already
// uses alongside /preview/*.
//
// readFileAtRevision resolves paths relative to config.siteRoot, not
// config.contentRoot (confirmed by git-history.ts/git.test.ts's own
// "content/pages/about.json" usage) - so unlike preview.ts's
// toRenderPath/toPostsRenderPath (contentRoot-relative), the path
// built here is prefixed with "content/".
function toRevisionPath(pagesRelativePath: string): string {
  return join('content', 'pages', pagesRelativePath);
}

function toPostsRevisionPath(postsRelativePath: string): string {
  return join('content', 'posts', postsRelativePath);
}

async function handlePreviewRevisionRequest(
  request: FastifyRequest<{ Params: { ref: string; '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
  themeTemplates: ThemeTemplates,
  layouts: Record<string, string>,
  engine: Liquid,
): Promise<void> {
  const { ref } = request.params;
  const url = `/${request.params['*']}`;

  if (!isValidGitRef(ref)) {
    reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: `Invalid ref: "${ref}"` });
    return;
  }

  try {
    const isPost = isBlogUrl(url);
    let repoRelativePath: string;
    if (isPost) {
      const relativePath = urlToPostPath(url);
      if (relativePath === null) {
        reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No page at "${url}"` });
        return;
      }
      repoRelativePath = toPostsRevisionPath(relativePath);
    } else {
      repoRelativePath = toRevisionPath(urlToPagePath(url));
    }

    const raw = readFileAtRevision(config, ref, repoRelativePath);
    const page = parsePageContent(raw.toString('utf-8'));
    const html = await renderLoadedPage(page, config, themeTemplates, layouts, engine);
    reply.type('text/html; charset=utf-8').send(html);
  } catch (error) {
    if (error instanceof PathSafetyError) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No page at "${url}"` });
      return;
    }
    if (error instanceof GitShowError) {
      const code = error.reason === 'invalid-ref' ? 400 : 404;
      reply.code(code).send({
        statusCode: code,
        error: code === 400 ? 'Bad Request' : 'Not Found',
        message: error.message,
      });
      return;
    }
    if (error instanceof SyntaxError) {
      reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `No renderable page at "${url}" at revision "${ref}"`,
      });
      return;
    }
    if (error instanceof PageRenderError) {
      if (error.reason === 'page-not-found') {
        reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No page at "${url}"` });
        return;
      }
      // missing-section-type/missing-block-type/missing-layout/
      // template-error: a deliberate divergence from preview.ts and
      // public.ts, which let these reasons bubble to an uncaught 500.
      // For those routes, a broken theme/content combination reachable
      // today is genuinely an operational bug worth alerting on. Here,
      // "today's theme doesn't have a section type this old revision
      // used" is an expected, user-facing outcome (themes/layouts/menus
      // are never revision-pinned, only the page body is - see
      // render-page.ts's renderLoadedPage comment), not a bug - the
      // admin needs a stable 4xx it can catch and turn into "this
      // revision can't be previewed with the current theme" copy,
      // not a raw 500.
      reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: error.message,
        reason: error.reason,
      });
      return;
    }
    throw error;
  }
}

export const previewRevisionRoutes: FastifyPluginAsync<PreviewRevisionRouteOptions> = async (
  fastify: FastifyInstance,
  opts: PreviewRevisionRouteOptions,
) => {
  fastify.get(
    '/preview-revision/:ref/*',
    { preHandler: requireScope(opts.tokens, 'content') },
    async (request, reply) =>
      handlePreviewRevisionRequest(
        request as FastifyRequest<{ Params: { ref: string; '*': string } }>,
        reply,
        opts.config,
        opts.themeTemplates,
        opts.layouts,
        opts.engine,
      ),
  );
};
