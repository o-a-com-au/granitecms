import { isAbsolute, join, resolve } from 'node:path';

export interface SiteConfig {
  siteRoot: string;
  contentRoot: string;
  draftsRoot: string;
  themeRoot: string;
  assetsRoot: string;
  pagesRoot: string;
  redirectsPath: string;
  dataRoot: string;
  searchIndexPath: string;
}

// Pure path derivation, no fs calls. siteRoot must be supplied by the
// caller (agent configuration) and must already be absolute: the agent
// never assumes it lives inside the site repo, and never falls back to
// resolving against its own module location or process.cwd().
export function loadSiteConfig(siteRoot: string): SiteConfig {
  if (!isAbsolute(siteRoot)) {
    throw new Error(`siteRoot must be an absolute path, got "${siteRoot}"`);
  }

  const normalisedRoot = resolve(siteRoot);

  const contentRoot = join(normalisedRoot, 'content');
  const dataRoot = join(normalisedRoot, 'data');
  const themeRoot = join(normalisedRoot, 'theme');

  return {
    siteRoot: normalisedRoot,
    contentRoot,
    draftsRoot: join(normalisedRoot, 'drafts'),
    themeRoot,
    assetsRoot: join(themeRoot, 'assets'),
    pagesRoot: join(contentRoot, 'pages'),
    redirectsPath: join(normalisedRoot, 'redirects.json'),
    dataRoot,
    searchIndexPath: join(dataRoot, 'search-index.sqlite'),
  };
}
