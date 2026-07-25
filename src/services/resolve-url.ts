import { existsSync } from 'node:fs';
import type { SiteConfig } from '../config.ts';
import { sanitisePath } from './path-safety.ts';
import { loadRedirects } from './redirects.ts';
import { urlToPagePath } from './urls.ts';

export type ResolvedUrl =
  | { kind: 'page'; relativePath: string }
  | { kind: 'redirect'; to: string }
  | { kind: 'not-found' };

// A redirect whose "from" matches a live page is never served: the
// page always wins (E6). Only consults redirects.json when no live
// page exists at the requested URL.
export function resolveUrl(config: SiteConfig, url: string): ResolvedUrl {
  const relativePath = urlToPagePath(url);
  const pageFile = sanitisePath(config.pagesRoot, relativePath);

  if (existsSync(pageFile)) {
    return { kind: 'page', relativePath };
  }

  const redirects = loadRedirects(config);
  const to = redirects[url];
  if (to !== undefined) {
    return { kind: 'redirect', to };
  }

  return { kind: 'not-found' };
}
