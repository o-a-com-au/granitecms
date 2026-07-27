// Pure, filesystem-free mapping between a /blog/<slug> URL and a
// post's path relative to postsRoot. Unlike pages' arbitrary nested
// paths (about.json beside a sibling about/ directory), posts are
// flat only - a URL with more than one segment after /blog/ is never
// a valid post URL, enforced here rather than left to sanitisePath.

const BLOG_PREFIX = '/blog/';

// /blog is a permanently reserved namespace: both "/blog" itself (no
// slug) and every "/blog/..." URL are recognised here, so a caller can
// route the whole namespace to post resolution before ever checking
// for a page, matching the confirmed reserved-namespace decision.
export function isBlogUrl(url: string): boolean {
  return url === '/blog' || url.startsWith(BLOG_PREFIX);
}

export function urlToPostPath(url: string): string | null {
  if (!url.startsWith(BLOG_PREFIX)) {
    return null;
  }
  const slug = url.slice(BLOG_PREFIX.length);
  if (slug === '' || slug.includes('/')) {
    return null;
  }
  return `${slug}.json`;
}

export function postPathToUrl(relativePostPath: string): string {
  const withoutExtension = relativePostPath.replace(/\.json$/, '');
  return `${BLOG_PREFIX}${withoutExtension}`;
}
