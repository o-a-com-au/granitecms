import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteConfig } from '../config.ts';
import type { RenderMode } from '../renderer/render-page.ts';
import { listFilesRecursively } from './fs-walk.ts';

export interface MenuContent {
  items: Array<{ label: string; url: string }>;
}

function tryReadMenu(fullPath: string): MenuContent | null {
  try {
    const parsed = JSON.parse(readFileSync(fullPath, 'utf-8')) as { items?: unknown };
    if (!Array.isArray(parsed.items)) {
      return null;
    }
    return { items: parsed.items as MenuContent['items'] };
  } catch {
    // One malformed menu file is skipped individually, not fatal to
    // the whole render - a broken menu shouldn't take down every page
    // on the site (matches rebuild-index.ts's best-effort-skip
    // precedent for pages).
    return null;
  }
}

function loadMenusFrom(root: string): Record<string, MenuContent> {
  const menus: Record<string, MenuContent> = {};
  // listFilesRecursively already returns [] for a missing directory -
  // a site that has never used menus has no content/menus/ at all, and
  // that resolves to {} gracefully, no existsSync guard needed here.
  for (const relativePath of listFilesRecursively(root, root, '.json')) {
    const name = relativePath.replace(/\.json$/, '');
    const menu = tryReadMenu(join(root, relativePath));
    if (menu) {
      menus[name] = menu;
    }
  }
  return menus;
}

// Menus are content (git-tracked, draft/publish workflow), never
// theme data - loaded fresh on every render call, not once at boot
// like theme templates/layouts/snippets. In 'preview' mode, a draft
// menu overlays its live counterpart by name, mirroring render-page.ts's
// own draft-over-live pattern for pages, generalised from "one file"
// to "every file in a directory".
export function loadMenus(config: SiteConfig, mode: RenderMode): Record<string, MenuContent> {
  const menus = loadMenusFrom(config.menusRoot);

  if (mode === 'preview') {
    const draftMenus = loadMenusFrom(join(config.draftsRoot, 'menus'));
    Object.assign(menus, draftMenus);
  }

  return menus;
}
