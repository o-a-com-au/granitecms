import { isAbsolute, join, resolve } from 'node:path';

export interface SiteConfig {
  siteRoot: string;
  contentRoot: string;
  draftsRoot: string;
  themesRoot: string;
  pagesRoot: string;
  redirectsPath: string;
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

  return {
    siteRoot: normalisedRoot,
    contentRoot,
    draftsRoot: join(normalisedRoot, 'drafts'),
    themesRoot: join(normalisedRoot, 'themes'),
    pagesRoot: join(contentRoot, 'pages'),
    redirectsPath: join(normalisedRoot, 'redirects.json'),
  };
}
