import { join } from 'node:path';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Liquid } from 'liquidjs';
import type { SiteConfig } from '../config.ts';
import { PageRenderError, renderPage } from '../renderer/render-page.ts';
import type { ThemeTemplates } from '../renderer/theme-templates.ts';
import { PathSafetyError } from '../services/path-safety.ts';
import { isBlogUrl } from '../services/post-urls.ts';
import { resolveBlogUrl } from '../services/resolve-blog-url.ts';
import { resolveUrl } from '../services/resolve-url.ts';

export interface PublicRouteOptions {
  config: SiteConfig;
  themeTemplates: ThemeTemplates;
  layouts: Record<string, string>;
  engine: Liquid;
}

// resolveUrl's relativePath is relative to pagesRoot (e.g. "about.json"),
// but renderPage's relativePath is relative to contentRoot/draftsRoot
// directly (e.g. "pages/about.json") - two already-correct modules with
// two different conventions for the same string. This is the seam
// between them, not an arbitrary literal.
function toRenderPath(pagesRelativePath: string): string {
  return join('pages', pagesRelativePath);
}

// Same seam as toRenderPath above, for posts: resolveBlogUrl's
// relativePath is relative to postsRoot, renderPage's is relative to
// contentRoot/draftsRoot directly.
function toPostsRenderPath(postsRelativePath: string): string {
  return join('posts', postsRelativePath);
}

// A themed 404: content/pages/404.json, if it exists and is published,
// is rendered through the ordinary public renderPage pipeline (layout +
// sections + blocks, same as any other page) - no special-casing in
// render-page.ts itself, no separate "is this the 404 page" concept.
// The HTTP status is always 404 regardless, even though the body is a
// full HTML page. Any failure at all while attempting this - no
// 404.json, it's unpublished, or its own theme is broken - falls back
// to today's plain JSON error rather than ever turning a 404 into a
// 500 for a visitor who was already looking at a missing page.
async function sendNotFound(
  reply: FastifyReply,
  config: SiteConfig,
  themeTemplates: ThemeTemplates,
  layouts: Record<string, string>,
  engine: Liquid,
  url: string,
): Promise<void> {
  try {
    const html = await renderPage(config, themeTemplates, layouts, engine, toRenderPath('404.json'), 'public');
    reply.code(404).type('text/html; charset=utf-8').send(html);
  } catch {
    reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `No page at "${url}"` });
  }
}

async function handlePublicRequest(
  request: FastifyRequest<{ Params: { '*': string } }>,
  reply: FastifyReply,
  config: SiteConfig,
  themeTemplates: ThemeTemplates,
  layouts: Record<string, string>,
  engine: Liquid,
): Promise<void> {
  // The public catch-all is registered without a /v1 prefix alongside
  // v1Routes (which has its own exact/prefixed routes). Fastify's
  // router already prefers exact matches over this wildcard regardless
  // of registration order, but an *unmatched* /v1/* path would
  // otherwise fall through to here and get treated as a page lookup
  // instead of Fastify's real 404 - this guard is what actually keeps
  // A4 true for any future typo'd or removed /v1/* route, not
  // registration order.
  if (request.url === '/v1' || request.url.startsWith('/v1/')) {
    return reply.callNotFound();
  }

  const url = `/${request.params['*']}`;

  try {
    // /blog is a permanently reserved namespace (confirmed design
    // decision): checked first, and never falls through to page
    // resolution even on a miss - a page manually placed at
    // content/pages/blog/x.json is deliberately unreachable.
    if (isBlogUrl(url)) {
      const resolved = resolveBlogUrl(config, url);

      if (resolved.kind === 'not-found') {
        await sendNotFound(reply, config, themeTemplates, layouts, engine, url);
        return;
      }

      if (resolved.kind === 'redirect') {
        reply.code(301).header('location', resolved.to).send();
        return;
      }

      const html = await renderPage(
        config,
        themeTemplates,
        layouts,
        engine,
        toPostsRenderPath(resolved.relativePath),
        'public',
      );
      reply.type('text/html; charset=utf-8').send(html);
      return;
    }

    const resolved = resolveUrl(config, url);

    if (resolved.kind === 'not-found') {
      await sendNotFound(reply, config, themeTemplates, layouts, engine, url);
      return;
    }

    if (resolved.kind === 'redirect') {
      reply.code(301).header('location', resolved.to).send();
      return;
    }

    const html = await renderPage(
      config,
      themeTemplates,
      layouts,
      engine,
      toRenderPath(resolved.relativePath),
      'public',
    );
    reply.type('text/html; charset=utf-8').send(html);
  } catch (error) {
    // A traversal attempt and an ordinary miss get the identical 404 -
    // deliberately not 400, so a public, unauthenticated route never
    // gives an attacker a signal that distinguishes the two.
    if (error instanceof PathSafetyError) {
      await sendNotFound(reply, config, themeTemplates, layouts, engine, url);
      return;
    }
    if (error instanceof PageRenderError && error.reason === 'page-not-found') {
      await sendNotFound(reply, config, themeTemplates, layouts, engine, url);
      return;
    }
    // Any other PageRenderError reason (missing-section-type,
    // missing-block-type, template-error) is a broken theme/content
    // problem, not something to explain to a public visitor - rethrow
    // and let the global error handler sanitise it as a 500 (A5).
    throw error;
  }
}

export const publicRoutes: FastifyPluginAsync<PublicRouteOptions> = async (
  fastify: FastifyInstance,
  opts: PublicRouteOptions,
) => {
  fastify.get('/*', async (request, reply) =>
    handlePublicRequest(
      request as FastifyRequest<{ Params: { '*': string } }>,
      reply,
      opts.config,
      opts.themeTemplates,
      opts.layouts,
      opts.engine,
    ),
  );
};
