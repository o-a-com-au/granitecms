import { existsSync, readFileSync } from 'node:fs';
import type { SiteConfig } from '../config.ts';
import { listFilesRecursively } from './fs-walk.ts';
import { sanitisePath } from './path-safety.ts';
import { siteSettingsPath } from './site-settings.ts';
import { pagePathToUrl } from './urls.ts';

// Internal links: where content points at the site's own pages, found
// and rewritten without the theme's schemas. A link is any text value
// that is wholly a site path ("/about", "/about#team") - what a link
// field, a menu item or a setting stores - and any href="..." inside a
// longer text value, which is how rich text stores one. Keeping links
// as plain paths was the owner's choice over permanent page IDs, so
// content stays readable; this is what keeps those paths correct.

// The page a link points at: its path without ?query or #fragment, and
// without a trailing slash (except the home page's "/"). null for
// anything that isn't a link to a page here - an external address,
// mailto:/tel:, a bare #anchor, protocol-relative //host, a media or
// theme asset, or a file such as /robots.txt.
export function linkTarget(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || /\s/.test(trimmed)) {
    return null;
  }
  const path = trimmed.replace(/[?#].*$/, '');
  if (path.startsWith('/media/') || path.startsWith('/assets/') || /\.[A-Za-z0-9]+$/.test(path)) {
    return null;
  }
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

const HREF = /(href\s*=\s*)(["'])(.*?)\2/gi;

// Every link in a piece of content, as written (not yet reduced to a
// target), in document order.
export function collectLinks(value: unknown): string[] {
  const links: string[] = [];
  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      if (linkTarget(node) !== null) {
        links.push(node);
      } else if (node.includes('href')) {
        for (const match of node.matchAll(HREF)) {
          links.push(match[3] as string);
        }
      }
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node !== null && typeof node === 'object') {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return links;
}

// A link moved from one page path to another: the page itself, or
// anything under it (a child page), keeping whatever followed the path
// (?query, #fragment, a trailing slash). null when the link isn't to a
// moved page.
function moveLink(href: string, from: string, to: string): string | null {
  const target = linkTarget(href);
  if (target === null || (target !== from && !target.startsWith(`${from}/`))) {
    return null;
  }
  const leading = href.length - href.trimStart().length;
  const start = href.indexOf(target, leading);
  return href.slice(0, start) + to + href.slice(start + from.length);
}

// A copy of some content with every link to `from` (or a page under it)
// pointing at `to` instead, and whether anything changed.
export function rewriteLinks(value: unknown, from: string, to: string): { value: unknown; changed: boolean } {
  let changed = false;
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const moved = moveLink(node, from, to);
      if (moved !== null) {
        changed = true;
        return moved;
      }
      if (!node.includes('href')) {
        return node;
      }
      return node.replace(HREF, (whole, prefix: string, quote: string, href: string) => {
        const next = moveLink(href, from, to);
        if (next === null) {
          return whole;
        }
        changed = true;
        return `${prefix}${quote}${next}${quote}`;
      });
    }
    if (Array.isArray(node)) {
      return node.map(visit);
    }
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
    }
    return node;
  };
  const next = visit(value);
  return { value: next, changed };
}

export type LinkSourceKind = 'page' | 'draft' | 'menu' | 'settings';

// One content file that can hold links: where it is on disk, and how to
// describe it to an editor.
export interface LinkSource {
  kind: LinkSourceKind;
  // Content-relative ("pages/about.json", "drafts/pages/about.json",
  // "menus/main.json", "settings.json").
  path: string;
  file: string;
}

// Every file whose links matter: live pages, drafts, menus and the site
// settings. Each file is sanitisePath'd under its agent-configured root.
export function linkSources(config: SiteConfig): LinkSource[] {
  const sources: LinkSource[] = [];
  const add = (kind: LinkSourceKind, root: string, relativeTo: string, prefix: string) => {
    if (!existsSync(root)) {
      return;
    }
    for (const relative of listFilesRecursively(root, relativeTo, '.json')) {
      sources.push({ kind, path: `${prefix}${relative}`, file: sanitisePath(relativeTo, relative) });
    }
  };
  add('page', config.pagesRoot, config.contentRoot, '');
  add('draft', config.draftsRoot, config.draftsRoot, 'drafts/');
  add('menu', config.menusRoot, config.contentRoot, '');
  const settings = siteSettingsPath(config);
  if (existsSync(settings)) {
    sources.push({ kind: 'settings', path: 'settings.json', file: settings });
  }
  return sources;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as unknown;
  } catch {
    return undefined;
  }
}

export interface LinkReference {
  kind: LinkSourceKind;
  path: string;
  // What an editor calls it: a page's title (or name), a menu's name.
  label: string;
  // The page's own URL, for a page or a draft of one.
  url?: string;
  // How it's written there, e.g. "/about#team".
  hrefs: string[];
}

function labelOf(source: LinkSource, content: unknown): string {
  if (source.kind === 'settings') {
    return 'Site settings';
  }
  const { title, name } = (content ?? {}) as { title?: unknown; name?: unknown };
  if (typeof title === 'string' && title.trim() !== '') {
    return title;
  }
  if (typeof name === 'string' && name.trim() !== '') {
    return name;
  }
  return source.path;
}

function pageUrlOf(source: LinkSource): string | undefined {
  const relative = source.kind === 'page' ? source.path : source.kind === 'draft' ? source.path.slice('drafts/'.length) : null;
  return relative !== null && relative.startsWith('pages/') ? pagePathToUrl(relative.slice('pages/'.length)) : undefined;
}

// Everything that links to one page (exactly that page, not ones under
// it): what the admin lists before a delete. A page's own links to
// itself don't count.
export function findReferences(config: SiteConfig, to: string): LinkReference[] {
  const target = linkTarget(to);
  if (target === null) {
    return [];
  }
  const references: LinkReference[] = [];
  for (const source of linkSources(config)) {
    const url = pageUrlOf(source);
    if (url === target) {
      continue;
    }
    const content = readJson(source.file);
    const hrefs = collectLinks(content).filter((href) => linkTarget(href) === target);
    if (hrefs.length > 0) {
      references.push({ kind: source.kind, path: source.path, label: labelOf(source, content), ...(url ? { url } : {}), hrefs });
    }
  }
  return references;
}
