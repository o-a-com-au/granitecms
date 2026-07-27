import { existsSync } from 'node:fs';
import type { SiteConfig } from '../config.ts';
import { sanitisePath } from './path-safety.ts';
import { loadRedirects } from './redirects.ts';
import { urlToPostPath } from './post-urls.ts';

export type ResolvedBlogUrl =
  | { kind: 'post'; relativePath: string }
  | { kind: 'redirect'; to: string }
  | { kind: 'not-found' };

// Mirrors resolve-url.ts's shape exactly (a live post always wins over
// a redirect at the same URL), kept as its own distinct result type
// rather than reusing ResolvedUrl - clearer branching at the call site
// and avoids touching Group C's already-tested resolve-url.ts.
//
// Unlike pagesRoot (always expected to exist on a real site),
// postsRoot is optional - a site that has never used blog posts has
// no content/posts/ directory at all. sanitisePath calls realpathSync
// directly on its root argument, which throws a raw, uncaught ENOENT
// if that root itself is missing - so postsRoot's existence is checked
// first, before ever calling sanitisePath, rather than letting a
// perfectly ordinary "no posts yet" site crash on its first /blog/ hit.
export function resolveBlogUrl(config: SiteConfig, url: string): ResolvedBlogUrl {
  const relativePath = urlToPostPath(url);
  if (relativePath !== null && existsSync(config.postsRoot)) {
    const postFile = sanitisePath(config.postsRoot, relativePath);
    if (existsSync(postFile)) {
      return { kind: 'post', relativePath };
    }
  }

  const redirects = loadRedirects(config);
  const to = redirects[url];
  if (to !== undefined) {
    return { kind: 'redirect', to };
  }

  return { kind: 'not-found' };
}
