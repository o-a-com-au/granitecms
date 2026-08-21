import { join } from 'node:path';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { SiteConfig } from '../config.ts';
import { readContentFile } from '../services/content-read.ts';
import { listFilesRecursively } from '../services/fs-walk.ts';
import { postPathToUrl } from '../services/post-urls.ts';
import { pagePathToUrl } from '../services/urls.ts';

export interface SitemapRouteOptions {
  config: SiteConfig;
}

interface PublishedShape {
  published?: unknown;
}

// Reads through readContentFile/listFilesRecursively (both already
// gated behind sanitisePath/agent-configured roots - see their own
// files) rather than touching fs directly, so this route needs no
// allowlist entry of its own (docs/phase-1-checklist.md Group B).
function isPublished(contentRoot: string, subdir: 'pages' | 'posts', relativePath: string): boolean {
  try {
    const { bytes } = readContentFile(contentRoot, join(subdir, relativePath));
    const parsed = JSON.parse(bytes.toString('utf-8')) as PublishedShape;
    return parsed.published === true;
  } catch {
    // Unreadable, malformed, or vanished between listing and reading -
    // never worth failing the whole sitemap over one bad entry.
    return false;
  }
}

// Generated fresh on every request, never a saved file - matches this
// project's own standing philosophy for exactly this class of problem
// (the search index is explicitly "a derived, disposable index...
// never authoritative", see cms-build-plan.md). A saved sitemap would
// go stale the moment anything is published or unpublished; this
// can't.
function buildSitemapUrls(config: SiteConfig): string[] {
  const urls: string[] = [];

  for (const relativePath of listFilesRecursively(config.pagesRoot, config.pagesRoot, '.json')) {
    // The 404 page must never be listed as a real crawlable URL,
    // regardless of its own published flag - it's a fallback
    // convention (docs/content-authoring-guide.md), not real content.
    if (relativePath === '404.json') {
      continue;
    }
    if (isPublished(config.contentRoot, 'pages', relativePath)) {
      urls.push(pagePathToUrl(relativePath));
    }
  }

  for (const relativePath of listFilesRecursively(config.postsRoot, config.postsRoot, '.json')) {
    if (isPublished(config.contentRoot, 'posts', relativePath)) {
      urls.push(postPathToUrl(relativePath));
    }
  }

  return urls;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function handleSitemapRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  config: SiteConfig,
): Promise<void> {
  // request.protocol/request.host already respect trustProxy (wired
  // natively into the Fastify() constructor, server.ts) - no separate
  // config field needed for this. request.host, not request.hostname:
  // the latter unconditionally strips the port (confirmed against
  // Fastify's own source), which silently produces a wrong origin for
  // any site not on a standard 80/443 port - request.host is the raw
  // Host header (or the trustProxy-forwarded equivalent), port
  // included when present.
  const origin = `${request.protocol}://${request.host}`;
  const urls = buildSitemapUrls(config);

  const entries = urls.map((url) => `  <url><loc>${escapeXml(origin + url)}</loc></url>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;

  reply.type('application/xml; charset=utf-8').send(xml);
}

// Deliberately and permanently unauthenticated, same reasoning as
// assetsRoutes/mediaPublicRoutes: a sitemap must be fetchable by any
// crawler without a token. This exact path always wins over a
// same-named static file at theme/root/sitemap.xml, if a developer
// ever creates one - a dynamic route is a more specific match than
// the root-mirror check inside publicRoutes' own catch-all.
export const sitemapRoutes: FastifyPluginAsync<SitemapRouteOptions> = async (
  fastify: FastifyInstance,
  opts: SitemapRouteOptions,
) => {
  fastify.get('/sitemap.xml', async (request, reply) => handleSitemapRequest(request, reply, opts.config));
};
