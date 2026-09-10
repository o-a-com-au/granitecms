import { existsSync } from 'node:fs';
import { bootSite } from '../boot.ts';
import { renderPage } from '../renderer/render-page.ts';
import { PathSafetyError, sanitisePath } from '../services/path-safety.ts';
import { buildSitemapUrls } from '../routes/sitemap.ts';
import { urlToPagePath } from '../services/urls.ts';

export type CheckFindingKind = 'schema' | 'render-error' | 'missing-asset' | 'broken-link';

export interface CheckFinding {
  kind: CheckFindingKind;
  message: string;
  // The published page a render-error/missing-asset/broken-link finding
  // came from - absent for a schema finding, which is a theme-wide
  // problem, not tied to any one page.
  pageUrl?: string;
}

export interface CheckResult {
  ok: boolean;
  findings: CheckFinding[];
}

// A reference this project's own theme conventions actually produce:
// src="...", srcset="w1 480w, w2 960w" (comma-separated, each entry a
// url then a space then a width descriptor - strip the descriptor),
// href="...". Not a full HTML parser - matching SchemaField.tsx's own
// "the schema surface here is narrow and flat... a library would be
// heavier than the problem warrants" precedent for the equivalent
// choice on the admin side.
const ATTR_PATTERN = /\b(?:src|href)="([^"]*)"|\bsrcset="([^"]*)"/g;

function extractReferences(html: string): string[] {
  const refs: string[] = [];
  for (const match of html.matchAll(ATTR_PATTERN)) {
    const [, single, srcset] = match;
    if (single !== undefined) {
      refs.push(single);
    } else if (srcset !== undefined) {
      for (const entry of srcset.split(',')) {
        const url = entry.trim().split(/\s+/)[0];
        if (url) {
          refs.push(url);
        }
      }
    }
  }
  return refs;
}

// True for a root-relative static path that looks like a real file
// (has a "." in its last path segment - /favicon.ico, /robots.txt),
// as opposed to a page URL like /about or /blog/hello-world, which
// never do. Doesn't need to be perfect - a page URL with a literal dot
// in its own slug is vanishingly unlikely and, worst case, just gets
// checked against the wrong bucket and reported as the wrong kind of
// finding, never silently skipped.
function looksLikeStaticFile(path: string): boolean {
  const lastSegment = path.split('/').pop() ?? '';
  return lastSegment.includes('.');
}

// A rendered reference is theme/content-derived, not a live HTTP
// request's own :path - but the same traversal concern still applies
// (constraint 7), so it still goes through sanitisePath rather than a
// bare join+existsSync. A reference that fails to sanitise (a "../"
// escaping root) is exactly as real a finding as one that's simply
// missing - reported the same way, not silently skipped.
function checkStaticReference(
  findings: CheckFinding[],
  root: string,
  relativePath: string,
  originalPath: string,
  rootLabel: string,
  pageUrl: string,
): void {
  try {
    const filePath = sanitisePath(root, relativePath);
    if (!existsSync(filePath)) {
      findings.push({ kind: 'missing-asset', message: `${originalPath} does not exist under ${rootLabel}`, pageUrl });
    }
  } catch (error) {
    if (error instanceof PathSafetyError) {
      findings.push({ kind: 'missing-asset', message: `${originalPath} is not a safe reference under ${rootLabel} (${error.message})`, pageUrl });
      return;
    }
    throw error;
  }
}

export async function runSiteCheck(siteRoot: string): Promise<CheckResult> {
  const booted = bootSite(siteRoot);
  const findings: CheckFinding[] = [];

  for (const warning of booted.themeSchemas.warnings ?? []) {
    findings.push({ kind: 'schema', message: warning });
  }

  const publishedUrls = buildSitemapUrls(booted.config);
  const publishedUrlSet = new Set(publishedUrls);

  for (const pageUrl of publishedUrls) {
    // urlToPagePath's own result is relative to pagesRoot (e.g.
    // "about.json"), but renderPage's own relativePath is relative to
    // contentRoot - the same "pages/" prefix routes/public.ts's own
    // toRenderPath helper adds before every one of its renderPage
    // calls.
    const relativePath = `pages/${urlToPagePath(pageUrl)}`;
    let html: string;
    try {
      html = await renderPage(booted.config, booted.themeTemplates, booted.layouts, booted.engine, relativePath, 'public');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      findings.push({ kind: 'render-error', message: detail, pageUrl });
      continue;
    }

    for (const ref of extractReferences(html)) {
      if (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('data:') || ref.startsWith('//')) {
        continue;
      }
      const path = ref.split(/[?#]/)[0] ?? ref;
      if (path.startsWith('/media/')) {
        checkStaticReference(findings, booted.config.mediaRoot, path.slice('/media/'.length), path, 'media/', pageUrl);
      } else if (path.startsWith('/assets/')) {
        checkStaticReference(findings, booted.config.assetsRoot, path.slice('/assets/'.length), path, 'theme/assets/', pageUrl);
      } else if (looksLikeStaticFile(path)) {
        checkStaticReference(findings, booted.config.rootMirrorRoot, path.slice(1), path, 'theme/root/', pageUrl);
      } else if (path !== '' && !publishedUrlSet.has(path)) {
        findings.push({ kind: 'broken-link', message: `${path} does not point at a published page`, pageUrl });
      }
    }
  }

  return { ok: findings.length === 0, findings };
}
