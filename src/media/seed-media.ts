import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { ALLOWED_UPLOAD_EXTENSIONS, buildMediaFilename } from './filename.ts';

export interface SeedMediaEntry {
  sourcePath: string;
  status: 'seeded' | 'skipped-invalid-type';
  // Present only when status === 'seeded'.
  url?: string;
  // Present only when status === 'skipped-invalid-type'.
  reason?: string;
}

export interface SeedMediaResult {
  ok: boolean;
  entries: SeedMediaEntry[];
}

// A directory argument expands to its own direct child files only -
// one level, not recursive, matching theme-schemas.ts's own flat-
// directory convention for exactly the same reason (a predictable,
// easy-to-reason-about walk, not a surprise deep scan).
function expandSourcePaths(sourcePaths: string[]): string[] {
  const files: string[] = [];
  for (const sourcePath of sourcePaths) {
    if (statSync(sourcePath).isDirectory()) {
      for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
        if (entry.isFile()) {
          files.push(join(sourcePath, entry.name));
        }
      }
    } else {
      files.push(sourcePath);
    }
  }
  return files;
}

// Seeds one or more local image files directly into a site's media/,
// computing the exact same content-addressed filename a real
// POST /v1/media upload would - see this module's own filename.ts for
// why that's safe to do offline (a pure function of a filename and the
// file's own bytes, no server/database involved). For an AI agent (or
// any offline tool) generating a site's starter content before a
// server is even running - GET /media/* just serves whatever file
// exists at the requested path, so the result is indistinguishable
// from a real upload.
//
// siteRoot is an operator/agent-supplied directory, the same category
// as scaffoldSite/mintToken - not a web request's own :path, so
// sanitisePath's traversal concern doesn't apply here (see
// mint-token.ts's own comment on this exact point).
//
// Never a git commit - media is never git-tracked (constraint 2,
// matching manage-media.ts's own "no commit, no author... Media is
// never git-tracked" comment).
//
// A disallowed file type is skipped, not a reason to abort the whole
// batch - an agent seeding a dozen images should still get the eleven
// good ones, with the one bad one clearly reported. The allowlist
// itself is the one thing that must not be relaxed here: it's the
// same rule the real upload route enforces (ALLOWED_UPLOAD_EXTENSIONS,
// shared, not a second copy), because skipping it would reopen the
// real stored-XSS path SVG rejection exists to close, for whoever
// later visits the live site - not a concern about this tool's own
// caller, who already has full local trust.
export function seedMedia(siteRoot: string, sourcePaths: string[]): SeedMediaResult {
  const mediaRoot = join(siteRoot, 'media');
  mkdirSync(mediaRoot, { recursive: true });

  const entries: SeedMediaEntry[] = [];
  for (const sourcePath of expandSourcePaths(sourcePaths)) {
    const extension = extname(sourcePath).toLowerCase();
    if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
      entries.push({
        sourcePath,
        status: 'skipped-invalid-type',
        reason: `"${extension}" is not an accepted image type`,
      });
      continue;
    }

    const bytes = readFileSync(sourcePath);
    const name = buildMediaFilename(basename(sourcePath), bytes);
    // No existence check first: content-addressed naming means
    // re-seeding the same bytes writes identical bytes over identical
    // bytes - a harmless idempotent overwrite, matching
    // local-fs-driver.ts's own put() precedent exactly.
    writeFileSync(join(mediaRoot, name), bytes);
    entries.push({ sourcePath, status: 'seeded', url: `/media/${name}` });
  }

  return { ok: entries.every((entry) => entry.status === 'seeded'), entries };
}
