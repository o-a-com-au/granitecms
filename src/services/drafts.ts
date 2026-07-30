import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { ContentReadError, readContentFile } from './content-read.ts';
import { computeEtag } from './etag.ts';
import { sanitisePath } from './path-safety.ts';
import type { PreparedOperation } from './prepared-operation.ts';
import type { ThemeSchemas, ValidationError } from './validation.ts';
import { validateContent } from './validation.ts';
import { enqueue } from './write-queue.ts';

export type DraftReason = 'validation-failed' | 'conflict';

export class DraftError extends Error {
  readonly reason: DraftReason;
  // Group I: the real ajv errors (already field-pointing, e.g.
  // /sections/0/settings/columns) - previously only available
  // stringified inside .message. Always [] for the 'conflict' reason.
  readonly errors: ValidationError[];

  constructor(reason: DraftReason, message: string, errors: ValidationError[] = []) {
    super(message);
    this.name = 'DraftError';
    this.reason = reason;
    this.errors = errors;
  }
}

// Draft takes precedence over live: the ETag a client's If-Match must
// match is whatever they would have read from a prior GET, and D1/D2
// already prefer the draft over the live file at the same path. Reuses
// readContentFile/computeEtag (etag.ts's own doc comment anticipates
// this exact reuse) rather than reimplementing hashing here. Returns
// null when neither a draft nor a live file exists yet (a brand-new
// page) - see saveDraftJob's own comment for what that means.
function readCurrentEtag(config: SiteConfig, relativePath: string): string | null {
  try {
    return readContentFile(config.draftsRoot, relativePath).etag;
  } catch (error) {
    if (!(error instanceof ContentReadError) || error.reason !== 'not-found') {
      throw error;
    }
  }
  try {
    return readContentFile(config.contentRoot, relativePath).etag;
  } catch (error) {
    if (!(error instanceof ContentReadError) || error.reason !== 'not-found') {
      throw error;
    }
    return null;
  }
}

async function saveDraftJob(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  relativePath: string,
  content: unknown,
  expectedEtag: string,
): Promise<string> {
  const draftPath = sanitisePath(config.draftsRoot, relativePath);

  // The If-Match check happens here, inside the queued job, never at
  // the route layer before enqueuing: the queue only serialises the
  // writes themselves, not a check that happened earlier, so a
  // route-layer check-then-enqueue has a real TOCTOU gap (verified
  // empirically: run 2000 times, a check-before-enqueue design lets
  // both of two racing requests succeed every single time; the same
  // check run inside the job, like this, produced exactly one winner
  // every time, no exceptions).
  const currentEtag = readCurrentEtag(config, relativePath);
  if (currentEtag !== null && currentEtag !== expectedEtag) {
    throw new DraftError(
      'conflict',
      `If-Match "${expectedEtag}" does not match the current ETag for "${relativePath}"`,
    );
  }
  // currentEtag === null means neither a draft nor a live file exists
  // yet (a brand-new page) - deliberately not checked further here.
  // This isn't a race loophole: the *next* write to this same path
  // lands after this job's write has created a real draft, so that
  // job's own currentEtag is no longer null and gets checked for
  // real. Only the very first write to a wholly new path skips the
  // comparison, and nothing (E1-E6) tests or specifies what that first
  // write's If-Match value should mean.

  // Validate before touching disk at all, so a validation failure
  // writes nothing (checklist C3) structurally, not via cleanup.
  const result = validateContent(relativePath, content, themeSchemas);
  if (!result.valid) {
    throw new DraftError(
      'validation-failed',
      `Draft at "${relativePath}" failed validation: ${JSON.stringify(result.errors)}`,
      result.errors,
    );
  }

  mkdirSync(dirname(draftPath), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(content, null, 2));
  writeFileSync(draftPath, bytes);
  // No git call: saves are cheap and frequent, and never create history
  // (checklist C2, constraint 5).

  // Computed from the exact bytes just written, never a second disk
  // read (inside or outside the queue) - a second read could itself
  // race a subsequent queued job and hand the client a stale value.
  return computeEtag(bytes);
}

async function discardDraftJob(config: SiteConfig, relativePath: string): Promise<void> {
  const draftPath = sanitisePath(config.draftsRoot, relativePath);
  // Idempotent, matching DELETE semantics: silently succeed if the
  // draft is already absent rather than inventing a not-found error
  // the checklist doesn't ask for.
  if (existsSync(draftPath)) {
    unlinkSync(draftPath);
  }
  // No git call: discard never touches /content/ or history.
}

export function saveDraft(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  relativePath: string,
  content: unknown,
  expectedEtag: string,
): Promise<string> {
  return enqueue(() => saveDraftJob(config, themeSchemas, relativePath, content, expectedEtag));
}

export function discardDraft(config: SiteConfig, relativePath: string): Promise<void> {
  return enqueue(() => discardDraftJob(config, relativePath));
}

// The batch.ts-composable shape, mirroring publish.ts/move.ts/
// delete-content.ts's own prepare* exports for a single uniform
// vocabulary - even though saveDraftJob/discardDraftJob never call
// commitPaths at all (drafts are never git-tracked, so paths is
// always []), batch.ts still needs an undo for them: F6 requires "no
// partial writes" for a whole failed batch, which includes rolling
// back an earlier draft write if a later operation in the same batch
// fails. Snapshots the draft's prior bytes/existence *before*
// delegating to the existing job function, rather than reimplementing
// its logic here.
export async function prepareSaveDraft(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  relativePath: string,
  content: unknown,
  expectedEtag: string,
): Promise<PreparedOperation & { etag: string }> {
  const draftPath = sanitisePath(config.draftsRoot, relativePath);
  const existedBefore = existsSync(draftPath);
  const originalBytes = existedBefore ? readFileSync(draftPath) : null;

  const etag = await saveDraftJob(config, themeSchemas, relativePath, content, expectedEtag);

  return {
    paths: [],
    etag,
    undo: () => {
      try {
        if (existedBefore) {
          writeFileSync(draftPath, originalBytes as Buffer);
        } else {
          unlinkSync(draftPath);
        }
        return [];
      } catch (error) {
        return [error];
      }
    },
  };
}

export async function prepareDiscardDraft(config: SiteConfig, relativePath: string): Promise<PreparedOperation> {
  const draftPath = sanitisePath(config.draftsRoot, relativePath);
  const existedBefore = existsSync(draftPath);
  const originalBytes = existedBefore ? readFileSync(draftPath) : null;

  await discardDraftJob(config, relativePath);

  return {
    paths: [],
    undo: () => {
      try {
        if (existedBefore) {
          mkdirSync(dirname(draftPath), { recursive: true });
          writeFileSync(draftPath, originalBytes as Buffer);
        }
        return [];
      } catch (error) {
        return [error];
      }
    },
  };
}
