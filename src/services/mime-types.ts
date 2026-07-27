import { extname } from 'node:path';

// A small hand-rolled lookup, not a dependency (@fastify/static would
// be the obvious ecosystem package, but this is a handful of lines and
// matches this codebase's existing minimal-dependency posture). Only
// the common web asset types - nothing here needs to be exhaustive.
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
};
export const DEFAULT_MIME_TYPE = 'application/octet-stream';

export function mimeTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? DEFAULT_MIME_TYPE;
}
