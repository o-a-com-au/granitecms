import { existsSync } from 'node:fs';
import { bootSite } from '../boot.ts';
import { renderPage } from '../renderer/render-page.ts';
import { PathSafetyError, sanitisePath } from '../services/path-safety.ts';
import { buildSitemapUrls } from '../routes/sitemap.ts';
import { urlToPagePath } from '../services/urls.ts';
import { ALLOWED_UPLOAD_EXTENSIONS } from '../media/filename.ts';

export type CheckFindingKind = 'schema' | 'render-error' | 'missing-asset' | 'broken-link' | 'misplaced-media';

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
// poster is included deliberately: a video's poster is a real content
// image and was not being checked at all before.
const ATTR_PATTERN = /\b(src|href|poster|srcset)="([^"]*)"/g;

interface Reference {
  url: string;
  attribute: string;
}

function extractReferences(html: string): Reference[] {
  const refs: Reference[] = [];
  for (const match of html.matchAll(ATTR_PATTERN)) {
    const attribute = match[1] ?? '';
    const value = match[2] ?? '';
    if (attribute !== 'srcset') {
      refs.push({ url: value, attribute });
    } else {
      for (const entry of value.split(',')) {
        const url = entry.trim().split(/\s+/)[0];
        if (url) {
          refs.push({ url, attribute });
        }
      }
    }
  }
  return refs;
}

// Any scheme at all that is not http(s). The previous version listed
// data: explicitly and nothing else, so mailto: (and tel:, and anything
// future) fell through to the static-file branch below and was reported
// as a missing file under theme/root/, purely because the text after
// the "@" contains a dot. One real site produced 39 such findings and
// not one true one, which is worse than no check: it teaches whoever
// reads the output to ignore it.
function hasExternalScheme(ref: string): boolean {
  return ref.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(ref);
}

// A content photograph or clip, as opposed to a design asset. Keyed off
// the same extension list the media upload route accepts, so the two
// cannot drift; .svg is absent from it, which is what keeps an inline
// logo or icon from being mistaken for misplaced content.
function isUploadableMedia(path: string): boolean {
  const lower = path.toLowerCase();
  return [...ALLOWED_UPLOAD_EXTENSIONS].some((extension) => lower.endsWith(extension));
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
  // sanitisePath realpaths its root unconditionally, so a site that has
  // no media/, theme/assets/ or theme/root/ directory at all threw a
  // raw ENOENT out of the whole check rather than reporting anything -
  // the check crashing with a stack trace on exactly the sites most
  // likely to hold a broken reference. A root that does not exist means
  // the file underneath it does not exist either, which is an ordinary
  // finding, not an error.
  if (!existsSync(root)) {
    findings.push({ kind: 'missing-asset', message: `${originalPath} does not exist under ${rootLabel}`, pageUrl });
    return;
  }

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

// The file exists, so nothing else would ever flag it - which is
// precisely why this needs saying. A content image outside media/ is
// invisible to the media library, cannot be replaced by an editor, and
// is not what the CMS manages.
function misplacedMessage(path: string, where: string): string {
  return `${path} is a content image served from ${where} - it belongs in media/ (run \`npm run seed-media -- .. <file>\` from vhost/ and use the /media/... URL it prints)`;
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

    for (const { url: ref, attribute } of extractReferences(html)) {
      if (hasExternalScheme(ref)) {
        continue;
      }
      const path = ref.split(/[?#]/)[0] ?? ref;
      // Only src/srcset/poster can carry a content image. An href is a
      // link or a favicon, and flagging those would make this useless.
      const rendersMedia = attribute !== 'href' && isUploadableMedia(path);
      if (path.startsWith('/media/')) {
        checkStaticReference(findings, booted.config.mediaRoot, path.slice('/media/'.length), path, 'media/', pageUrl);
      } else if (path.startsWith('/assets/')) {
        if (rendersMedia) {
          findings.push({ kind: 'misplaced-media', message: misplacedMessage(path, 'theme/assets/'), pageUrl });
        }
        checkStaticReference(findings, booted.config.assetsRoot, path.slice('/assets/'.length), path, 'theme/assets/', pageUrl);
      } else if (looksLikeStaticFile(path)) {
        if (rendersMedia) {
          findings.push({ kind: 'misplaced-media', message: misplacedMessage(path, 'theme/root/'), pageUrl });
        }
        checkStaticReference(findings, booted.config.rootMirrorRoot, path.slice(1), path, 'theme/root/', pageUrl);
      } else if (path !== '' && !publishedUrlSet.has(path)) {
        findings.push({ kind: 'broken-link', message: `${path} does not point at a published page`, pageUrl });
      }
    }
  }

  return { ok: findings.length === 0, findings };
}
