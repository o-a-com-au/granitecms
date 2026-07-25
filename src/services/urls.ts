// Pure, filesystem-free mapping between a public URL and a page's path
// relative to pagesRoot. A page with children is a file (about.json)
// sitting alongside a same-named sibling directory (about/) holding
// descendants, so this mapping never needs to know whether a given
// page currently has children - unlike an about/index.json convention,
// which would make resolution filesystem-dependent.

export function urlToPagePath(url: string): string {
  const trimmed = url.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') {
    return 'index.json';
  }
  return `${trimmed}.json`;
}

export function pagePathToUrl(relativePagePath: string): string {
  const withoutExtension = relativePagePath.replace(/\.json$/, '');
  if (withoutExtension === 'index') {
    return '/';
  }
  return `/${withoutExtension}`;
}
