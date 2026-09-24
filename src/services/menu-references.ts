import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { listFilesRecursively } from './fs-walk.ts';

// A menu's handle is its filename without .json - what a layout writes
// as menus.<handle>.items. Menus are flat (no subfolders), and these
// are the only characters a Liquid dot-lookup reads as one name.
const MENU_HANDLE = /^[A-Za-z0-9_-]+$/;

export function isValidMenuHandle(handle: string): boolean {
  return MENU_HANDLE.test(handle);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Which theme files mention a menu by handle, as site-relative paths
// (e.g. "theme/layouts/theme.liquid"). Read-only and advisory: it lets
// the admin warn before a rename or delete leaves a nav empty. Matches
// both menus.<handle> and menus['<handle>'] / menus["<handle>"], and
// the dot form only as a whole name, so "main" never matches
// menus.mainFooter. A handle built at runtime ({% assign m = ... %})
// can't be seen here, which is why this only ever informs a warning,
// never blocks anything.
export function findMenuReferences(config: SiteConfig, handle: string): string[] {
  if (!isValidMenuHandle(handle)) {
    return [];
  }
  const escaped = escapeRegExp(handle);
  const pattern = new RegExp(`menus(?:\\.${escaped}(?![A-Za-z0-9_-])|\\[\\s*(['"])${escaped}\\1\\s*\\])`);

  return listFilesRecursively(config.themeRoot, config.siteRoot, '.liquid')
    .filter((relativePath) => {
      try {
        return pattern.test(readFileSync(join(config.siteRoot, relativePath), 'utf-8'));
      } catch {
        return false;
      }
    })
    .sort();
}
