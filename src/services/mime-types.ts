import { extname } from 'node:path';

// A small hand-rolled lookup, not a dependency (@fastify/static would
// be the obvious ecosystem package, but this is a handful of lines and
// matches this codebase's existing minimal-dependency posture). Only
// the common web asset types - nothing here needs to be exhaustive.
//
// Shared by both routes/assets.ts (theme CSS/JS/images/fonts) and
// routes/public.ts's theme/root/ mirror (robots.txt, .well-known/*,
// site-verification HTML files) via services/static-file.ts - the
// text/xml/html entries below exist specifically for that second,
// broader use case. Found live: robots.txt fell back to
// DEFAULT_MIME_TYPE (application/octet-stream), which every browser
// treats as "download this" rather than displaying it inline, even
// though the actual content is plain text.
export const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
};
export const DEFAULT_MIME_TYPE = 'application/octet-stream';

export function mimeTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? DEFAULT_MIME_TYPE;
}
