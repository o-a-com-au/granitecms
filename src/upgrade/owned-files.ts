import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface OwnedFileResult {
  // Relative to the site root, e.g. "vhost/Dockerfile".
  path: string;
  status: 'updated' | 'created' | 'unchanged';
}

export interface OwnedFilesSource {
  // The scaffold template of the version now installed.
  templateRoot: string;
  serverJs: string;
  scripts: Record<string, string>;
}

function place(siteRoot: string, path: string, contents: string, mode?: number): OwnedFileResult {
  const full = join(siteRoot, path);
  const before = existsSync(full) ? readFileSync(full, 'utf-8') : null;
  if (before === contents) {
    return { path, status: 'unchanged' };
  }
  writeFileSync(full, contents);
  if (mode !== undefined) {
    chmodSync(full, mode);
  }
  return { path, status: before === null ? 'created' : 'updated' };
}

// The files in a site that belong to the CMS rather than to the site,
// put back exactly as the installed version ships them - so an upgrade
// brings its own Dockerfile, start-up script and scripts along, instead
// of every release needing them copied in by hand. vhost/package.json is
// merged, not replaced: the CMS's own scripts are set, the dependency is
// left as installed, and any scripts the developer added are kept.
// Nothing outside this list is ever touched: not the theme, content,
// site.config.json (tokens), or AGENTS.md.
export function refreshOwnedFiles(siteRoot: string, source: OwnedFilesSource): OwnedFileResult[] {
  const read = (path: string) => readFileSync(join(source.templateRoot, path), 'utf-8');
  const results = [
    place(siteRoot, 'vhost/Dockerfile', read('vhost/Dockerfile')),
    place(siteRoot, 'vhost/docker-entrypoint.sh', read('vhost/docker-entrypoint.sh'), 0o755),
    place(siteRoot, 'vhost/server.js', source.serverJs),
    place(siteRoot, '.dockerignore', read('dockerignore')),
  ];

  const packagePath = join(siteRoot, 'vhost', 'package.json');
  const raw = readFileSync(packagePath, 'utf-8');
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  const theirs = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([name]) => !(name in source.scripts)));
  pkg.scripts = { ...source.scripts, ...theirs };
  results.push(place(siteRoot, 'vhost/package.json', `${JSON.stringify(pkg, null, 2)}\n`));
  return results;
}
