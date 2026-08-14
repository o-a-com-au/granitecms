import { isAbsolute, join, resolve } from 'node:path';

// Single source of truth for the runtime/serving folder's name, reused
// by server-config.ts (site.config.json lives inside it) rather than a
// second hardcoded literal. A real vhost, in hosting terms (Apache/
// nginx/CyberPanel): the per-site serving configuration, not a
// multi-tenancy concept - this folder holds exactly that (package.json,
// server.js, site.config.json's access-control/serving parameters).
export const VHOST_DIR_NAME = 'vhost';

export interface SiteConfig {
  siteRoot: string;
  contentRoot: string;
  draftsRoot: string;
  themeRoot: string;
  assetsRoot: string;
  pagesRoot: string;
  postsRoot: string;
  menusRoot: string;
  redirectsPath: string;
  vhostRoot: string;
  dataRoot: string;
  searchIndexPath: string;
  // A sibling of contentRoot/themeRoot/vhostRoot, not nested under
  // contentRoot the way draftsRoot is - media is deliberately its own
  // top-level folder so its gitignored status (constraint 2) is a
  // single, unambiguous rule, not a partial exception carved out of a
  // folder every other line of this project describes as always
  // git-tracked. Don't "fix" this to match draftsRoot's nesting.
  mediaRoot: string;
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
  const themeRoot = join(normalisedRoot, 'theme');
  const vhostRoot = join(normalisedRoot, VHOST_DIR_NAME);
  const dataRoot = join(vhostRoot, 'data');

  return {
    siteRoot: normalisedRoot,
    contentRoot,
    // Nested inside contentRoot (content/drafts), not a sibling of it -
    // marketing-manager-managed content lives entirely under content/.
    // See content-read.ts/migration-runner.ts for the inclusion-based
    // walk fix this requires, and checkpoint.ts for the derived (not
    // hardcoded) pathspec fix.
    draftsRoot: join(contentRoot, 'drafts'),
    themeRoot,
    assetsRoot: join(themeRoot, 'assets'),
    pagesRoot: join(contentRoot, 'pages'),
    postsRoot: join(contentRoot, 'posts'),
    menusRoot: join(contentRoot, 'menus'),
    // Also nested inside contentRoot, for the same reason.
    redirectsPath: join(contentRoot, 'redirects.json'),
    vhostRoot,
    dataRoot,
    searchIndexPath: join(dataRoot, 'search-index.sqlite'),
    mediaRoot: join(normalisedRoot, 'media'),
  };
}
